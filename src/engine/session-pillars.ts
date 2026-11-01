/**
 * Session pillar bootstrap (0.10.8).
 *
 * SessionStart creates the pillar rows for a session (agent, project, task,
 * session) and the edges between them. When the daemon is not up when
 * SessionStart fires (the idle reaper exits it between sessions and the hook
 * proxy fails open), the session reaches UserPromptSubmit with none of them.
 * The old backfill there created the session row only, so session.taskId and
 * session.projectId stayed "", SessionEnd enqueued the extraction item with
 * task_id and project_id null, and every concept extracted from the session
 * was written without derived_from or relevant_to edges: 1,570 of the 1,959
 * daemon-extracted concepts on the live graph were such islands on
 * 2026-10-31, including 381 of the 445 written in the preceding two weeks.
 *
 * This bootstrap is idempotent and shared by both hooks: it fills whatever is
 * missing on the SessionState and leaves what is already set alone.
 */
import type { SurrealStore } from "./surreal.js";
import type { SessionState } from "./state.js";
import { swallow } from "./errors.js";
import { log } from "./log.js";

/** Last path segment of the working directory, either separator. */
export function projectNameFromCwd(cwd: string | undefined | null): string {
  if (!cwd) return "unknown";
  const parts = cwd.split(/[\\/]/).filter(Boolean);
  return parts[parts.length - 1] ?? "unknown";
}

export interface PillarBootstrapResult {
  /** Which pillars this call created or resolved: subset of agent, project, task, session. */
  filled: string[];
}

type PillarStore = Pick<
  SurrealStore,
  | "ensureAgent" | "ensureProject" | "createTask" | "ensureSessionRow"
  | "linkAgentToProject" | "linkAgentToTask" | "linkTaskToProject"
  | "linkSessionToTask" | "markSessionActive"
>;

export async function ensureSessionPillars(
  store: PillarStore,
  session: SessionState,
  cwd: string | undefined,
  opts: { logTag?: string } = {},
): Promise<PillarBootstrapResult> {
  const tag = opts.logTag ?? "sessionPillars";
  const filled: string[] = [];
  const projectName = projectNameFromCwd(cwd);

  if (!session.agentId) {
    session.agentId = await store.ensureAgent("sould", "claude");
    filled.push("agent");
  }
  if (!session.projectId) {
    session.projectId = await store.ensureProject(projectName);
    filled.push("project");
  }
  if (session.agentId && session.projectId) {
    // Idempotent: linkAgentToProject goes through relate(), which treats the
    // UNIQUE (in,out) collision as "already linked".
    await store.linkAgentToProject(session.agentId, session.projectId)
      .catch((e) => swallow.warn(`${tag}:linkAgentToProject`, e));
  }

  let taskCreated = false;
  if (!session.taskId) {
    session.taskId = await store.createTask(`Session in ${projectName}`, session.projectId || undefined);
    if (session.taskId) {
      taskCreated = true;
      filled.push("task");
      if (session.agentId) {
        await store.linkAgentToTask(session.agentId, session.taskId)
          .catch((e) => swallow.warn(`${tag}:linkAgentToTask`, e));
      }
      if (session.projectId) {
        await store.linkTaskToProject(session.taskId, session.projectId)
          .catch((e) => swallow.warn(`${tag}:linkTaskToProject`, e));
      }
    }
  }

  let sessionCreated = false;
  if (!session.surrealSessionId) {
    // ensureSessionRow finds the row for this Claude Code session id or
    // creates it, so a resumed session (no SessionStart refire) reuses its row.
    session.surrealSessionId = await store.ensureSessionRow(
      session.sessionId,
      session.agentId || "default",
      session.projectId || undefined,
    );
    if (session.surrealSessionId) {
      sessionCreated = true;
      filled.push("session");
      await store.markSessionActive(session.surrealSessionId)
        .catch((e) => swallow.warn(`${tag}:markActive`, e));
    } else {
      log.error(`[${tag}] ensureSessionRow returned an empty id for session=${session.sessionId}; downstream commits will lack provenance`);
    }
  } else if (filled.includes("project")) {
    // The session row pre-dates the project (old UserPromptSubmit backfill
    // shape): ensureSessionRow backfills project_id on an existing row.
    await store.ensureSessionRow(session.sessionId, session.agentId || "default", session.projectId)
      .catch((e) => swallow.warn(`${tag}:backfillProject`, e));
  }

  if (session.surrealSessionId && session.taskId && (taskCreated || sessionCreated)) {
    await store.linkSessionToTask(session.surrealSessionId, session.taskId)
      .catch((e) => swallow.warn(`${tag}:linkSessionToTask`, e));
  }

  return { filled };
}
