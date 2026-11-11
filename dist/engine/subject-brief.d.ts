import type { SessionState } from "./state.js";
/** The slice of the store the brief needs; the real store and test fakes both fit. */
export interface SubjectBriefStore {
    isAvailable(): boolean;
    queryFirst<T>(sql: string, bindings?: Record<string, unknown>): Promise<T[]>;
}
export declare const SUBJECT_MIN_DF = 2;
/** Ceiling as a share of the memory table, with a floor for small graphs. */
export declare const SUBJECT_MAX_DF_SHARE = 0.014;
export declare const SUBJECT_MAX_DF_FLOOR = 40;
/** @internal test hook */
export declare function _resetSubjectBriefCaches(): void;
/**
 * The text of a tool call that says what the work is about. File bodies are
 * left out on purpose: an Edit that pastes a page of prose would name every
 * noun in it.
 */
export declare function toolInputSubjectText(toolName: string, toolInput: Record<string, unknown> | undefined): string;
/** Words of `text` that could be a subject: letters only, 5 to 24 long, not chatter, not tooling. */
export declare function extractSubjectCandidates(text: string): string[];
export declare function subjectDfCeiling(total: number): number;
/**
 * Called from PreToolUse. Returns the brief text when this tool call names a
 * subject not yet briefed in this session, else null. Never throws.
 */
export declare function buildSubjectBrief(store: SubjectBriefStore, session: SessionState, toolName: string, toolInput: Record<string, unknown> | undefined, now?: number): Promise<string | null>;
/**
 * A prompt with no retrieval signal re-arms subjects briefed two or more user
 * turns ago, so the next tool call that names one is briefed again. Called
 * from UserPromptSubmit before the turn counter moves. The two-turn gap keeps
 * a run of "yes" and "ok" from repeating a brief the model has just read.
 */
export declare function rearmSubjectBriefs(session: SessionState): number;
/** Compaction dropped every brief from the window: start over. */
export declare function resetSubjectBriefs(session: SessionState): void;
