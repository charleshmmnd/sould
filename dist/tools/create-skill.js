/**
 * create_skill MCP tool. Writes a skill row into the sould DB as the
 * canonical location for procedural knowledge. Replaces the historical
 * SKILL.md-on-disk authoring path: bodies live in the vector-indexed
 * `skill` table where they are semantically recallable, smaller, and
 * not subject to file-system fragmentation.
 *
 * The skill table is SCHEMALESS, so `body` is stored via commitSkill's
 * `extras` escape hatch alongside the declared `name`, `description`,
 * `steps`, `preconditions`, `postconditions`, `embedding` fields.
 *
 * Embedding target is `${name}: ${description}\n\n${body}` so the full
 * procedural content participates in vector search, not just the title.
 *
 * Dedup: the tool rejects writes with a name that already exists. Use
 * supersede or update directly for changes to an existing skill.
 */
import { commitKnowledge } from "../engine/commit.js";
export async function handleCreateSkill(state, session, args) {
    const name = typeof args.name === "string" ? args.name.trim() : "";
    const description = typeof args.description === "string" ? args.description.trim() : "";
    const body = typeof args.body === "string" ? args.body : "";
    const preconditions = typeof args.preconditions === "string" ? args.preconditions.trim() : undefined;
    const postconditions = typeof args.postconditions === "string" ? args.postconditions.trim() : undefined;
    const stepsArg = args.steps;
    const routine = parseRoutineArgs(args);
    if (routine.error)
        return errText(routine.error);
    if (!name)
        return errText("Error: `name` is required (kebab-case, matches the slash command).");
    if (!description)
        return errText("Error: `description` is required. Used for slash-command suggestion and embedding.");
    if (!body || body.trim().length < 20) {
        return errText("Error: `body` is required and must be at least 20 characters of markdown body.");
    }
    const steps = Array.isArray(stepsArg) ? stepsArg : [];
    const existing = await state.store.queryFirst(`SELECT id FROM skill WHERE name = $name LIMIT 1`, { name });
    if (existing.length > 0) {
        return errText(`Error: a skill named "${name}" already exists (${existing[0].id}). ` +
            `Use a different name, or update the existing row directly via raw SurrealQL ` +
            `if this is a content revision.`);
    }
    const { id, edges } = await commitKnowledge({ store: state.store, embeddings: state.embeddings }, {
        kind: "skill",
        name,
        description,
        steps,
        preconditions,
        postconditions,
        body,
        // v0.7.97 W3-3: tag with `create_skill_tool` so manual MCP-tool
        // authors are distinguishable from causal_graduate auto-gen at
        // query time. Pre-fix, rows landed with source=NONE and showed up
        // as orphans in source-distribution audits (this is the bug that
        // caused me to wrongly archive 6 legitimate skills earlier this
        // turn — including sould-heal-skill-corruption itself).
        source: "create_skill_tool",
        extras: routine.extras,
        embeddingText: `${name}: ${description}\n\n${body}`,
        sessionId: session.sessionId,
    });
    return {
        content: [{
                type: "text",
                text: JSON.stringify({
                    ok: Boolean(id),
                    skill_id: id,
                    name,
                    edges_created: edges,
                    body_length: body.length,
                }, null, 2),
            }],
    };
}
/**
 * Routine flags (0.10.5): `surface_at_session_start` marks a skill to be
 * injected at SessionStart and on the first prompt without a semantic match;
 * `surface_hours` is an optional [from, to) local-hour window.
 */
export function parseRoutineArgs(args) {
    const extras = {};
    if (typeof args.surface_at_session_start === "boolean")
        extras.surface_at_session_start = args.surface_at_session_start;
    if (args.surface_hours !== undefined) {
        const h = args.surface_hours;
        const ok = Array.isArray(h) && h.length === 2 && h.every((n) => Number.isInteger(n) && n >= 0 && n <= 24);
        if (!ok)
            return { error: "Error: `surface_hours` must be [from, to] with integer local hours 0 to 24 (half-open window)." };
        extras.surface_hours = [Number(h[0]), Number(h[1])];
    }
    return { extras: Object.keys(extras).length ? extras : undefined };
}
function errText(text) {
    return { content: [{ type: "text", text }] };
}
