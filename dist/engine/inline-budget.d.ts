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
 * The exact harness threshold is not published; 29.1 KB payloads were
 * persisted, so the default ceiling sits well below that. Override with
 * `SOULD_HOOK_MAX_CHARS`.
 */
import type { CoreMemoryEntry } from "./surreal.js";
/** Default ceiling for one hook payload, in characters. */
export declare const DEFAULT_HOOK_INLINE_MAX_CHARS = 20000;
/** Smallest ceiling accepted from the environment; anything lower would not
 *  fit the wrapper legend plus a single directive. */
export declare const MIN_HOOK_INLINE_MAX_CHARS = 4000;
/** Share of the ceiling that one prompt may spend on full-text directives. */
export declare const TIER0_FULL_SHARE = 0.6;
/** A single directive never occupies more than this in a full-text batch. */
export declare const TIER0_FULL_ITEM_CAP = 4000;
/** Length of a digest line for an already-delivered directive. */
export declare const TIER0_DIGEST_CHARS = 120;
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
