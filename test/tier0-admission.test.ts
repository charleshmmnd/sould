/**
 * Tier-0 admission under the rolling delivery model (0.10.5).
 *
 * Regression context: on 2026-10-15 the core_memory tool refused a short,
 * high-priority rule because 35 active entries already summed past the old
 * single-prompt render budget (about 22 K chars of model context). Since 0.10.1
 * the hook path delivers directives in full once per session, in priority
 * order, in batches bounded by the harness inline ceiling (`planTier0Delivery`),
 * so nothing is evicted and that budget was no longer what the renderer
 * enforced. Admission now measures what the delivery path measures: the
 * length of the full cycle in prompts, and whether the entry itself fits the
 * per-item cap. The soul rows (15 K to 33 K chars each on a mature graph) are
 * windowed on delivery and must not count at their stored length.
 */
import { describe, it, expect } from "vitest";
import {
  createCoreMemoryToolDef,
  checkTier0Admission,
  tier0CyclePrompts,
  tier0DeliveryChars,
  MAX_TIER0_CYCLE_PROMPTS,
} from "../src/engine/tools/core-memory.js";
import {
  resolveHookInlineMaxChars,
  tier0FullBudgetChars,
  TIER0_FULL_ITEM_CAP,
  TIER0_SOUL_WINDOW_CHARS,
} from "../src/engine/inline-budget.js";
import { GlobalPluginState, SessionState } from "../src/engine/state.js";
import type { CoreMemoryEntry } from "../src/engine/surreal.js";

const BUDGET = tier0FullBudgetChars(resolveHookInlineMaxChars());

function entry(id: string, priority: number, chars: number, tier = 0, category = "rules"): CoreMemoryEntry {
  return { id, text: "x".repeat(chars), category, priority, tier, active: true };
}

/** The live shape that was refused: 32 rules of 300 to 2,100 chars plus three
 *  soul sections, well past the old render budget. */
function liveLikeSet(): CoreMemoryEntry[] {
  const rows: CoreMemoryEntry[] = [];
  for (let i = 0; i < 32; i++) rows.push(entry(`core_memory:rule${i}`, 100 - i, 300 + (i * 57) % 1800));
  rows.push(entry("core_memory:soul1", 90, 33_535, 0, "soul"));
  rows.push(entry("core_memory:soul2", 88, 19_040, 0, "soul"));
  rows.push(entry("core_memory:soul3", 85, 28_509, 0, "soul"));
  return rows;
}

/** Enough 700-char rules to push the cycle past the limit. */
function overlongCycleSet(): CoreMemoryEntry[] {
  const rows: CoreMemoryEntry[] = [];
  const perPrompt = Math.floor(BUDGET / 706);
  for (let i = 0; i < perPrompt * (MAX_TIER0_CYCLE_PROMPTS + 1); i++) rows.push(entry(`core_memory:many${i}`, 60, 700));
  return rows;
}

function makeTool(rows: CoreMemoryEntry[], onUpdate?: (f: Record<string, unknown>) => void) {
  const session = new SessionState("s", "s");
  const store = {
    isAvailable: () => true,
    getAllCoreMemory: async (tier?: number) =>
      tier == null ? rows : rows.filter((r) => r.tier === tier),
    createCoreMemory: async () => "core_memory:new",
    updateCoreMemory: async (_id: string, fields: Record<string, unknown>) => {
      onUpdate?.(fields);
      return true;
    },
    deleteCoreMemory: async () => {},
  };
  const state = {
    store,
    embeddings: { isAvailable: () => false },
    config: {},
    onSessionRemoved: () => {},
  } as unknown as GlobalPluginState;
  (state as unknown as { getSession: () => SessionState }).getSession = () => session;
  return createCoreMemoryToolDef(state, session);
}

const textOf = (r: { content: { text: string }[] }) => r.content[0].text;

describe("tier0DeliveryChars counts what delivery sends", () => {
  it("a soul row costs its window, not its stored length", () => {
    expect(tier0DeliveryChars(entry("s", 90, 33_535, 0, "soul"))).toBe(TIER0_SOUL_WINDOW_CHARS + 6);
  });
  it("a rule is capped at the per-item cap", () => {
    expect(tier0DeliveryChars(entry("r", 90, 50_000))).toBe(TIER0_FULL_ITEM_CAP + 6);
    expect(tier0DeliveryChars(entry("r", 90, 300))).toBe(306);
  });
});

describe("tier0CyclePrompts follows planTier0Delivery", () => {
  it("one prompt when everything fits", () => {
    expect(tier0CyclePrompts([entry("a", 90, 100), entry("b", 80, 100)], BUDGET)).toBe(1);
  });
  it("grows with the total, highest priority first", () => {
    const rows = [];
    for (let i = 0; i < 10; i++) rows.push(entry(`r${i}`, 90, Math.floor(BUDGET / 2)));
    // Each prompt carries one entry plus a bit; ten entries is at least five prompts.
    expect(tier0CyclePrompts(rows, BUDGET)).toBeGreaterThanOrEqual(5);
  });
  it("zero for an empty tier", () => {
    expect(tier0CyclePrompts([], BUDGET)).toBe(0);
  });
});

describe("checkTier0Admission under rolling delivery", () => {
  it("admits a short rule into the live-like set that the render budget refused", () => {
    const v = checkTier0Admission(liveLikeSet(), entry("(pending admission)", 97, 320));
    expect(v.ok).toBe(true);
    expect(v.cyclePrompts).toBeLessThanOrEqual(MAX_TIER0_CYCLE_PROMPTS);
    expect(v.entries).toBe(36);
  });

  it("counts soul rows at their window, so three 20 K sections do not close the tier", () => {
    const rows = liveLikeSet();
    const v = checkTier0Admission(rows, entry("(pending admission)", 50, 300));
    const stored = rows.reduce((n, e) => n + e.text.length, 0);
    expect(stored).toBeGreaterThan(100_000);
    expect(v.cycleChars).toBe([...rows, entry("(pending admission)", 50, 300)].reduce((n, e) => n + tier0DeliveryChars(e), 0));
    expect(v.cycleChars).toBeLessThan(stored / 2);
  });

  it("refuses an entry longer than the per-item cap, naming the cap", () => {
    const v = checkTier0Admission([], entry("(pending admission)", 99, TIER0_FULL_ITEM_CAP + 1));
    expect(v.ok).toBe(false);
    expect(v.reason).toBe("too_long");
  });

  it("does not apply the per-item cap to a soul row", () => {
    const v = checkTier0Admission([], entry("(pending admission)", 90, 30_000, 0, "soul"));
    expect(v.ok).toBe(true);
  });

  it("refuses when the full cycle would pass the prompt limit", () => {
    const v = checkTier0Admission(overlongCycleSet(), entry("(pending admission)", 99, 700));
    expect(v.ok).toBe(false);
    expect(v.reason).toBe("cycle_too_long");
    expect(v.cyclePrompts).toBeGreaterThan(MAX_TIER0_CYCLE_PROMPTS);
  });

  it("on update, does not double-count the row being replaced", () => {
    // A priority no other row has, so the sort order (and so the batch
    // packing) is identical with the candidate in the old row's place.
    const existing = [...liveLikeSet(), entry("core_memory:a", 101, 2_000)];
    const same = checkTier0Admission(existing, entry("core_memory:a", 101, 2_000), "core_memory:a");
    expect(same.entries).toBe(existing.length);
    const byPriorityDesc = [...existing].sort((a, b) => (b.priority ?? 50) - (a.priority ?? 50));
    expect(same.cyclePrompts).toBe(tier0CyclePrompts(byPriorityDesc, BUDGET));
  });

  it("matches a RecordId-shaped replacingId by String()", () => {
    const rid = { toString: () => "core_memory:a" } as unknown as string;
    const existing = [{ ...entry("core_memory:a", 90, 500), id: rid }, entry("core_memory:b", 60, 500)];
    const v = checkTier0Admission(existing, entry("core_memory:a", 90, 500), "core_memory:a");
    expect(v.entries).toBe(2);
  });
});

describe("core_memory add", () => {
  it("creates the entry and reports the cycle length", async () => {
    const tool = makeTool(liveLikeSet());
    const res = await tool.execute("t", { action: "add", tier: 0, text: "short rule", priority: 99 });
    expect((res!.details as { id?: string }).id).toBe("core_memory:new");
    expect(textOf(res as never)).toMatch(/Tier 0 now 36 entries, \d+ prompts? per full delivery cycle/);
  });

  it("refuses an over-cap entry with the shorten advice", async () => {
    const tool = makeTool([]);
    const res = await tool.execute("t", { action: "add", tier: 0, text: "y".repeat(TIER0_FULL_ITEM_CAP + 10), priority: 100 });
    const d = res!.details as { error: boolean; reason: string };
    expect(d.reason).toBe("too_long");
    expect(textOf(res as never)).toContain("Shorten it");
  });

  it("refuses a cycle past the limit and says nothing is evicted", async () => {
    const tool = makeTool(overlongCycleSet());
    const res = await tool.execute("t", { action: "add", tier: 0, text: "y".repeat(700), priority: 100 });
    const d = res!.details as { error: boolean; reason: string; cyclePrompts: number };
    expect(d.reason).toBe("cycle_too_long");
    expect(d.cyclePrompts).toBeGreaterThan(MAX_TIER0_CYCLE_PROMPTS);
    expect(textOf(res as never)).toContain("not evicting anything");
  });

  it("tier 1 is not cycle-checked", async () => {
    const tool = makeTool(overlongCycleSet());
    const res = await tool.execute("t", { action: "add", tier: 1, text: "session rule", priority: 50 });
    expect((res!.details as { id?: string }).id).toBe("core_memory:new");
  });
});

describe("core_memory update", () => {
  it("lets a priority raise through, even on a row longer than the cap (it only reorders the cycle)", async () => {
    const rows = [entry("core_memory:a", 50, 5_000), ...liveLikeSet()];
    const written: Record<string, unknown>[] = [];
    const tool = makeTool(rows, (f) => written.push(f));
    const res = await tool.execute("t", { action: "update", id: "core_memory:a", priority: 100 });
    expect((res!.details as { id?: string }).id).toBe("core_memory:a");
    expect(written).toHaveLength(1);
  });

  it("refuses a rewrite past the per-item cap", async () => {
    const written: Record<string, unknown>[] = [];
    const tool = makeTool([entry("core_memory:a", 100, 200)], (f) => written.push(f));
    const res = await tool.execute("t", { action: "update", id: "core_memory:a", text: "z".repeat(50_000) });
    expect((res!.details as { reason?: string }).reason).toBe("too_long");
    expect(written).toHaveLength(0);
  });

  it("still refuses an update that moves a row INTO tier 0 when the cycle is at the limit", async () => {
    const rows = overlongCycleSet();
    rows.push(entry("core_memory:t1row", 10, 700, 1));
    const written: Record<string, unknown>[] = [];
    const tool = makeTool(rows, (f) => written.push(f));
    const res = await tool.execute("t", { action: "update", id: "core_memory:t1row", tier: 0 });
    expect((res!.details as { reason?: string }).reason).toBe("cycle_too_long");
    expect(written).toHaveLength(0);
  });

  it("allows a rewrite inside the cap and reports the cycle", async () => {
    const written: Record<string, unknown>[] = [];
    const tool = makeTool([entry("core_memory:a", 100, 200)], (f) => written.push(f));
    const res = await tool.execute("t", { action: "update", id: "core_memory:a", text: "z".repeat(1_500) });
    expect((res!.details as { id?: string }).id).toBe("core_memory:a");
    expect((written[0].text as string).length).toBe(1_500);
    expect(textOf(res as never)).toContain("per full delivery cycle");
  });

  it("does not block an update that moves a row OUT of tier 0", async () => {
    const written: Record<string, unknown>[] = [];
    const tool = makeTool([entry("core_memory:a", 100, 200)], (f) => written.push(f));
    const res = await tool.execute("t", { action: "update", id: "core_memory:a", text: "z".repeat(50_000), tier: 1 });
    expect((res!.details as { id?: string }).id).toBe("core_memory:a");
  });
});

describe("core_memory list", () => {
  it("appends the tier-0 cycle summary", async () => {
    const tool = makeTool(liveLikeSet());
    const res = await tool.execute("t", { action: "list" });
    expect(textOf(res as never)).toMatch(/Tier 0: 35 entries, \d+ prompts per full delivery cycle/);
  });
});
