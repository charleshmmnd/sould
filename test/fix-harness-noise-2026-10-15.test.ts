/**
 * Harness-generated prompts are not user turns (0.10.6).
 *
 * Seen live on 2026-10-15: task notifications and subagent hand-backs arrive
 * through UserPromptSubmit, were ingested as user turns and retrieved
 * against. Retrieval keyed off tool ids and temp paths, and the stored
 * notifications came back as "past turns" on later real prompts (340 of
 * 2,848 user turns on the live graph).
 */
import { describe, it, expect, vi } from "vitest";
import { isHarnessNotification } from "../src/engine/harness-prompt.js";
import { isEchoOfCurrentPrompt } from "../src/engine/graph-context.js";
import { handleUserPromptSubmit } from "../src/hook-handlers/user-prompt-submit.js";
import { GlobalPluginState, SessionState } from "../src/engine/state.js";

const TASK = `<task-notification>
<task-id>b9b74mhs7</task-id>
<tool-use-id>toolu_01Ca9B7TiANRydCoHqvZf7af</tool-use-id>
<status>completed</status>
<summary>Background command finished (exit code 0)</summary>
</task-notification>`;

const HANDBACK = `<system-reminder id="c9d5bb7e3f65e11c">
Another Claude session sent a message while you were working:
<agent-message from="aea3f4ec027321a98">
[Subagent hand-back] The text below is the final report of a subagent.
</agent-message>
</system-reminder>`;

const SYSNOTE = `[SYSTEM NOTIFICATION - NOT USER INPUT]
This is an automated background-task event, NOT a message from the user.`;

describe("isHarnessNotification", () => {
  it("recognizes a task notification, a hand-back and a system notification", () => {
    expect(isHarnessNotification(TASK)).toBe(true);
    expect(isHarnessNotification(HANDBACK)).toBe(true);
    expect(isHarnessNotification(SYSNOTE)).toBe(true);
    expect(isHarnessNotification("<<autonomous-loop-dynamic>>")).toBe(true);
    expect(isHarnessNotification("  \n<task-notification>x</task-notification>")).toBe(true);
  });

  it("leaves real prompts alone, including ones that mention or paste a notification", () => {
    expect(isHarnessNotification("looking to improve the sould plugin")).toBe(false);
    expect(isHarnessNotification("why did this task-notification say exit code 1?\n" + TASK)).toBe(false);
    expect(isHarnessNotification("")).toBe(false);
    expect(isHarnessNotification(undefined)).toBe(false);
  });
});

describe("retrieval drops stored notification turns", () => {
  const old = new Date(Date.now() - 86_400_000).toISOString();
  it("a stored task notification is treated as an echo and filtered", () => {
    expect(isEchoOfCurrentPrompt({ table: "turn", timestamp: old, text: TASK }, "anything", Date.now() - 5_000)).toBe(true);
  });
  it("a genuine older turn still passes", () => {
    expect(isEchoOfCurrentPrompt({ table: "turn", timestamp: old, text: "fix the footer" }, "anything", Date.now() - 5_000)).toBe(false);
  });
});

function makeState(session: SessionState) {
  const ingested: string[] = [];
  const store = {
    isAvailable: () => true,
    queryFirst: vi.fn(async () => []),
    queryExec: vi.fn(async () => {}),
    ensureAgent: async () => "agent:a",
    ensureSessionRow: async () => "session:s",
    bumpSessionTurn: async () => {},
    getPreviousSessionTurns: async () => [],
    storeTurn: vi.fn(async (_sid: string, role: string, text: string) => { ingested.push(`${role}:${text.slice(0, 20)}`); return "turn:x"; }),
    insertTurn: vi.fn(async (...a: unknown[]) => { ingested.push(String(a[1] ?? "turn")); return "turn:x"; }),
  } as unknown as GlobalPluginState["store"];
  const embeddings = {
    isAvailable: () => false,
    embed: vi.fn(async () => new Array(8).fill(0)),
  } as unknown as GlobalPluginState["embeddings"];
  const state = {
    store, embeddings,
    config: { thresholds: { midSessionCleanupThreshold: 25_000 } },
    workspaceDir: "/tmp",
  } as unknown as GlobalPluginState;
  (state as unknown as { getSession: () => SessionState }).getSession = () => session;
  (state as unknown as { getOrCreateSession: () => SessionState }).getOrCreateSession = () => session;
  return { state, embeddings };
}

describe("handleUserPromptSubmit skips harness notifications", () => {
  it("returns nothing, embeds nothing, and keeps the user's last real prompt", async () => {
    const session = new SessionState("s", "s");
    session.lastUserText = "fix the footer";
    const { state, embeddings } = makeState(session);
    const res = await handleUserPromptSubmit(state, { session_id: "s", prompt: TASK });
    expect(res).toEqual({});
    expect((embeddings as unknown as { embed: ReturnType<typeof vi.fn> }).embed).not.toHaveBeenCalled();
    expect(session.lastUserText).toBe("fix the footer");
  });

  it("a real prompt still goes through", async () => {
    const session = new SessionState("s", "s");
    const { state } = makeState(session);
    await handleUserPromptSubmit(state, { session_id: "s", prompt: "what did we ship yesterday?" });
    expect(session.lastUserText).toBe("what did we ship yesterday?");
  });
});
