/**
 * Inline budget for hook-injected context (0.10.1).
 *
 * Claude Code persists any hook `additionalContext` above an inline size
 * threshold to a file on disk and hands the model only a 2 KB preview plus
 * the path. Observed live on 2026-10-07: every UserPromptSubmit payload of a
 * mature graph (44 tier-0 directives, ~20 K chars, plus ~10 K of recalled
 * memory, soul and reflections) came back as "Output too large (29-34 KB).
 * Full output saved to: ..." The directives were re-sent in full on every
 * prompt, which is exactly what pushed the payload over the line, so the
 * model saw neither the rules nor the retrieval. Retrieval that lands in a
 * file the model never opens is retrieval that did not happen.
 *
 * Two mechanisms, both pure so they are unit-testable:
 *
 *  1. Rolling tier-0 delivery. Directives are delivered in FULL once per
 *     session, in priority order, in batches that fit `tier0FullBudgetChars`.
 *     Already-delivered directives are re-sent as a one-line digest so every
 *     prompt still carries a reminder of each rule, and the full text stays
 *     in the conversation where it was first injected. PostCompact clears the
 *     delivered set, so the cycle restarts after the model loses its window.
 *
 *  2. A hard ceiling on the assembled payload. If the final string still
 *     exceeds `resolveHookInlineMaxChars()`, the retrieval tail is cut at a
 *     line boundary, any section tag left open is closed, and a marker names
 *     how much was dropped so the loss is visible instead of silent.
 *
 * The harness limit is in the Claude Code client itself: hook output fields
 * are capped per field, and `additionalContext` is capped at 8,000
 * characters; above that the output is persisted to a file instead of
 * being shown. Confirmed live: a 15,973-char payload was persisted after
 * the first cut from 30 K. The default ceiling therefore sits just under
 * 8,000, and the wrapper legend (about 700 chars) is inside it. Override
 * with `SOULD_HOOK_MAX_CHARS` if a future client raises the cap.
 */
/** Default ceiling for one hook payload, in characters. */
export const DEFAULT_HOOK_INLINE_MAX_CHARS = 7_600;
/** Smallest ceiling accepted from the environment; anything lower would not
 *  fit the wrapper legend plus a single directive. */
export const MIN_HOOK_INLINE_MAX_CHARS = 2_000;
/** Share of the ceiling that one prompt may spend on full-text directives. */
export const TIER0_FULL_SHARE = 0.55;
/** At most this many already-delivered directives are re-sent as one-line
 *  reminders per prompt (highest priority first). With an 8 K cap, a digest
 *  of every directive would eat the whole budget on a mature graph; the
 *  full text of the rest is still in the conversation where it was first
 *  injected. */
export const TIER0_DIGEST_MAX = 8;
/** A single directive never occupies more than this in a full-text batch. */
export const TIER0_FULL_ITEM_CAP = 4_000;
/** Length of a digest line for an already-delivered directive. */
export const TIER0_DIGEST_CHARS = 100;
export function resolveHookInlineMaxChars(env = process.env) {
    const raw = Number(env.SOULD_HOOK_MAX_CHARS);
    if (Number.isFinite(raw) && raw >= MIN_HOOK_INLINE_MAX_CHARS)
        return Math.floor(raw);
    return DEFAULT_HOOK_INLINE_MAX_CHARS;
}
export function tier0FullBudgetChars(ceiling) {
    return Math.max(MIN_HOOK_INLINE_MAX_CHARS, Math.round(ceiling * TIER0_FULL_SHARE));
}
/** First sentence of a directive, on one line, capped. The imperative of a
 *  rule is almost always its first sentence ("NEVER ...", "Count, never
 *  sample."), so this is the reminder that costs the least to re-send. */
export function digestLine(text, max = TIER0_DIGEST_CHARS) {
    const flat = text.replace(/\s+/g, " ").trim();
    // Take sentences until the line says something: "NO SPOT-CHECKING." alone
    // is a label, "NO SPOT-CHECKING. Count ALL entries." is a rule.
    const sentences = flat.match(/[^.!?]+[.!?]+(?=\s|$)/g) ?? [flat];
    let line = "";
    for (const s of sentences) {
        line = (line + " " + s.trim()).trim();
        if (line.length >= 24)
            break;
    }
    if (!line)
        line = flat;
    if (line.length > max)
        line = line.slice(0, max - 3).trimEnd() + "...";
    return line;
}
/**
 * Decide which tier-0 entries go out in full on this prompt.
 *
 * `entries` arrive priority DESC from the store. `delivered` is the session's
 * record of ids already sent in full; it is MUTATED to add this prompt's full
 * batch, so the caller passes the session-owned set.
 */
export function planTier0Delivery(entries, delivered, budgetChars) {
    const full = [];
    const digest = [];
    const deferred = [];
    let used = 0;
    for (const e of entries) {
        if (delivered.has(e.id)) {
            digest.push(e);
            continue;
        }
        const text = e.text.length > TIER0_FULL_ITEM_CAP ? e.text.slice(0, TIER0_FULL_ITEM_CAP - 3) + "..." : e.text;
        const cost = text.length + 6;
        if (used + cost > budgetChars && full.length > 0) {
            deferred.push(e);
            continue;
        }
        if (used + cost > budgetChars) {
            // Nothing fits at all (tiny budget): still deliver the top entry so a
            // prompt is never without its highest-priority rule.
            full.push(text === e.text ? e : { ...e, text });
            used += cost;
            delivered.add(e.id);
            continue;
        }
        full.push(text === e.text ? e : { ...e, text });
        used += cost;
        delivered.add(e.id);
    }
    return { full, digest, deferred, usedChars: used, budgetChars };
}
const SECTION_TAGS = ["recalled_memory", "reflection_context", "active_directives", "session_directives", "soul", "sould_pending_work"];
/**
 * Cut `text` down to at most `maxChars`, at a line boundary, closing any
 * section tag the cut left open and appending a one-line marker that names
 * the loss. Returns the input untouched when it already fits.
 */
export function enforceInlineCeiling(text, maxChars) {
    if (text.length <= maxChars)
        return { text, trimmed: 0 };
    const limit = Math.max(0, maxChars);
    // Reserve room for the marker and up to two closing tags.
    const reserve = 160;
    let cutAt = Math.max(0, limit - reserve);
    const nl = text.lastIndexOf("\n", cutAt);
    if (nl > limit * 0.5)
        cutAt = nl;
    let head = text.slice(0, cutAt).trimEnd();
    const closers = [];
    for (const tag of SECTION_TAGS) {
        const opens = (head.match(new RegExp(`<${tag}(?:\\s|>)`, "g")) ?? []).length;
        const closes = (head.match(new RegExp(`</${tag}>`, "g")) ?? []).length;
        if (opens > closes)
            closers.push(`</${tag}>`);
    }
    const trimmed = text.length - head.length;
    const marker = `[sould] ${trimmed} chars trimmed from the tail of this block to stay inline (ceiling ${maxChars}); use recall for more.`;
    head = [head, ...closers, marker].join("\n");
    return { text: head, trimmed };
}
