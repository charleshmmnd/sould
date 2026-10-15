/**
 * Retrieval gaps seen live on 2026-10-15, each fixed in 0.10.5:
 *
 * 1. recall("the SEO lady") found nothing although the Kati Henken facts
 *    existed: a nickname and a formal name never shared a row. Extraction now
 *    writes ALIAS concepts, and recall expands an alias hit to the formal name.
 * 2. Reflections (session_review lessons) were injected on every prompt but
 *    not reachable through recall; the tool never queried that table.
 * 3. The morning LeadForge check skill did not surface on its own: skills were
 *    injected for code-shaped intents only, and nothing ran at session start.
 *    Skills flagged surface_at_session_start are now surfaced by flag and
 *    local hour.
 */
import { describe, it, expect } from "vitest";
import { aliasTargetsFrom, queryNamesTarget, createRecallToolDef } from "../src/engine/tools/recall.js";
import { selectDueRoutines, formatRoutineContext, type RoutineSkill } from "../src/engine/skills.js";
import { parseRoutineArgs } from "../src/tools/create-skill.js";
import { GlobalPluginState, SessionState } from "../src/engine/state.js";
import type { VectorSearchResult } from "../src/engine/surreal.js";

describe("1. alias expansion", () => {
  it("reads the formal name out of an extraction-style ALIAS concept", () => {
    expect(aliasTargetsFrom([
      'ALIAS: "the SEO lady" = Kati Henken (Integris Design). She emailed hello@picksbytown.com about Conard Construction.',
    ])).toEqual(["Kati Henken"]);
  });

  it("reads a hand-written alias memory with several nicknames", () => {
    expect(aliasTargetsFrom([
      '[FACT] Alias: "the SEO lady" / "the SEO agency" in Charles\'s words = Kati Henken at Integris Design (conardmedia@example.com), the agency that emailed.',
    ])).toEqual(["Kati Henken at Integris Design"]);
  });

  it("ignores rows that are not aliases, dedups, and caps at three", () => {
    const rows = [
      "Kati Henken is the SEO agency contact Charles emailed.",
      'ALIAS: "the painter" = Sergio (Art Work Painting).',
      'alias: "the painter" = sergio (Art Work Painting).',
      'ALIAS: "the hub" = picksbytown.com.',
      'ALIAS: "the bot" = QuickSilver.',
      'ALIAS: "the VPS" = AWS Lightsail box.',
    ];
    const t = aliasTargetsFrom(rows);
    expect(t).toHaveLength(3);
    expect(t[0]).toBe("Sergio");
  });

  it("skips expansion when the query already names the target", () => {
    expect(queryNamesTarget("kati henken follow-up", "Kati Henken at Integris Design")).toBe(true);
    expect(queryNamesTarget("the SEO lady", "Kati Henken at Integris Design")).toBe(false);
  });
});

function makeRecall(opts: {
  vector: (vec: number[]) => VectorSearchResult[];
  lexical?: (q: string) => VectorSearchResult[];
  reflections?: Array<{ id: string; text: string; score: number; category?: string; created_at?: string }>;
  embed: (text: string) => number[];
}) {
  const session = new SessionState("s", "s");
  const store = {
    isAvailable: () => true,
    vectorSearch: async (vec: number[]) => opts.vector(vec),
    fulltextSearch: async (q: string) => opts.lexical?.(q) ?? [],
    graphExpand: async () => [],
    queryFirst: async (sql: string) => sql.includes("FROM reflection") ? (opts.reflections ?? []).map((r) => ({ ...r, embedding: [1], active: true })) : [],
  };
  const state = {
    store,
    embeddings: { isAvailable: () => true, embed: async (t: string) => opts.embed(t) },
    config: {},
    onSessionRemoved: () => {},
  } as unknown as GlobalPluginState;
  return createRecallToolDef(state, session);
}

const row = (id: string, text: string, score: number, table = "memory"): VectorSearchResult => ({ id, text, table, score });

describe("1b. recall expands an alias hit to the formal name", () => {
  it("merges the formal name's rows and marks them", async () => {
    const tool = makeRecall({
      embed: (t) => (t === "the SEO lady" ? [1, 0] : [0, 1]),
      vector: (vec) => vec[0] === 1
        ? [row("memory:alias", 'ALIAS: "the SEO lady" = Kati Henken (Integris Design).', 0.8)]
        : [row("concept:kati", "Kati Henken runs Integris Design; Conard Construction is her client.", 0.9)],
    });
    const res = await tool.execute("t", { query: "the SEO lady", scope: "memories" });
    const text = res.content[0].text;
    expect(text).toContain("memory:alias".slice(0, 0) + 'ALIAS: "the SEO lady"');
    expect(text).toContain("Kati Henken runs Integris Design");
    expect(text).toContain("(via alias: Kati Henken)");
    expect((res.details as { count: number }).count).toBe(2);
  });

  it("does not expand when the query already names the person", async () => {
    let embeds = 0;
    const tool = makeRecall({
      embed: () => { embeds++; return [1, 0]; },
      vector: () => [row("memory:alias", 'ALIAS: "the SEO lady" = Kati Henken (Integris Design).', 0.8)],
    });
    await tool.execute("t", { query: "Kati Henken thread", scope: "memories" });
    expect(embeds).toBe(1);
  });
});

describe("2. reflections are reachable through recall", () => {
  it("scope=reflections returns reflection rows tagged by category", async () => {
    const tool = makeRecall({
      embed: () => [1],
      vector: () => [],
      reflections: [{ id: "reflection:r1", text: "Charles referred to 'the SEO lady' and I could not connect it to Kati Henken.", score: 0.7, category: "session_review", created_at: "2026-10-15T12:00:00Z" }],
    });
    const res = await tool.execute("t", { query: "SEO lady", scope: "reflections" });
    expect(res.content[0].text).toContain("[reflection/session_review]");
    expect(res.content[0].text).toContain("could not connect it to Kati Henken");
  });

  it("scope=all includes them beside memories", async () => {
    const tool = makeRecall({
      embed: () => [1],
      vector: () => [row("memory:m1", "a memory about the SEO lady", 0.6)],
      reflections: [{ id: "reflection:r1", text: "a reflection about the SEO lady", score: 0.7, category: "session_review" }],
    });
    const res = await tool.execute("t", { query: "SEO lady" });
    expect((res.details as { count: number }).count).toBe(2);
  });

  it("scope=memories leaves them out", async () => {
    const tool = makeRecall({
      embed: () => [1],
      vector: () => [row("memory:m1", "a memory", 0.6)],
      reflections: [{ id: "reflection:r1", text: "a reflection", score: 0.7 }],
    });
    const res = await tool.execute("t", { query: "anything", scope: "memories" });
    expect((res.details as { count: number }).count).toBe(1);
  });
});

describe("3. routines surface by flag and local hour", () => {
  const morning: RoutineSkill = { id: "skill:m", name: "leadforge-morning-check", description: "Morning queue check.", steps: [], surfaceHours: [5, 12] };
  const night: RoutineSkill = { id: "skill:n", name: "night-sweep", description: "Overnight sweep.", steps: [], surfaceHours: [22, 6] };
  const always: RoutineSkill = { id: "skill:a", name: "always", description: "Any hour.", steps: [] };

  it("keeps a routine inside its window and drops one outside it", () => {
    expect(selectDueRoutines([morning, always], 8).map((r) => r.name)).toEqual(["leadforge-morning-check", "always"]);
    expect(selectDueRoutines([morning, always], 14).map((r) => r.name)).toEqual(["always"]);
  });

  it("honours a window that wraps midnight", () => {
    expect(selectDueRoutines([night], 23)).toHaveLength(1);
    expect(selectDueRoutines([night], 3)).toHaveLength(1);
    expect(selectDueRoutines([night], 12)).toHaveLength(0);
  });

  it("formats a compact block that names the routine and its steps", () => {
    const text = formatRoutineContext([{ ...morning, steps: [{ tool: "Bash", description: "Read the presend log." }] }]);
    expect(text).toContain("[ROUTINES DUE NOW]");
    expect(text).toContain("### leadforge-morning-check");
    expect(text).toContain("1. Read the presend log.");
    expect(formatRoutineContext([])).toBe("");
  });

  it("parses the routine flags on create_skill and update_skill", () => {
    expect(parseRoutineArgs({ surface_at_session_start: true, surface_hours: [5, 12] }).extras)
      .toEqual({ surface_at_session_start: true, surface_hours: [5, 12] });
    expect(parseRoutineArgs({}).extras).toBeUndefined();
    expect(parseRoutineArgs({ surface_hours: [5] }).error).toContain("surface_hours");
    expect(parseRoutineArgs({ surface_hours: ["a", "b"] }).error).toContain("surface_hours");
  });
});
