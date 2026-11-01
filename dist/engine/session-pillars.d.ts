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
/** Last path segment of the working directory, either separator. */
export declare function projectNameFromCwd(cwd: string | undefined | null): string;
export interface PillarBootstrapResult {
    /** Which pillars this call created or resolved: subset of agent, project, task, session. */
    filled: string[];
}
type PillarStore = Pick<SurrealStore, "ensureAgent" | "ensureProject" | "createTask" | "ensureSessionRow" | "linkAgentToProject" | "linkAgentToTask" | "linkTaskToProject" | "linkSessionToTask" | "markSessionActive">;
export declare function ensureSessionPillars(store: PillarStore, session: SessionState, cwd: string | undefined, opts?: {
    logTag?: string;
}): Promise<PillarBootstrapResult>;
export {};
