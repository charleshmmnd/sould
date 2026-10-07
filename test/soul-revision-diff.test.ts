/**
 * The soul revision ledger records what each revision removed and added.
 *
 * Why: until 2026-10-07 a revision entry said only "Updated earned_values".
 * The two values engraved at the 2026-08-23 evolution were replaced by later
 * evolutions and nothing in the document recorded what they had been.
 */
import { describe, it, expect, vi } from "vitest";
import { diffSoulSection, reviseSoulGuarded, SOUL_DIFF_MAX_ENTRIES } from "../src/engine/soul.js";

describe("diffSoulSection", () => {
  it("reports removed and added entries by text, for strings and objects", () => {
    const before = [{ value: "Refuse the guarantee", grounded_in: "a" }, { value: "Retract the false alarm", grounded_in: "b" }];
    const after = [{ value: "Refuse the guarantee", grounded_in: "a" }, { value: "Done means live", grounded_in: "c" }];
    const d = diffSoulSection(before, after);
    expect(d.removed).toEqual(["Retract the false alarm"]);
    expect(d.added).toEqual(["Done means live"]);
  });

  it("treats a missing snapshot as all-added and caps the lists", () => {
    const after = Array.from({ length: SOUL_DIFF_MAX_ENTRIES + 5 }, (_, i) => `entry ${i}`);
    const d = diffSoulSection(undefined, after);
    expect(d.removed).toEqual([]);
    expect(d.added).toHaveLength(SOUL_DIFF_MAX_ENTRIES);
  });
});

describe("reviseSoulGuarded ledger", () => {
  it("writes removed and added into each revision entry and summarizes the change", async () => {
    const calls: { sql: string; bindings: Record<string, unknown> }[] = [];
    const store = {
      isAvailable: () => true,
      queryFirst: vi.fn(async (sql: string, bindings: Record<string, unknown>) => { calls.push({ sql, bindings }); return [{ id: "soul:laqrumbrain" }]; }),
      queryExec: vi.fn(async () => {}),
    } as any;
    const snapshot = ["Old lesson one", "Kept lesson"];
    const value = ["Kept lesson", "New lesson two"];
    const outcome = await reviseSoulGuarded([{ section: "working_style", value, snapshot }], "test", store);
    expect(outcome).toBe("applied");
    const revs = calls[0].bindings.revs as any[];
    expect(revs).toHaveLength(1);
    expect(revs[0].section).toBe("working_style");
    expect(revs[0].removed).toEqual(["Old lesson one"]);
    expect(revs[0].added).toEqual(["New lesson two"]);
    expect(revs[0].change).toBe("Updated working_style: 1 removed, 1 added");
  });

  it("keeps the plain change text when no snapshot was supplied", async () => {
    const calls: { bindings: Record<string, unknown> }[] = [];
    const store = {
      isAvailable: () => true,
      queryFirst: vi.fn(async (_sql: string, bindings: Record<string, unknown>) => { calls.push({ bindings }); return [{ id: "soul:laqrumbrain" }]; }),
      queryExec: vi.fn(async () => {}),
    } as any;
    await reviseSoulGuarded([{ section: "self_observations", value: ["fresh"] }], "test", store);
    const revs = calls[0].bindings.revs as any[];
    expect(revs[0].change).toBe("Updated self_observations");
    expect(revs[0].added).toEqual(["fresh"]);
    expect(revs[0].removed).toEqual([]);
  });
});
