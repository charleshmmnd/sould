/**
 * Inline budget for hook-injected context (0.10.1).
 *
 * Regression context: on a mature graph every UserPromptSubmit payload
 * (~30 K chars, two thirds of it 44 tier-0 directives re-sent every prompt)
 * exceeded Claude Code's inline threshold and was persisted to a file with a
 * 2 KB preview, so the model saw neither the rules nor the recalled memory.
 */
import { describe, it, expect } from "vitest";
import {
  DEFAULT_HOOK_INLINE_MAX_CHARS,
  MIN_HOOK_INLINE_MAX_CHARS,
  resolveHookInlineMaxChars,
  tier0FullBudgetChars,
  digestLine,
  planTier0Delivery,
  enforceInlineCeiling,
} from "../src/engine/inline-budget.js";
import type { CoreMemoryEntry } from "../src/engine/surreal.js";

function entry(id: string, priority: number, text: string): CoreMemoryEntry {
  return { id, text, category: "rules", priority, tier: 0, active: true };
}
function rule(i: number, chars: number): CoreMemoryEntry {
  const head = `RULE ${i} NEVER do the thing number ${i}.`;
  return entry(`core_memory:r${i}`, 100 - i, head + " " + "detail ".repeat(Math.max(0, Math.ceil((chars - head.length) / 7))));
}

describe("resolveHookInlineMaxChars", () => {
  it("defaults just under the client's 8,000-char additionalContext cap", () => {
    expect(resolveHookInlineMaxChars({})).toBe(DEFAULT_HOOK_INLINE_MAX_CHARS);
    expect(DEFAULT_HOOK_INLINE_MAX_CHARS).toBeLessThan(8_000);
    expect(DEFAULT_HOOK_INLINE_MAX_CHARS).toBeGreaterThan(6_000);
  });
  it("honours a sane override and ignores junk or dangerously small values", () => {
    expect(resolveHookInlineMaxChars({ SOULD_HOOK_MAX_CHARS: "24000" })).toBe(24_000);
    expect(resolveHookInlineMaxChars({ SOULD_HOOK_MAX_CHARS: "banana" })).toBe(DEFAULT_HOOK_INLINE_MAX_CHARS);
    expect(resolveHookInlineMaxChars({ SOULD_HOOK_MAX_CHARS: "100" })).toBe(DEFAULT_HOOK_INLINE_MAX_CHARS);
    expect(resolveHookInlineMaxChars({ SOULD_HOOK_MAX_CHARS: String(MIN_HOOK_INLINE_MAX_CHARS) })).toBe(MIN_HOOK_INLINE_MAX_CHARS);
  });
  it("full-text directive budget leaves room for retrieval", () => {
    const b = tier0FullBudgetChars(DEFAULT_HOOK_INLINE_MAX_CHARS);
    expect(b).toBeGreaterThan(3_000);
    expect(b).toBeLessThan(5_000);
  });
});

describe("digestLine", () => {
  it("keeps the first sentence on one line", () => {
    expect(digestLine("NEVER CLAIM DONE WITHOUT VERIFYING the live page. Second sentence here.\nThird.")).toBe("NEVER CLAIM DONE WITHOUT VERIFYING the live page.");
  });
  it("adds sentences while the first one is only a label", () => {
    expect(digestLine("NO SPOT-CHECKING. When verifying data, count ALL entries. Never sample.")).toBe("NO SPOT-CHECKING. When verifying data, count ALL entries.");
    expect(digestLine("Do it. Then verify the deploy on the live domain.")).toBe("Do it. Then verify the deploy on the live domain.");
  });
  it("caps long lines with an ellipsis", () => {
    const d = digestLine("x".repeat(500), 80);
    expect(d.length).toBe(80);
    expect(d.endsWith("...")).toBe(true);
  });
});

describe("planTier0Delivery rolls full text across prompts", () => {
  const rules = Array.from({ length: 44 }, (_, i) => rule(i + 1, 550));
  it("delivers every directive in full exactly once, then digests all of them", () => {
    const delivered = new Set<string>();
    const budget = tier0FullBudgetChars(DEFAULT_HOOK_INLINE_MAX_CHARS);
    const seenFull = new Set<string>();
    let prompts = 0;
    for (; prompts < 20; prompts++) {
      const plan = planTier0Delivery(rules, delivered, budget);
      expect(plan.usedChars).toBeLessThanOrEqual(budget);
      for (const e of plan.full) {
        expect(seenFull.has(e.id)).toBe(false);
        seenFull.add(e.id);
      }
      // Every directive appears somewhere on every prompt.
      expect(plan.full.length + plan.digest.length + plan.deferred.length).toBe(44);
      if (plan.full.length === 0) break;
    }
    expect(seenFull.size).toBe(44);
    expect(prompts).toBeGreaterThanOrEqual(2); // 44 x 550 chars cannot fit one prompt
    expect(prompts).toBeLessThanOrEqual(10);
    const steady = planTier0Delivery(rules, delivered, budget);
    expect(steady.full).toHaveLength(0);
    expect(steady.digest).toHaveLength(44);
    expect(steady.deferred).toHaveLength(0);
  });
  it("delivers highest priority first and defers the tail", () => {
    const delivered = new Set<string>();
    const plan = planTier0Delivery(rules, delivered, 3_000);
    expect(plan.full[0].id).toBe("core_memory:r1");
    expect(plan.full.length).toBeGreaterThan(0);
    expect(plan.deferred.length).toBe(44 - plan.full.length);
    expect(plan.digest).toHaveLength(0);
  });
  it("never leaves a prompt without its top directive, even on a tiny budget", () => {
    const plan = planTier0Delivery([rule(1, 2_000)], new Set(), 10);
    expect(plan.full).toHaveLength(1);
  });
  it("a cleared delivered set restarts the cycle (post-compaction)", () => {
    const delivered = new Set<string>();
    planTier0Delivery(rules, delivered, 1_000_000);
    expect(delivered.size).toBe(44);
    delivered.clear();
    const again = planTier0Delivery(rules, delivered, 1_000_000);
    expect(again.full).toHaveLength(44);
  });
  it("caps a single oversized directive instead of letting it eat the batch", () => {
    const plan = planTier0Delivery([rule(1, 9_000), rule(2, 300)], new Set(), 6_000);
    expect(plan.full[0].text.length).toBeLessThanOrEqual(4_000);
    expect(plan.full[0].text.endsWith("...")).toBe(true);
    expect(plan.full).toHaveLength(2);
  });
});

describe("enforceInlineCeiling", () => {
  const body = "<recalled_memory>\n" + Array.from({ length: 400 }, (_, i) => `[#${i}] item ${i} ${"m".repeat(60)}`).join("\n") + "\n</recalled_memory>";
  it("returns the input untouched when it fits", () => {
    const r = enforceInlineCeiling("short", 100);
    expect(r.text).toBe("short");
    expect(r.trimmed).toBe(0);
  });
  it("cuts at a line boundary, closes the open tag and names the loss", () => {
    const r = enforceInlineCeiling(body, 5_000);
    expect(r.text.length).toBeLessThanOrEqual(5_000);
    expect(r.trimmed).toBeGreaterThan(0);
    expect(r.text).toContain("</recalled_memory>");
    expect(r.text).toMatch(/\[sould\] \d+ chars trimmed/);
    const lines = r.text.split(/\r?\n/);
    // The last content line before the closer is a whole item, not a severed one.
    const lastItem = lines.filter(l => l.startsWith("[#")).pop()!;
    expect(lastItem.endsWith("m".repeat(60))).toBe(true);
  });
  it("does not add a closer for a tag that was already closed", () => {
    const r = enforceInlineCeiling("<soul>\nx\n</soul>\n" + "y\n".repeat(3_000), 500);
    expect((r.text.match(/<\/soul>/g) ?? []).length).toBe(1);
  });
});
