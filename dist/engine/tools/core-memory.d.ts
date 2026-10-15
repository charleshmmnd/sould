/**
 * Core memory management tool — CRUD on always-loaded directives.
 * Ported from souldbrain with SurrealStore injection.
 */
import type { GlobalPluginState, SessionState } from "../state.js";
import type { CoreMemoryEntry } from "../surreal.js";
export interface Tier0AdmissionResult {
    ok: boolean;
    reason?: "too_long" | "cycle_too_long";
    /** Prompts needed to deliver every tier-0 directive in full once, with the
     *  candidate included (or in its post-update form). */
    cyclePrompts: number;
    /** Characters the full-text cycle carries, soul rows counted as their
     *  delivery window, not their stored length. */
    cycleChars: number;
    /** Full-text budget of one prompt (inline-budget `tier0FullBudgetChars`). */
    budgetChars: number;
    entries: number;
}
/** A full delivery cycle may take at most this many prompts. Beyond it a
 *  directive written today would first reach the model deep into a session,
 *  and after every compaction the model would run that long before seeing
 *  every rule again. */
export declare const MAX_TIER0_CYCLE_PROMPTS = 12;
/** Chars one tier-0 entry costs inside a full-text batch: a soul row is its
 *  rotated window, anything else is capped at the per-item cap. */
export declare function tier0DeliveryChars(e: CoreMemoryEntry): number;
/**
 * Prompts needed to deliver `entries` in full once, under the same rolling
 * plan the hook path runs (`planTier0Delivery`, a fresh delivered set).
 */
export declare function tier0CyclePrompts(entries: CoreMemoryEntry[], budgetChars: number): number;
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
export declare function checkTier0Admission(existing: CoreMemoryEntry[], candidate: CoreMemoryEntry, replacingId?: string, opts?: {
    /** Skip the per-item cap: a priority-only update of a row already in
     *  tier 0 changes nothing about how much of its text is delivered. */
    skipItemCap?: boolean;
}): Tier0AdmissionResult;
/** One line for the add/update acknowledgement so the operator can see the
 *  cycle grow instead of discovering it at the refusal. */
export declare function tier0CycleNote(v: Tier0AdmissionResult): string;
export declare function createCoreMemoryToolDef(state: GlobalPluginState, session: SessionState): {
    name: string;
    label: string;
    description: string;
    parameters: import("@sinclair/typebox").TObject<{
        action: import("@sinclair/typebox").TUnion<[import("@sinclair/typebox").TLiteral<"list">, import("@sinclair/typebox").TLiteral<"add">, import("@sinclair/typebox").TLiteral<"update">, import("@sinclair/typebox").TLiteral<"deactivate">]>;
        tier: import("@sinclair/typebox").TOptional<import("@sinclair/typebox").TNumber>;
        category: import("@sinclair/typebox").TOptional<import("@sinclair/typebox").TString>;
        text: import("@sinclair/typebox").TOptional<import("@sinclair/typebox").TString>;
        priority: import("@sinclair/typebox").TOptional<import("@sinclair/typebox").TNumber>;
        id: import("@sinclair/typebox").TOptional<import("@sinclair/typebox").TString>;
        session_id: import("@sinclair/typebox").TOptional<import("@sinclair/typebox").TString>;
    }>;
    execute: (_toolCallId: string, params: {
        action: "list" | "add" | "update" | "deactivate";
        tier?: number;
        category?: string;
        text?: string;
        priority?: number;
        id?: string;
        session_id?: string;
    }) => Promise<{
        content: {
            type: "text";
            text: string;
        }[];
        details: {
            error: boolean;
            reason: string;
            chars: number;
            cap: number;
            cyclePrompts?: undefined;
            limit?: undefined;
        };
    } | {
        content: {
            type: "text";
            text: string;
        }[];
        details: {
            error: boolean;
            reason: string;
            cyclePrompts: number;
            limit: number;
            chars?: undefined;
            cap?: undefined;
        };
    } | {
        content: {
            type: "text";
            text: string;
        }[];
        details: null;
    } | {
        content: {
            type: "text";
            text: string;
        }[];
        details: {
            count: number;
            error?: undefined;
            reason?: undefined;
            id?: undefined;
        };
    } | {
        content: {
            type: "text";
            text: string;
        }[];
        details: {
            error: boolean;
            reason: string;
            count?: undefined;
            id?: undefined;
        };
    } | {
        content: {
            type: "text";
            text: string;
        }[];
        details: {
            error: boolean;
            count?: undefined;
            reason?: undefined;
            id?: undefined;
        };
    } | {
        content: {
            type: "text";
            text: string;
        }[];
        details: {
            id: string;
            count?: undefined;
            error?: undefined;
            reason?: undefined;
        };
    }>;
};
