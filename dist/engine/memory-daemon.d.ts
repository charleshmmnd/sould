/**
 * Memory Daemon — extraction logic for incremental knowledge extraction.
 *
 * Contains the prompt building, transcript formatting, and DB write logic
 * used by the daemon manager to extract 9 knowledge types from conversation
 * turns: causal chains, monologue traces, resolved memories, concepts,
 * corrections, preferences, artifacts, decisions, skills.
 *
 * Ported from souldbrain — takes SurrealStore/EmbeddingService as params.
 */
import type { TurnData, PriorExtractions } from "./daemon-types.js";
import type { SurrealStore } from "./surreal.js";
import type { EmbeddingService } from "./embeddings.js";
/** The derived_from target for an extracted concept: the task row, else the
 *  session row. Only record ids qualify; a bare Claude Code session UUID (what
 *  callers pass as `sessionId`) is never returned. `sessionId` is accepted as a
 *  last resort for legacy callers that passed the session RECORD id there. */
export declare function provenanceTarget(taskId?: string | null, surrealSessionId?: string | null, sessionId?: string | null): string | undefined;
export declare function buildSystemPrompt(hasThinking: boolean, hasRetrievedMemories: boolean, prior: PriorExtractions): string;
export declare function buildCoalescedPrompt(hasThinking: boolean, hasRetrievedMemories: boolean, prior: PriorExtractions, includeHandoff: boolean, includeReflection: boolean): string;
export declare function buildTranscript(turns: TurnData[]): string;
export interface ExtractionCounts {
    causal: number;
    monologue: number;
    resolved: number;
    concept: number;
    correction: number;
    preference: number;
    artifact: number;
    decision: number;
    skill: number;
}
export declare function writeExtractionResults(result: Record<string, any>, sessionId: string, store: SurrealStore, embeddings: EmbeddingService, priorState: PriorExtractions, taskId?: string, projectId?: string, turns?: TurnData[], 
/** The session ROW id (`session:...`). `sessionId` above is Claude Code's
 *  session UUID, which keys `source` and memory rows but is not a record. */
surrealSessionId?: string): Promise<ExtractionCounts>;
