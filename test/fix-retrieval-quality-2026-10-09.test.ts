/**
 * Retrieval quality fixes (2026-10-09), each observed live in one session:
 *
 * 1. recall("Burbage") returned none of the three memories containing the word:
 *    the recall tool ran the dense arm only. It now fuses in the BM25 arm.
 * 2. Auto-injection showed the just-typed prompt as the top "load-bearing" past
 *    turn: the echo filter covered the vector arm only, and BM25 scores (1 to 15)
 *    were read downstream as cosine.
 * 3. The previous session's last turns rode along on every prompt at a fixed
 *    "70%" whatever the topic. They now go out once per session.
 * 4. The Stop push reminder blocked after pushes already verified, in repos
 *    with no GitHub Actions at all.
 */
import { describe, it, expect } from "vitest";
import { fuseRecallArms } from "../src/engine/tools/recall.js";
import { ensureRecentTurns, isEchoOfCurrentPrompt, type ScoredResult } from "../src/engine/graph-context.js";
import { pushReminderOwed, pushRepoDir } from "../src/hook-handlers/pre-tool-use.js";
import { SessionState } from "../src/engine/state.js";
import type { VectorSearchResult } from "../src/engine/surreal.js";

const row = (id: string, score: number, extra: Partial<VectorSearchResult> = {}): VectorSearchResult =>
  ({ id, text: id, table: "memory", score, ...extra });

describe("1. recall fuses the lexical arm", () => {
  it("keeps an exact-name hit the dense arm never returned", () => {
    const vector = [row("memory:leadforge1", 0.40), row("memory:leadforge2", 0.30)];
    const lexical = [row("memory:burbage", 6.2, { cosine: 0.21 })];
    const fused = fuseRecallArms(vector, lexical);
    const hit = fused.find((r) => r.id === "memory:burbage");
    expect(hit).toBeDefined();
    expect(hit!.lexical).toBe(true);
    // Carries its cosine, not the raw BM25, so the reranker blend stays on one scale.
    expect(hit!.score).toBeCloseTo(0.21);
    // Rank 1 in the lexical arm ties rank 1 in the dense arm under RRF.
    expect(fused.slice(0, 2).map((r) => r.id)).toContain("memory:burbage");
  });

  it("a row found by both arms outranks rows found by one", () => {
    const vector = [row("a", 0.9), row("both", 0.5)];
    const lexical = [row("both", 3), row("c", 2)];
    const fused = fuseRecallArms(vector, lexical);
    expect(fused[0].id).toBe("both");
    expect(fused.filter((r) => r.id === "both")).toHaveLength(1);
  });

  it("dense-only input is unchanged in order", () => {
    const fused = fuseRecallArms([row("x", 0.2), row("y", 0.8)], []);
    expect(fused.map((r) => r.id)).toEqual(["y", "x"]);
  });

  it("keys on String(id) so RecordId-shaped ids still merge", () => {
    const rid = { toString: () => "memory:same" } as unknown as string;
    const fused = fuseRecallArms([row(rid, 0.5)], [row("memory:same", 4, { cosine: 0.5 })]);
    expect(fused).toHaveLength(1);
  });
});

describe("2. the current prompt is not past context", () => {
  const now = Date.now();
  const cutoff = now - 5_000;
  const iso = (ms: number) => new Date(ms).toISOString();

  it("drops a turn stored in the last few seconds", () => {
    expect(isEchoOfCurrentPrompt({ table: "turn", timestamp: iso(now - 1_000), text: "x" }, "y", cutoff)).toBe(true);
  });
  it("drops a turn with no timestamp (lexical rows used to arrive without one)", () => {
    expect(isEchoOfCurrentPrompt({ table: "turn", text: "wow those all sound important" }, "q", cutoff)).toBe(true);
  });
  it("drops an older turn whose text is the prompt itself", () => {
    expect(isEchoOfCurrentPrompt(
      { table: "turn", timestamp: iso(now - 60_000), text: "  wow those all\nsound important " },
      "wow those all sound important", cutoff)).toBe(true);
  });
  it("keeps a genuine older turn and every non-turn row", () => {
    expect(isEchoOfCurrentPrompt({ table: "turn", timestamp: iso(now - 60_000), text: "older" }, "new", cutoff)).toBe(false);
    expect(isEchoOfCurrentPrompt({ table: "memory", text: "new" }, "new", cutoff)).toBe(false);
  });
});

describe("3. previous-session turns go out once per session", () => {
  const prev = [
    { role: "assistant", text: "The push is confirmed", timestamp: "2026-10-09T21:00:00Z" },
    { role: "user", text: "task-notification", timestamp: "2026-10-09T21:01:00Z" },
  ];
  const store = {} as never; // unused: the turns are pre-cached on the session

  it("first prompt carries them, later prompts do not", async () => {
    const s = new SessionState("s1", "k1");
    s._cachedPrevTurns = prev;
    const first = await ensureRecentTurns([] as ScoredResult[], s, store);
    expect(first.filter((n) => String(n.id).startsWith("guaranteed:"))).toHaveLength(2);
    const second = await ensureRecentTurns([] as ScoredResult[], s, store);
    expect(second).toHaveLength(0);
  });

  it("PostCompact re-arms delivery", async () => {
    const s = new SessionState("s2", "k2");
    s._cachedPrevTurns = prev;
    await ensureRecentTurns([] as ScoredResult[], s, store);
    s._prevTurnsDelivered = false; // what post-compact.ts does
    const again = await ensureRecentTurns([] as ScoredResult[], s, store);
    expect(again).toHaveLength(2);
  });
});

describe("4. push reminder", () => {
  const none = { owed: false, needsCi: false };
  const noCi = () => false;
  const ci = () => true;

  it("a bare push is owed a reminder", () => {
    expect(pushReminderOwed("git push -q", none, noCi)).toEqual({ owed: true, needsCi: false });
  });
  it("push verified in the same command (no CI repo) owes nothing", () => {
    expect(pushReminderOwed("git push -q && git ls-remote origin main", none, noCi).owed).toBe(false);
  });
  it("a verification BEFORE the push does not count", () => {
    expect(pushReminderOwed("git ls-remote origin main; git push", none, noCi).owed).toBe(true);
  });
  it("a later command clears it", () => {
    const owed = pushReminderOwed("git push", none, noCi);
    expect(pushReminderOwed("git fetch -q && git status -sb", owed, noCi).owed).toBe(false);
  });
  it("a CI repo still needs gh run, ls-remote is not enough", () => {
    const owed = pushReminderOwed("git push && git ls-remote origin main", none, ci);
    expect(owed).toEqual({ owed: true, needsCi: true });
    expect(pushReminderOwed("git ls-remote origin main", owed, ci).owed).toBe(true);
    expect(pushReminderOwed("gh run list -L 3", owed, ci).owed).toBe(false);
  });
  it("unrelated commands leave the flag alone", () => {
    const owed = { owed: true, needsCi: false };
    expect(pushReminderOwed("ls -la", owed, noCi)).toEqual(owed);
  });
  it("resolves the pushed repo from the last cd before the push", () => {
    expect(pushRepoDir("cd /home/x/sould && npm test && git push", "/tmp")).toBe("/home/x/sould");
    expect(pushRepoDir("cd ~/proj && git push", "/base")).toMatch(/[\\/]proj$/);
    expect(pushRepoDir("git push", "/repo")).toBe("/repo");
  });
});
