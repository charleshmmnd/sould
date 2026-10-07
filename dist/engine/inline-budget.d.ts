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
import type { CoreMemoryEntry } from "./surreal.js";
/** Default ceiling for one hook payload, in characters. */
export declare const DEFAULT_HOOK_INLINE_MAX_CHARS = 7600;
/** Smallest ceiling accepted from the environment; anything lower would not
 *  fit the wrapper legend plus a single directive. */
export declare const MIN_HOOK_INLINE_MAX_CHARS = 2000;
/** Share of the ceiling that one prompt may spend on full-text directives. */
export declare const TIER0_FULL_SHARE = 0.55;
/** At most this many already-delivered directives are re-sent as one-line
 *  reminders per prompt (highest priority first). With an 8 K cap, a digest
 *  of every directive would eat the whole budget on a mature graph; the
 *  full text of the rest is still in the conversation where it was first
 *  injected. */
export declare const TIER0_DIGEST_MAX = 8;
/** A single directive never occupies more than this in a full-text batch. */
export declare const TIER0_FULL_ITEM_CAP = 4000;
/** Length of a digest line for an already-delivered directive. */
export declare const TIER0_DIGEST_CHARS = 100;
/** A soul row holds a whole soul section (15 K to 32 K chars on a mature
 *  graph). It is delivered as one window of this size, rotated the same way
 *  the budgeted render path rotates it (soul-text.ts), never as raw text. */
export declare const TIER0_SOUL_WINDOW_CHARS = 800;
/** Stable string key for an entry. `SELECT *` hands back `id` as a RecordId
 *  object, and two queries yield two distinct objects for the same row, so a
 *  Set keyed on the raw id never matches. This is the bug that made the
 *  first 0.10.1 build re-send the same top batch on every prompt. */
export declare function entryKey(e: CoreMemoryEntry): string;
export declare function resolveHookInlineMaxChars(env?: NodeJS.ProcessEnv): number;
export declare function tier0FullBudgetChars(ceiling: number): number;
/** First sentence of a directive, on one line, capped. The imperative of a
 *  rule is almost always its first sentence ("NEVER ...", "Count, never
 *  sample."), so this is the reminder that costs the least to re-send. */
export declare function digestLine(text: string, max?: number): string;
export interface Tier0Plan {
    /** Delivered in full this prompt (and now recorded in the delivered set). */
    full: CoreMemoryEntry[];
    /** Delivered in full on an earlier prompt this session; digest only. */
    digest: CoreMemoryEntry[];
    /** Not yet delivered and did not fit this prompt; digest now, full later. */
    deferred: CoreMemoryEntry[];
    usedChars: number;
    budgetChars: number;
}
/**
 * Decide which tier-0 entries go out in full on this prompt.
 *
 * `entries` arrive priority DESC from the store. `delivered` is the session's
 * record of ids already sent in full; it is MUTATED to add this prompt's full
 * batch, so the caller passes the session-owned set.
 */
export declare function planTier0Delivery(entries: CoreMemoryEntry[], delivered: Set<string>, budgetChars: number): Tier0Plan;
export interface CeilingResult {
    text: string;
    /** Characters removed from the input, 0 when it already fit. */
    trimmed: number;
}
/**
 * Cut `text` down to at most `maxChars`, at a line boundary, closing any
 * section tag the cut left open and appending a one-line marker that names
 * the loss. Returns the input untouched when it already fits.
 */
export declare function enforceInlineCeiling(text: string, maxChars: number): CeilingResult;
