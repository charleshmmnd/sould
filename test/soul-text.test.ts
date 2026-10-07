/**
 * soul-text.ts: the injector shows whole soul entries and rotates them.
 *
 * Why: a 20-entry soul section joined with "; " and cut at the per-item cap
 * delivered only its first entry to the model, every turn, for months.
 */
import { describe, it, expect } from "vitest";
import { SOUL_ENTRY_SEPARATOR, splitSoulRow, windowSoulText, soulEntryText } from "../src/engine/soul-text.js";

const entries = Array.from({ length: 6 }, (_, i) => `Entry ${i + 1} says something; with a clause inside it, number ${i + 1}.`);
const row = "Working style: " + entries.join(SOUL_ENTRY_SEPARATOR);

describe("splitSoulRow", () => {
  it("splits on the separator and keeps clauses inside an entry intact", () => {
    const { label, entries: got } = splitSoulRow(row);
    expect(label).toBe("Working style: ");
    expect(got).toHaveLength(6);
    expect(got[0]).toContain("; with a clause inside it");
  });

  it("recovers entries from a legacy '; ' row by the capital-letter heuristic", () => {
    const legacy = "Self-observations: First lesson; the clause stays. Second lesson here; Another entry";
    const { entries: got } = splitSoulRow(legacy);
    expect(got).toEqual(["First lesson; the clause stays. Second lesson here", "Another entry"]);
  });
});

describe("windowSoulText", () => {
  it("returns the row untouched when it fits", () => {
    expect(windowSoulText(row, row.length + 10, 3)).toBe(row);
  });

  it("shows whole entries with position markers and never cuts mid-entry when one fits", () => {
    const out = windowSoulText(row, 200, 0);
    expect(out.startsWith("Working style: (1/6) Entry 1")).toBe(true);
    expect(out.length).toBeLessThanOrEqual(200);
    expect(out.endsWith(".")).toBe(true);
  });

  it("rotates the starting entry with the seed and wraps around", () => {
    const a = windowSoulText(row, 200, 0);
    const b = windowSoulText(row, 200, 4);
    expect(a).not.toBe(b);
    expect(b).toContain("(5/6) Entry 5");
    const wrapped = windowSoulText(row, 170, 5);   // room for two entries: the last, then the first
    expect(wrapped).toContain("(6/6) Entry 6");
    expect(wrapped).toContain("(1/6) Entry 1");
  });

  it("walks every entry across seeds", () => {
    const seen = new Set<number>();
    for (let seed = 0; seed < 6; seed++) {
      const m = windowSoulText(row, 120, seed).match(/\((\d)\/6\)/g) ?? [];
      for (const x of m) seen.add(Number(x[1]));
    }
    expect(seen.size).toBe(6);
  });

  it("cuts a single entry that is longer than the cap, keeping its marker", () => {
    const long = "Earned values: " + "x".repeat(500) + SOUL_ENTRY_SEPARATOR + "short";
    const out = windowSoulText(long, 100, 0);
    expect(out.startsWith("Earned values: (1/2) ")).toBe(true);
    expect(out.endsWith("...")).toBe(true);
    expect(out.length).toBeLessThanOrEqual(100 + 3);
  });

  it("falls back to plain truncation for a one-entry row", () => {
    const one = "Persona: " + "y".repeat(300);
    expect(windowSoulText(one, 50, 9)).toBe(one.slice(0, 50) + "...");
  });
});

describe("soulEntryText", () => {
  it("reads strings, earned values and emotional dimensions", () => {
    expect(soulEntryText("plain")).toBe("plain");
    expect(soulEntryText({ value: "Done means live", grounded_in: "x" })).toBe("Done means live");
    expect(soulEntryText({ dimension: "Humour", description: "y" })).toBe("Humour");
  });
});
