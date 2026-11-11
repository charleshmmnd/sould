import { describe, it, expect, beforeEach } from "vitest";
import { SessionState } from "../src/engine/state.js";
import {
  buildSubjectBrief, extractSubjectCandidates, toolInputSubjectText, rearmSubjectBriefs,
  resetSubjectBriefs, subjectDfCeiling, _resetSubjectBriefCaches,
} from "../src/engine/subject-brief.js";

// A store that answers from a table of word -> notes. Counts every query so
// the tests can show what is and is not looked up twice.
function fakeStore(notes: Record<string, Array<{ text: string; created_at: string }>>, total = 8720) {
  const calls: string[] = [];
  return {
    calls,
    isAvailable: () => true,
    async queryFirst<T>(sql: string, b?: Record<string, unknown>): Promise<T[]> {
      calls.push(sql);
      const t = b?.t as string | undefined;
      if (sql.startsWith("SELECT count()") && !t) return [{ n: total }] as T[];
      const rows = notes[t ?? ""] ?? [];
      if (sql.startsWith("SELECT count()")) return (rows.length ? [{ n: rows.length }] : []) as T[];
      const before = b?.before as Date;
      return rows
        .filter((r) => !sql.includes("[CORRECTION]") || r.text.startsWith("[CORRECTION]"))
        .filter((r) => new Date(r.created_at) < before)
        .sort((a, z) => z.created_at.localeCompare(a.created_at))
        .slice(0, sql.includes("[CORRECTION]") ? 1 : 3)
        .map((r) => ({ id: `memory:${r.text}`, ...r })) as T[];
    },
  };
}

const many = (word: string, n: number) =>
  Array.from({ length: n }, (_, i) => ({ text: `${word} note ${i}`, created_at: `2026-0${1 + (i % 9)}-10T00:00:00Z` }));

const PARTNER = [
  { text: "Acmestay told us on 5 Nov that they shut the feed off; we asked for an export instead.", created_at: "2026-11-05T23:10:00Z" },
  { text: "Acmestay feed joined in August.", created_at: "2026-08-04T00:00:00Z" },
  { text: "Acmestay contact is the partnerships lead.", created_at: "2026-09-01T00:00:00Z" },
  { text: "Acmestay first payout note.", created_at: "2026-07-01T00:00:00Z" },
];

const NOW = Date.parse("2026-11-11T22:00:00Z");

describe("subject brief", () => {
  beforeEach(() => { _resetSubjectBriefCaches(); delete process.env.SOULD_SUBJECT_BRIEF; });

  it("takes subject words from a command and leaves tooling words out", () => {
    const words = extractSubjectCandidates("ssh ubuntu@host 'python3 ingest_acmestay.py --feed data/acmestay.json.gz' # check the Acmestay feed");
    expect(words).toContain("acmestay");
    expect(words).not.toContain("python");
    expect(words).not.toContain("ubuntu");
    expect(words.filter((w) => w === "acmestay")).toHaveLength(1);
  });

  it("does not read a heredoc's body", () => {
    const text = toolInputSubjectText("Bash", { command: "python3 - <<'EOF'\nfrom pathlib import Path\nEOF", description: "Patch the Acmestay merge" });
    expect(text).not.toContain("pathlib");
    expect(text).toContain("Acmestay");
  });

  it("reads the path of a file edit and not the text being written", () => {
    const text = toolInputSubjectText("Write", { file_path: "/x/acmestay_merge.py", content: "nicole wilburn harrison" });
    expect(text).toContain("acmestay");
    expect(text).not.toContain("wilburn");
  });

  it("briefs the newest notes on a subject the first time a tool call names it", async () => {
    const store = fakeStore({ acmestay: PARTNER, deploy: many("deploy", 832) });
    const s = new SessionState("s1", "s1");
    const brief = await buildSubjectBrief(store, s, "Bash", { command: "python3 ingest_acmestay.py && ./deploy.sh" }, NOW);
    expect(brief).toContain('"acmestay" (4 notes in memory)');
    expect(brief).toContain("2026-11-05 Acmestay told us on 5 Nov that they shut the feed off");
    // newest first, three of the four
    expect(brief!.indexOf("2026-11-05")).toBeLessThan(brief!.indexOf("2026-09-01"));
    expect(brief).not.toContain("first payout");
    expect(brief).toContain("call recall");
  });

  it("stays quiet for a word most of the graph mentions and for a word it has never seen", async () => {
    const store = fakeStore({ deployment: many("deployment", 832), zzyzx: [] });
    const s = new SessionState("s1", "s1");
    expect(await buildSubjectBrief(store, s, "Bash", { command: "run deployment for zzyzx" }, NOW)).toBeNull();
    // and neither word is looked up again in this session
    const n = store.calls.length;
    expect(await buildSubjectBrief(store, s, "Bash", { command: "run deployment for zzyzx" }, NOW)).toBeNull();
    expect(store.calls.length).toBe(n);
  });

  it("carries the newest correction even when newer notes outrank it", async () => {
    const store = fakeStore({ acmestay: [...PARTNER,
      { text: "[CORRECTION] Acmestay: I send these replies myself from the brand mailbox.", created_at: "2026-06-01T00:00:00Z" }] });
    const brief = await buildSubjectBrief(store, new SessionState("s1", "s1"), "Bash", { command: "grep acmestay x" }, NOW);
    expect(brief).toContain("2026-06-01 [CORRECTION] Acmestay: I send these replies myself");
    expect(brief!.match(/^- /gm)).toHaveLength(4);
  });

  it("a lookup that runs out of time marks nothing, so the next call still briefs", async () => {
    const real = fakeStore({ acmestay: PARTNER });
    let slow = true;
    const store = { ...real, queryFirst: <T>(q: string, b?: Record<string, unknown>) =>
      slow ? new Promise<T[]>(() => {}) : real.queryFirst<T>(q, b) };
    const s = new SessionState("s1", "s1");
    expect(await buildSubjectBrief(store, s, "Bash", { command: "grep acmestay x" }, NOW)).toBeNull();
    expect(s._subjectsBriefed.size).toBe(0);
    slow = false;
    expect(await buildSubjectBrief(store, s, "Bash", { command: "grep acmestay x" }, NOW)).toContain("acmestay");
  }, 5000);

  it("an ordinary word in the right frequency band is not a subject", async () => {
    const store = fakeStore({
      handlers: many("the form handlers were", 83),
      acmestay: PARTNER,
    });
    const s = new SessionState("s1", "s1");
    const brief = await buildSubjectBrief(store, s, "Bash", { command: "cp dist/handlers/x.js /acmestay/" }, NOW);
    expect(brief).toContain('"acmestay"');
    expect(brief).not.toContain('"handlers"');
    expect(s._subjectTermsRejected.has("handlers")).toBe(true);
  });

  it("the ceiling follows the size of the graph", () => {
    expect(subjectDfCeiling(8720)).toBe(122);
    expect(subjectDfCeiling(300)).toBe(40);
  });

  it("briefs a subject once, then again after compaction", async () => {
    const store = fakeStore({ acmestay: PARTNER });
    const s = new SessionState("s1", "s1");
    const input = { command: "curl https://acmestay.example/property/1" };
    expect(await buildSubjectBrief(store, s, "Bash", input, NOW)).not.toBeNull();
    expect(await buildSubjectBrief(store, s, "Bash", input, NOW)).toBeNull();
    resetSubjectBriefs(s);
    expect(await buildSubjectBrief(store, s, "Bash", input, NOW)).not.toBeNull();
  });

  it("a no-signal prompt re-arms a brief from two turns back, not one just read", async () => {
    const store = fakeStore({ acmestay: PARTNER });
    const s = new SessionState("s1", "s1");
    s.userTurnCount = 5;
    const input = { command: "grep acmestay build.py" };
    expect(await buildSubjectBrief(store, s, "Bash", input, NOW)).not.toBeNull();
    s.userTurnCount = 6;
    expect(rearmSubjectBriefs(s)).toBe(0);
    s.userTurnCount = 7;
    expect(rearmSubjectBriefs(s)).toBe(1);
    expect(await buildSubjectBrief(store, s, "Bash", input, NOW)).not.toBeNull();
  });

  it("leaves out notes saved during this session", async () => {
    const s = new SessionState("s1", "s1");
    const store = fakeStore({ acmestay: [
      { text: "Acmestay older note one.", created_at: "2026-08-04T00:00:00Z" },
      { text: "Acmestay older note two.", created_at: "2026-09-04T00:00:00Z" },
      { text: "Acmestay saved a minute from now.", created_at: new Date(s.createdAtMs + 60_000).toISOString() },
    ] });
    const brief = await buildSubjectBrief(store, s, "Bash", { command: "grep acmestay x" }, NOW);
    expect(brief).toContain("older note two");
    expect(brief).not.toContain("a minute from now");
  });

  it("never briefs on the memory tools' own calls, and can be switched off", async () => {
    const store = fakeStore({ acmestay: PARTNER });
    const s = new SessionState("s1", "s1");
    expect(await buildSubjectBrief(store, s, "mcp__plugin_sould_sould__recall", { query: "acmestay feed" }, NOW)).toBeNull();
    process.env.SOULD_SUBJECT_BRIEF = "0";
    expect(await buildSubjectBrief(store, s, "Bash", { command: "grep acmestay x" }, NOW)).toBeNull();
  });

  it("fails open when the store throws or hangs", async () => {
    const s = new SessionState("s1", "s1");
    const broken = { isAvailable: () => true, queryFirst: async () => { throw new Error("db down"); } };
    expect(await buildSubjectBrief(broken, s, "Bash", { command: "grep acmestay x" }, NOW)).toBeNull();
    const hung = { isAvailable: () => true, queryFirst: () => new Promise<never[]>(() => {}) };
    const t0 = Date.now();
    expect(await buildSubjectBrief(hung, s, "Bash", { command: "grep acmestay y" }, NOW)).toBeNull();
    expect(Date.now() - t0).toBeLessThan(2000);
  });
});
