/**
 * 0.10.8 regression tests.
 *
 * On 2026-10-31 the live graph held 1,959 daemon-extracted concepts, 1,570 of
 * them with no derived_from and no relevant_to edge, 381 of the 445 written in
 * the previous two weeks. Chain: the idle reaper exits the daemon 60 s after
 * the last session closes; the next session's SessionStart found no daemon
 * and failed open; UserPromptSubmit backfilled the session ROW only, so
 * session.taskId / projectId stayed ""; SessionEnd enqueued the extraction
 * item with task_id/project_id null (224 of 276 items); the writer then fell
 * back to the Claude session UUID as the derived_from target, which is not a
 * record id ("Invalid record ID format: <uuid>"), and the concept was written
 * as an island. Fixes under test:
 *   - ensureSessionPillars: one idempotent bootstrap shared by both hooks
 *   - provenanceTarget / writeExtractionResults: never a bare UUID
 *   - resolveItemProvenance: project from the session row
 *   - healOrphanDaemonConcepts: relink the existing islands
 *   - checkStageTransition: a re-entered maturity stage UPDATEs its row
 *   - pillar links go through relate(), so a repeat link is not a warn
 *   - the 0.10.7+1 previous-session-turns query walks part_of (indexed on out)
 */
import { describe, it, expect, vi } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

vi.mock("../src/engine/commit.js", () => ({
  commitKnowledge: vi.fn(async () => ({ id: "concept:new", edges: 0 })),
}));
vi.mock("../src/engine/concept-links.js", () => ({
  linkConceptHierarchy: vi.fn(async () => 0),
  linkToRelevantConcepts: vi.fn(async () => 0),
}));

import { ensureSessionPillars, projectNameFromCwd } from "../src/engine/session-pillars.js";
import { SessionState } from "../src/engine/state.js";
import { provenanceTarget, writeExtractionResults } from "../src/engine/memory-daemon.js";
import { commitKnowledge } from "../src/engine/commit.js";
import { resolveItemProvenance } from "../src/tools/pending-work.js";
import { latestEnteredStage, checkStageTransition } from "../src/engine/soul.js";
import { healOrphanDaemonConcepts } from "../src/engine/maintenance.js";
import { SurrealStore } from "../src/engine/surreal.js";

const UUID = "70584bc8-a0c9-4339-8d98-3c0ac1c329cf";

function pillarStore() {
  const calls: string[] = [];
  const store = {
    ensureAgent: vi.fn(async () => { calls.push("ensureAgent"); return "agent:a"; }),
    ensureProject: vi.fn(async (name: string) => { calls.push(`ensureProject:${name}`); return "project:p"; }),
    createTask: vi.fn(async () => { calls.push("createTask"); return "task:t"; }),
    ensureSessionRow: vi.fn(async () => { calls.push("ensureSessionRow"); return "session:s"; }),
    linkAgentToProject: vi.fn(async () => { calls.push("linkAgentToProject"); }),
    linkAgentToTask: vi.fn(async () => { calls.push("linkAgentToTask"); }),
    linkTaskToProject: vi.fn(async () => { calls.push("linkTaskToProject"); }),
    linkSessionToTask: vi.fn(async () => { calls.push("linkSessionToTask"); }),
    markSessionActive: vi.fn(async () => { calls.push("markSessionActive"); }),
  };
  return { store, calls };
}

describe("ensureSessionPillars", () => {
  it("fills every pillar for a fresh session and links them", async () => {
    const { store, calls } = pillarStore();
    const session = new SessionState(UUID, UUID);
    const { filled } = await ensureSessionPillars(store as never, session, "/home/charles/sould");
    expect(filled).toEqual(["agent", "project", "task", "session"]);
    expect(session.agentId).toBe("agent:a");
    expect(session.projectId).toBe("project:p");
    expect(session.taskId).toBe("task:t");
    expect(session.surrealSessionId).toBe("session:s");
    expect(store.ensureProject).toHaveBeenCalledWith("sould");
    expect(store.createTask).toHaveBeenCalledWith("Session in sould", "project:p");
    expect(store.ensureSessionRow).toHaveBeenCalledWith(UUID, "agent:a", "project:p");
    expect(calls).toContain("linkAgentToProject");
    expect(calls).toContain("linkAgentToTask");
    expect(calls).toContain("linkTaskToProject");
    expect(calls).toContain("linkSessionToTask");
    expect(calls).toContain("markSessionActive");
  });

  it("completes a session that only has a row (the old UserPromptSubmit backfill shape)", async () => {
    const { store } = pillarStore();
    const session = new SessionState(UUID, UUID);
    session.surrealSessionId = "session:s";
    const { filled } = await ensureSessionPillars(store as never, session, "/w/proj");
    expect(filled).toEqual(["agent", "project", "task"]);
    expect(session.taskId).toBe("task:t");
    // The pre-existing row gets its project backfilled through ensureSessionRow.
    expect(store.ensureSessionRow).toHaveBeenCalledTimes(1);
    expect(store.ensureSessionRow).toHaveBeenCalledWith(UUID, "agent:a", "project:p");
    expect(store.linkSessionToTask).toHaveBeenCalledWith("session:s", "task:t");
    expect(store.markSessionActive).not.toHaveBeenCalled();
  });

  it("is a no-op for a fully bootstrapped session except the idempotent owns link", async () => {
    const { store } = pillarStore();
    const session = new SessionState(UUID, UUID);
    session.agentId = "agent:a";
    session.projectId = "project:p";
    session.taskId = "task:t";
    session.surrealSessionId = "session:s";
    const { filled } = await ensureSessionPillars(store as never, session, "/w/proj");
    expect(filled).toEqual([]);
    expect(store.createTask).not.toHaveBeenCalled();
    expect(store.ensureSessionRow).not.toHaveBeenCalled();
    expect(store.linkSessionToTask).not.toHaveBeenCalled();
    expect(store.linkAgentToProject).toHaveBeenCalledTimes(1);
  });

  it("a failing link does not abort the bootstrap", async () => {
    const { store } = pillarStore();
    store.linkAgentToProject.mockRejectedValueOnce(new Error("Database index owns_inout_unique already contains"));
    const session = new SessionState(UUID, UUID);
    const { filled } = await ensureSessionPillars(store as never, session, "/w/proj");
    expect(filled).toEqual(["agent", "project", "task", "session"]);
  });

  it("projectNameFromCwd takes the last segment on either separator", () => {
    expect(projectNameFromCwd("/home/charles/sould")).toBe("sould");
    expect(projectNameFromCwd("/home/charles/sould/")).toBe("sould");
    expect(projectNameFromCwd("C:\\Users\\charles\\proj")).toBe("proj");
    expect(projectNameFromCwd(undefined)).toBe("unknown");
    expect(projectNameFromCwd("")).toBe("unknown");
  });
});

describe("pillar links are idempotent", () => {
  it("linkAgentToProject goes through relate(), which absorbs the UNIQUE collision", async () => {
    const relate = vi.fn(async () => false);
    const fake = { relate } as unknown as SurrealStore;
    await SurrealStore.prototype.linkAgentToProject.call(fake, "agent:a", "project:p");
    await SurrealStore.prototype.linkAgentToTask.call(fake, "agent:a", "task:t");
    await SurrealStore.prototype.linkTaskToProject.call(fake, "task:t", "project:p");
    await SurrealStore.prototype.linkSessionToTask.call(fake, "session:s", "task:t");
    expect(relate.mock.calls).toEqual([
      ["agent:a", "owns", "project:p"],
      ["agent:a", "performed", "task:t"],
      ["task:t", "task_part_of", "project:p"],
      ["session:s", "session_task", "task:t"],
    ]);
  });
});

describe("extraction provenance never falls back to the session UUID", () => {
  it("provenanceTarget prefers the task, then the session row, never a bare UUID", () => {
    expect(provenanceTarget("task:abc", "session:s", UUID)).toBe("task:abc");
    expect(provenanceTarget("", "session:s", UUID)).toBe("session:s");
    expect(provenanceTarget(undefined, undefined, UUID)).toBeUndefined();
    expect(provenanceTarget(null, null, "")).toBeUndefined();
    // Legacy callers passed the session RECORD id in the sessionId slot.
    expect(provenanceTarget(undefined, undefined, "session:legacy")).toBe("session:legacy");
  });

  it("writeExtractionResults hands commitKnowledge the session row when the item has no task", async () => {
    const mocked = vi.mocked(commitKnowledge);
    mocked.mockClear();
    const embeddings = { isAvailable: () => false } as never;
    const prior = { conceptNames: [], artifactPaths: [], skillNames: [] };
    await writeExtractionResults(
      { concepts: [{ name: "Jarvis wake chime", content: "The wake chime cut off commands" }] },
      UUID, {} as never, embeddings, prior, "", undefined, undefined, "session:s",
    );
    expect(mocked).toHaveBeenCalledTimes(1);
    const data = mocked.mock.calls[0][1] as Record<string, unknown>;
    expect(data.kind).toBe("concept");
    expect(data.source).toBe(`daemon:${UUID}`);
    expect(data.derivedFromTargetId).toBe("session:s");
  });

  it("writeExtractionResults passes no target rather than the UUID when nothing resolves", async () => {
    const mocked = vi.mocked(commitKnowledge);
    mocked.mockClear();
    const embeddings = { isAvailable: () => false } as never;
    const prior = { conceptNames: [], artifactPaths: [], skillNames: [] };
    await writeExtractionResults(
      { concepts: [{ name: "n", content: "c" }] },
      UUID, {} as never, embeddings, prior, undefined, undefined,
    );
    const data = mocked.mock.calls[0][1] as Record<string, unknown>;
    expect(data.derivedFromTargetId).toBeUndefined();
  });

  it("resolveItemProvenance fills the project from the session row and mutates the item", async () => {
    const queryFirst = vi.fn(async () => [{ project_id: { toString: () => "project:q" } }]);
    const item = { id: "pending_work:x", work_type: "coalesced_extraction", session_id: UUID,
      surreal_session_id: "session:s", task_id: "", project_id: "", priority: 1 } as never;
    const prov = await resolveItemProvenance({ queryFirst } as never, item);
    expect(queryFirst).toHaveBeenCalledWith("SELECT project_id FROM session:s");
    expect(prov).toEqual({ taskId: undefined, projectId: "project:q", surrealSessionId: "session:s" });
    expect((item as { project_id: string }).project_id).toBe("project:q");
  });

  it("resolveItemProvenance leaves a complete item alone and tolerates a missing session row id", async () => {
    const queryFirst = vi.fn(async () => []);
    const full = { session_id: UUID, surreal_session_id: "session:s", task_id: "task:t", project_id: "project:p" } as never;
    expect(await resolveItemProvenance({ queryFirst } as never, full))
      .toEqual({ taskId: "task:t", projectId: "project:p", surrealSessionId: "session:s" });
    const bare = { session_id: UUID, task_id: null, project_id: null } as never;
    expect(await resolveItemProvenance({ queryFirst } as never, bare))
      .toEqual({ taskId: undefined, projectId: undefined, surrealSessionId: undefined });
    expect(queryFirst).not.toHaveBeenCalled();
  });
});

describe("healOrphanDaemonConcepts", () => {
  it("relinks islands to their session (and project) by the UUID or legacy record id in source", async () => {
    const relate = vi.fn(async () => true);
    const queryFirst = vi.fn();
    // The second UUID resolves to no row.
    queryFirst.mockImplementation(async (sql: string, bindings?: Record<string, unknown>) => {
      if (sql.includes("FROM concept")) {
        return [
          { id: "concept:a", source: `daemon:${UUID}` },
          { id: "concept:b", source: `daemon:${UUID}` },
          { id: "concept:c", source: "daemon:session:legacy1" },
          { id: "concept:d", source: "daemon:not-a-session" },
          { id: "concept:e", source: "daemon:11111111-2222-3333-4444-555555555555" },
        ];
      }
      if (sql.includes("WHERE kc_session_id = $kc")) {
        return bindings?.kc === UUID ? [{ id: "session:s1", project_id: "project:p1" }] : [];
      }
      if (sql.includes("FROM session:legacy1")) return [{ id: "session:legacy1" }];
      return [];
    });
    const store = { isAvailable: () => true, queryFirst, relate };
    const linked = await healOrphanDaemonConcepts({ store } as never);
    expect(linked).toBe(3);
    expect(relate.mock.calls).toEqual([
      ["concept:a", "derived_from", "session:s1"],
      ["concept:a", "relevant_to", "project:p1"],
      ["concept:b", "derived_from", "session:s1"],
      ["concept:b", "relevant_to", "project:p1"],
      ["concept:c", "derived_from", "session:legacy1"],
    ]);
    // One session lookup per distinct UUID (cached), one for the legacy id.
    const lookups = queryFirst.mock.calls.filter(([sql]) => !String(sql).includes("FROM concept"));
    expect(lookups).toHaveLength(3);
  });

  it("returns 0 and issues no relates when there are no islands", async () => {
    const relate = vi.fn();
    const store = { isAvailable: () => true, queryFirst: vi.fn(async () => []), relate };
    expect(await healOrphanDaemonConcepts({ store } as never)).toBe(0);
    expect(relate).not.toHaveBeenCalled();
  });
});

describe("maturity stage re-entry", () => {
  it("latestEnteredStage prefers last_entered_at over created_at", () => {
    expect(latestEnteredStage([
      { stage: "ready", created_at: "2026-06-20T21:54:18Z" },
      { stage: "maturing", created_at: "2026-05-01T20:36:49Z", last_entered_at: "2026-10-31T00:00:00Z" },
      { stage: "nascent", created_at: new Date("2026-04-29T14:02:35Z") },
    ])).toBe("maturing");
    expect(latestEnteredStage([
      { stage: "ready", created_at: "2026-06-20T21:54:18Z" },
      { stage: "maturing", created_at: "2026-05-01T20:36:49Z" },
    ])).toBe("ready");
    expect(latestEnteredStage([])).toBeNull();
    expect(latestEnteredStage([{ stage: "x" }])).toBe("x");
  });

  function stageStore(rows: Array<Record<string, unknown>>) {
    const updates: Array<Record<string, unknown> | undefined> = [];
    const creates: Array<Record<string, unknown> | undefined> = [];
    const store = {
      isAvailable: () => true,
      queryFirst: vi.fn(async (sql: string, bindings?: Record<string, unknown>) => {
        if (/^\s*UPDATE maturity_stage/.test(sql)) {
          updates.push(bindings);
          return rows.some((r) => r.stage === bindings?.stage) ? [{ id: "maturity_stage:x" }] : [];
        }
        if (sql.includes("FROM maturity_stage")) return rows;
        if (sql.includes("count()")) return [{ count: 0 }];
        if (sql.includes("avgUtil")) return [{ avgUtil: 0, cnt: 0 }];
        if (sql.includes("totalSuccess")) return [{ totalSuccess: 0, totalFailure: 0 }];
        return [];
      }),
      queryExec: vi.fn(async (sql: string, bindings?: Record<string, unknown>) => {
        if (sql.includes("CREATE maturity_stage")) creates.push(bindings);
      }),
    };
    return { store, updates, creates };
  }

  it("re-entering a stage that already has a row UPDATEs it instead of CREATE", async () => {
    // Learn the stage an empty graph computes, then seed a row for it.
    const probe = stageStore([]);
    const first = await checkStageTransition(probe.store as never);
    const current = first.currentStage;
    expect(probe.creates).toHaveLength(1);

    const { store, updates, creates } = stageStore([
      { stage: "ready", created_at: "2026-06-20T21:54:18Z" },
      { stage: current, created_at: "2026-04-29T14:02:35Z" },
    ]);
    const t = await checkStageTransition(store as never);
    expect(t.previousStage).toBe("ready");
    expect(t.transitioned).toBe(true);
    expect(updates).toHaveLength(1);
    expect(updates[0]?.stage).toBe(current);
    expect(creates).toHaveLength(0);
  });

  it("a stage never seen before is still CREATEd", async () => {
    const probe = stageStore([]);
    const current = (await checkStageTransition(probe.store as never)).currentStage;
    const { store, updates, creates } = stageStore([
      { stage: "ready", created_at: "2026-06-20T21:54:18Z" },
    ]);
    const t = await checkStageTransition(store as never);
    expect(t.transitioned).toBe(current !== "ready");
    if (current !== "ready") {
      expect(updates).toHaveLength(1);
      expect(creates).toHaveLength(1);
      expect((creates[0]?.data as Record<string, unknown>).stage).toBe(current);
    }
  });

  it("no transition writes nothing", async () => {
    const probe = stageStore([]);
    const current = (await checkStageTransition(probe.store as never)).currentStage;
    const { store, updates, creates } = stageStore([{ stage: current, created_at: "2026-04-29T14:02:35Z" }]);
    const t = await checkStageTransition(store as never);
    expect(t.transitioned).toBe(false);
    expect(updates).toHaveLength(0);
    expect(creates).toHaveLength(0);
  });
});

describe("previous-session turns are read from the session side of part_of", () => {
  const SRC = join(__dirname, "..", "src", "engine");
  it("schema indexes part_of.out", () => {
    const schema = readFileSync(join(SRC, "schema.surql"), "utf8");
    expect(schema).toMatch(/DEFINE INDEX IF NOT EXISTS part_of_out_idx ON part_of FIELDS out/);
  });
  it("getPreviousSessionTurns walks part_of instead of `turn WHERE id IN (subquery)`", () => {
    const src = readFileSync(join(SRC, "surreal.ts"), "utf8");
    const start = src.indexOf("async getPreviousSessionTurns(");
    expect(start).toBeGreaterThan(0);
    const body = src.slice(start, src.indexOf("\n  }\n", start));
    expect(body).toContain("FROM part_of WHERE out = type::record($sid)");
    expect(body).not.toContain("WHERE id IN (SELECT VALUE in FROM part_of");
  });
});
