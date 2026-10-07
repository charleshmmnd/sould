/**
 * introspect action "soul": the whole soul document, untruncated, with the
 * revision ledger's removed/added lines. verifyAction cuts every string at
 * 300 characters, which hid the body of every entry (2026-10-07).
 */
import { describe, it, expect, vi } from "vitest";
import { createIntrospectToolDef } from "../src/engine/tools/introspect.js";
import type { GlobalPluginState, SessionState } from "../src/engine/state.js";

const longText = "A lesson that runs well past three hundred characters. " + "detail ".repeat(60) + "END";

function makeState(soul: Record<string, unknown> | null) {
  const queryFirst = vi.fn().mockImplementation(async (sql: string) => {
    if (/FROM soul:laqrumbrain/.test(sql)) return soul ? [soul] : [];
    return [];
  });
  const state: Partial<GlobalPluginState> = {
    store: { isAvailable: () => true, queryFirst, relate: vi.fn(async () => {}) } as any,
  };
  const session: Partial<SessionState> = { sessionId: "test-session" };
  return { state, session };
}

describe("introspect soul action", () => {
  it("prints every section in full and the ledger with removed/added lines", async () => {
    const soul = {
      id: "soul:laqrumbrain", agent_id: "laqrumbrain",
      working_style: [longText, "Second style entry"],
      earned_values: [{ value: "Done means live", grounded_in: "a palette fix that never shipped" }],
      self_observations: ["Absence from my own channels is not absence from his world"],
      emotional_dimensions: [{ dimension: "Humour alongside the rigor", description: "he asked about super angels", adopted_at: "2026-09-30T12:19:04Z" }],
      revisions: [
        { timestamp: "2026-10-05T12:25:54Z", section: "earned_values", change: "Updated earned_values: 1 removed, 1 added", rationale: "evolve", removed: ["Refuse the guarantee"], added: ["Done means live"] },
        { timestamp: "2026-08-25T15:48:50Z", section: "working_style", change: "Updated working_style", rationale: "evolve" },
      ],
      created_at: "2026-05-22T00:00:00Z", updated_at: "2026-10-07T11:34:17Z",
    };
    const { state, session } = makeState(soul);
    const def = createIntrospectToolDef(state as GlobalPluginState, session as SessionState);
    const res = await def.execute("t", { action: "soul" } as any);
    const text = res.content.map(c => c.text).join("\n");
    expect(text).toContain("SOUL DOCUMENT (soul:laqrumbrain)");
    expect(text).toContain("WORKING STYLE (2)");
    expect(text).toContain(longText);
    expect(text).toContain("learned from: a palette fix that never shipped");
    expect(text).toContain("Humour alongside the rigor (adopted 2026-09-30T12:19:04Z)");
    expect(text).toContain("- Refuse the guarantee");
    expect(text).toContain("+ Done means live");
    expect(text).toContain("REVISIONS (last 2 of 2)");
  });

  it("masks secret-looking strings inside the document", async () => {
    const token = "ghp_" + "A".repeat(36);
    const { state, session } = makeState({ working_style: [`never paste ${token} anywhere`], earned_values: [], self_observations: [], emotional_dimensions: [], revisions: [] });
    const def = createIntrospectToolDef(state as GlobalPluginState, session as SessionState);
    const res = await def.execute("t", { action: "soul" } as any);
    const text = res.content.map(c => c.text).join("\n");
    expect(text).not.toContain(token);
    expect(text).toContain("[redacted-secret-pattern]");
  });

  it("says so when there is no soul", async () => {
    const { state, session } = makeState(null);
    const def = createIntrospectToolDef(state as GlobalPluginState, session as SessionState);
    const res = await def.execute("t", { action: "soul" } as any);
    expect(res.content[0].text).toContain("No soul document yet");
  });
});
