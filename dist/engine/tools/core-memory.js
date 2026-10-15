/**
 * Core memory management tool — CRUD on always-loaded directives.
 * Ported from souldbrain with SurrealStore injection.
 */
import { Type } from "@sinclair/typebox";
import { stripStructuralTags } from "../sanitize.js";
import { log } from "../log.js";
import { planTier0Delivery, resolveHookInlineMaxChars, tier0FullBudgetChars, TIER0_FULL_ITEM_CAP, TIER0_SOUL_WINDOW_CHARS, } from "../inline-budget.js";
const TIER0_MAX_PER_SESSION = 5;
const tier0WritesPerSession = new Map();
/**
 * Per-state guard so we wire the session-removed cleanup hook exactly once
 * per {@link GlobalPluginState} instance. A WeakSet (not a boolean) so that
 * if the module survives a re-import while a new state is constructed in
 * tests, each fresh state still gets its callback registered; and so old
 * state instances are eligible for GC without leaking entries here.
 *
 * The registered callback deletes the per-session entry from
 * {@link tier0WritesPerSession} on SessionEnd / stale-session reaping, so
 * Claude Code's `sessionId` reuse across SessionEnd→SessionStart cycles no
 * longer bleeds the prior cycle's write count into a fresh session (which
 * was silently capping new tier-0 writes).
 *
 * Known dev-only limitation: under hot-reload (vite-node, ts-node-dev, etc.)
 * this module can be re-imported while the same {@link GlobalPluginState}
 * instance persists. The freshly-loaded module gets a new (empty)
 * `hookedStates` and a new (empty) `tier0WritesPerSession`, so the same
 * state gets a SECOND `onSessionRemoved` registration pointing at the new
 * map. Both registrations fire on session removal; the old registration's
 * `.delete()` against the old map is a no-op (the map is unreachable from
 * the new module's code) so the only cost is one wasted callback firing
 * per session-end per reload generation. This does not affect production —
 * the daemon does not hot-reload — and not in tests, which fully discard
 * the state between runs. We accept this rather than wire a deregister
 * disposer through to module unload, which has no reliable hook in Node.
 */
const hookedStates = new WeakSet();
function ensureSessionRemovedHook(state) {
    if (hookedStates.has(state))
        return;
    hookedStates.add(state);
    state.onSessionRemoved((sessionId) => {
        tier0WritesPerSession.delete(sessionId);
    });
}
/** Sentinel id for an entry that is not in the store yet. Real ids are always
 *  `core_memory:<id>`, so this cannot collide with one. */
const CANDIDATE_ID = "(pending admission)";
/** A full delivery cycle may take at most this many prompts. Beyond it a
 *  directive written today would first reach the model deep into a session,
 *  and after every compaction the model would run that long before seeing
 *  every rule again. */
export const MAX_TIER0_CYCLE_PROMPTS = 12;
/** Chars one tier-0 entry costs inside a full-text batch: a soul row is its
 *  rotated window, anything else is capped at the per-item cap. */
export function tier0DeliveryChars(e) {
    if (e.category === "soul")
        return Math.min(e.text.length, TIER0_SOUL_WINDOW_CHARS) + 6;
    return Math.min(e.text.length, TIER0_FULL_ITEM_CAP) + 6;
}
/**
 * Prompts needed to deliver `entries` in full once, under the same rolling
 * plan the hook path runs (`planTier0Delivery`, a fresh delivered set).
 */
export function tier0CyclePrompts(entries, budgetChars) {
    const delivered = new Set();
    let prompts = 0;
    for (let guard = 0; guard < 10_000; guard++) {
        const plan = planTier0Delivery(entries, delivered, budgetChars);
        if (plan.full.length === 0)
            break;
        prompts++;
        if (plan.deferred.length === 0)
            break;
    }
    return prompts;
}
/**
 * Test a candidate tier-0 entry against the delivery model the hook path
 * actually runs, not against a single-prompt render budget.
 *
 * Since 0.10.1 directives are delivered in full ONCE per session, in priority
 * order, in batches bounded by the harness inline ceiling, and then digested.
 * Nothing is evicted: a new rule only lengthens the cycle. The old check
 * (`applyCoreBudget` against about 22 K chars of model context) refused a
 * short rule on 2026-10-15 because 35 entries already summed past that
 * budget, while the renderer had stopped enforcing it. Two things can still
 * make a write pointless, and only those are refused:
 *
 *  1. The entry is longer than TIER0_FULL_ITEM_CAP (soul rows excepted,
 *     they are windowed): the tail would never reach the model.
 *  2. The full cycle would exceed MAX_TIER0_CYCLE_PROMPTS: every rule gets
 *     through, but too slowly to count as "always loaded".
 *
 * @param existing    active tier-0 entries, as the store returns them
 * @param candidate   the entry being added, or the post-update form of one
 * @param replacingId on update, the id whose current cost the candidate
 *                    replaces; omitted for a fresh add
 */
export function checkTier0Admission(existing, candidate, replacingId, opts = {}) {
    const budgetChars = tier0FullBudgetChars(resolveHookInlineMaxChars());
    const byPriorityDesc = (a, b) => (b.priority ?? 50) - (a.priority ?? 50);
    // String() every id before comparing: SurrealStore.queryFirst does no id
    // normalization, so `e.id` is a surrealdb RecordId OBJECT and a bare `===`
    // against an id string is always false.
    const incumbents = replacingId
        ? existing.filter((e) => String(e.id) !== String(replacingId))
        : [...existing];
    const all = [...incumbents, candidate].sort(byPriorityDesc);
    const cycleChars = all.reduce((n, e) => n + tier0DeliveryChars(e), 0);
    const cyclePrompts = tier0CyclePrompts(all, budgetChars);
    const base = { cyclePrompts, cycleChars, budgetChars, entries: all.length };
    if (!opts.skipItemCap && candidate.category !== "soul" && candidate.text.length > TIER0_FULL_ITEM_CAP) {
        return { ok: false, reason: "too_long", ...base };
    }
    if (cyclePrompts > MAX_TIER0_CYCLE_PROMPTS) {
        return { ok: false, reason: "cycle_too_long", ...base };
    }
    return { ok: true, ...base };
}
/** One line for the add/update acknowledgement so the operator can see the
 *  cycle grow instead of discovering it at the refusal. */
export function tier0CycleNote(v) {
    return `Tier 0 now ${v.entries} entries, ${v.cyclePrompts} prompt${v.cyclePrompts === 1 ? "" : "s"} ` +
        `per full delivery cycle (limit ${MAX_TIER0_CYCLE_PROMPTS}).`;
}
function tier0Refusal(v, candidate, incumbents, subject) {
    const Subject = `${subject[0].toUpperCase()}${subject.slice(1)}`;
    if (v.reason === "too_long") {
        return {
            content: [{ type: "text", text: `Refused: ${subject} is ${candidate.text.length} chars, and a tier-0 directive is delivered in full ` +
                        `only up to ${TIER0_FULL_ITEM_CAP} chars; the rest would never reach the model. Shorten it to the ` +
                        `rule itself, or split the detail into a record_finding memory the rule can point at.` }],
            details: { error: true, reason: "too_long", chars: candidate.text.length, cap: TIER0_FULL_ITEM_CAP },
        };
    }
    const weakest = [...incumbents]
        .sort((a, b) => (a.priority ?? 50) - (b.priority ?? 50))
        .slice(0, 3)
        .map((e) => `${e.id} (p${e.priority}, ${e.text.length} chars)`)
        .join("; ");
    return {
        content: [{ type: "text", text: `Refused: with ${subject} (p${candidate.priority}, ${candidate.text.length} chars) tier 0 would need ` +
                    `${v.cyclePrompts} prompts to deliver every directive in full once; the limit is ` +
                    `${MAX_TIER0_CYCLE_PROMPTS} (${v.cycleChars} chars across ${v.entries} entries, ${v.budgetChars} per prompt). ` +
                    `${Subject} is not evicting anything; the cycle is just too long. Shorten long entries or ` +
                    `deactivate ones no longer needed, lowest priority first: ${weakest}.` }],
        details: { error: true, reason: "cycle_too_long", cyclePrompts: v.cyclePrompts, limit: MAX_TIER0_CYCLE_PROMPTS },
    };
}
const coreMemorySchema = Type.Object({
    action: Type.Union([
        Type.Literal("list"),
        Type.Literal("add"),
        Type.Literal("update"),
        Type.Literal("deactivate"),
    ], { description: "Action to perform on core memory." }),
    tier: Type.Optional(Type.Number({ description: "Filter by tier (0=always loaded, 1=session-pinned). Default: list all." })),
    category: Type.Optional(Type.String({ description: "Category (identity/rules/tools/operations/general)." })),
    text: Type.Optional(Type.String({ description: "Text content for add/update actions." })),
    priority: Type.Optional(Type.Number({ description: "Priority for add/update (higher=loaded first). Default: 50." })),
    id: Type.Optional(Type.String({ description: "Record ID for update/deactivate (e.g. core_memory:abc123)." })),
    session_id: Type.Optional(Type.String({ description: "Session ID for Tier 1 entries." })),
});
export function createCoreMemoryToolDef(state, session) {
    // Idempotent — registers the session-removed cleanup callback exactly
    // once per GlobalPluginState instance. Safe to call on every toolDef
    // construction (and the factory IS called per session/toolset build).
    ensureSessionRemovedHook(state);
    return {
        name: "core_memory",
        label: "Core Memory",
        description: "Manage always-loaded core directives (Tier 0) and session-pinned context (Tier 1). Tier 0 entries are present in EVERY turn — use for identity, rules, tool patterns. Tier 1 entries are pinned for the current session.",
        parameters: coreMemorySchema,
        execute: async (_toolCallId, params) => {
            const { store } = state;
            if (!store.isAvailable()) {
                return { content: [{ type: "text", text: "Database unavailable." }], details: null };
            }
            try {
                switch (params.action) {
                    case "list": {
                        const entries = await store.getAllCoreMemory(params.tier);
                        if (entries.length === 0) {
                            return { content: [{ type: "text", text: "No core memory entries found." }], details: null };
                        }
                        const formatted = entries.map((e, i) => {
                            const sid = e.session_id ? ` session:${e.session_id}` : "";
                            return `${i + 1}. [T${e.tier}/${e.category}/p${e.priority}${sid}] ${e.id}\n   ${e.text.slice(0, 120)}`;
                        }).join("\n\n");
                        const tier0 = entries.filter((e) => e.tier === 0);
                        const cycle = tier0.length
                            ? `\n\nTier 0: ${tier0.length} entries, ${tier0CyclePrompts([...tier0].sort((a, b) => (b.priority ?? 50) - (a.priority ?? 50)), tier0FullBudgetChars(resolveHookInlineMaxChars()))} prompts per full delivery cycle (limit ${MAX_TIER0_CYCLE_PROMPTS}).`
                            : "";
                        return {
                            content: [{ type: "text", text: `${entries.length} core memory entries:\n\n${formatted}${cycle}` }],
                            details: { count: entries.length },
                        };
                    }
                    case "add": {
                        if (!params.text) {
                            return { content: [{ type: "text", text: "Error: 'text' is required for add action." }], details: null };
                        }
                        const tier = params.tier ?? 0;
                        const sanitized = stripStructuralTags(params.text);
                        let cycleNote = "";
                        if (tier === 0) {
                            const sessionWrites = tier0WritesPerSession.get(session.sessionId) ?? 0;
                            if (sessionWrites >= TIER0_MAX_PER_SESSION) {
                                return {
                                    content: [{ type: "text", text: `Tier 0 write limit reached (${TIER0_MAX_PER_SESSION}/session). Use update to modify existing entries or deactivate unused ones first.` }],
                                    details: { error: true, reason: "session_rate_limit" },
                                };
                            }
                            // Admit against the rolling delivery model the hook path runs
                            // (see checkTier0Admission): a new rule lengthens the cycle,
                            // it never evicts.
                            const existing = await store.getAllCoreMemory(0);
                            const candidate = {
                                id: CANDIDATE_ID,
                                text: sanitized,
                                category: stripStructuralTags(params.category ?? "general"),
                                priority: params.priority ?? 50,
                                tier: 0,
                                active: true,
                            };
                            const verdict = checkTier0Admission(existing, candidate);
                            if (!verdict.ok)
                                return tier0Refusal(verdict, candidate, existing, "this entry");
                            cycleNote = " " + tier0CycleNote(verdict);
                            log.warn(`[core-memory] tier-0 write: "${sanitized.slice(0, 120)}..." (session=${session.sessionId})`);
                        }
                        const sid = tier === 1 ? (params.session_id ?? session.sessionId) : undefined;
                        const id = await store.createCoreMemory(sanitized, params.category ?? "general", params.priority ?? 50, tier, sid);
                        if (!id) {
                            return {
                                content: [{ type: "text", text: "FAILED: Core memory entry was not created." }],
                                details: { error: true },
                            };
                        }
                        if (tier === 0) {
                            tier0WritesPerSession.set(session.sessionId, (tier0WritesPerSession.get(session.sessionId) ?? 0) + 1);
                        }
                        // Invalidate cached section so updated content re-injects next turn
                        session.injectedSections.delete(tier === 0 ? "tier0" : "tier1");
                        return {
                            content: [{ type: "text", text: `Created core memory: ${id} (tier ${tier}, ${params.category ?? "general"}, p${params.priority ?? 50}).${cycleNote}` }],
                            details: { id },
                        };
                    }
                    case "update": {
                        if (!params.id) {
                            return { content: [{ type: "text", text: "Error: 'id' is required for update action." }], details: null };
                        }
                        // Check BEFORE writing. An update changes tier-0 cost in two ways
                        // the `add` guard never sees: growing an entry's text, and moving
                        // a row INTO tier 0. Both lengthen the delivery cycle, and a text
                        // past the per-item cap would be cut at delivery.
                        const all = await store.getAllCoreMemory();
                        // String(): rows carry RecordId objects, so `e.id === params.id`
                        // is always false and this guard would never fire (v0.8.5 fix —
                        // the check shipped dead because its tests mocked string ids).
                        const current = all.find((e) => String(e.id) === params.id);
                        const newText = params.text !== undefined ? stripStructuralTags(params.text) : current?.text;
                        const newTier = params.tier ?? current?.tier;
                        let updateNote = "";
                        if (current && newTier === 0 && newText !== undefined) {
                            const tier0 = all.filter((e) => e.tier === 0);
                            const candidate = {
                                ...current,
                                text: newText,
                                category: params.category ?? current.category,
                                priority: params.priority ?? current.priority ?? 50,
                                tier: 0,
                            };
                            const textChanged = params.text !== undefined && newText !== current.text;
                            const enteringTier0 = current.tier !== 0;
                            const verdict = checkTier0Admission(tier0, candidate, current.id, {
                                skipItemCap: !textChanged && !enteringTier0,
                            });
                            if (!verdict.ok) {
                                return tier0Refusal(verdict, candidate, tier0.filter((e) => String(e.id) !== String(current.id)), "this update");
                            }
                            updateNote = " " + tier0CycleNote(verdict);
                        }
                        const fields = {};
                        if (params.text !== undefined) {
                            fields.text = newText;
                            log.warn(`[core-memory] update ${params.id}: "${String(fields.text).slice(0, 120)}..." (session=${session.sessionId})`);
                        }
                        if (params.category !== undefined)
                            fields.category = stripStructuralTags(params.category);
                        if (params.priority !== undefined)
                            fields.priority = params.priority;
                        if (params.tier !== undefined)
                            fields.tier = params.tier;
                        const updated = await store.updateCoreMemory(params.id, fields);
                        if (!updated) {
                            return {
                                content: [{ type: "text", text: `FAILED: Could not update ${params.id}.` }],
                                details: { error: true },
                            };
                        }
                        // Invalidate both tiers — update may have changed the tier
                        session.injectedSections.delete("tier0");
                        session.injectedSections.delete("tier1");
                        return {
                            content: [{ type: "text", text: `Updated core memory: ${params.id}.${updateNote}` }],
                            details: { id: params.id },
                        };
                    }
                    case "deactivate": {
                        if (!params.id) {
                            return { content: [{ type: "text", text: "Error: 'id' is required for deactivate action." }], details: null };
                        }
                        await store.deleteCoreMemory(params.id);
                        // Invalidate both tiers so removal is reflected next turn
                        session.injectedSections.delete("tier0");
                        session.injectedSections.delete("tier1");
                        return {
                            content: [{ type: "text", text: `Deactivated core memory: ${params.id}` }],
                            details: { id: params.id },
                        };
                    }
                }
            }
            catch (err) {
                return { content: [{ type: "text", text: `Core memory operation failed: ${err}` }], details: null };
            }
        },
    };
}
