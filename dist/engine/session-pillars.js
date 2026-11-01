import { swallow } from "./errors.js";
import { log } from "./log.js";
/** Last path segment of the working directory, either separator. */
export function projectNameFromCwd(cwd) {
    if (!cwd)
        return "unknown";
    const parts = cwd.split(/[\\/]/).filter(Boolean);
    return parts[parts.length - 1] ?? "unknown";
}
export async function ensureSessionPillars(store, session, cwd, opts = {}) {
    const tag = opts.logTag ?? "sessionPillars";
    const filled = [];
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
        session.surrealSessionId = await store.ensureSessionRow(session.sessionId, session.agentId || "default", session.projectId || undefined);
        if (session.surrealSessionId) {
            sessionCreated = true;
            filled.push("session");
            await store.markSessionActive(session.surrealSessionId)
                .catch((e) => swallow.warn(`${tag}:markActive`, e));
        }
        else {
            log.error(`[${tag}] ensureSessionRow returned an empty id for session=${session.sessionId}; downstream commits will lack provenance`);
        }
    }
    else if (filled.includes("project")) {
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
