/**
 * Recall tool — search the persistent memory graph.
 * Ported from souldbrain with SurrealStore/EmbeddingService injection.
 */
import type { GlobalPluginState, SessionState } from "../state.js";
import type { VectorSearchResult } from "../surreal.js";
/**
 * Formal names that alias rows in `texts` point at.
 *
 * Extraction writes an alias concept as `ALIAS: "the SEO lady" = Kati Henken
 * (Integris Design)`; a hand-written memory reads `Alias: "x" / "y" in his
 * words = Name at Org`. On 2026-10-15 recall("the SEO lady") found nothing
 * although the Kati Henken facts existed, because the nickname and the name
 * never shared a row. When a hit is an alias row, recall runs a second search
 * for the formal name and merges what it finds, marked `via alias`.
 */
export declare function aliasTargetsFrom(texts: string[]): string[];
/** A query that already names the target needs no expansion. */
export declare function queryNamesTarget(query: string, target: string): boolean;
/**
 * Fuse the dense (vector) and lexical (BM25) arms for a deliberate recall.
 *
 * Dense-only recall missed exact names: on 2026-10-09 recall("Burbage") returned
 * none of the three memories containing that word, because a proper name has
 * almost no semantic signal. The lexical arm finds them; RRF puts them in the
 * candidate set on rank alone, so raw BM25 (1 to 15) never meets cosine (0 to 1).
 * A lexical-only row keeps its dense cosine (fulltextSearch with a query vector)
 * as `score`, so the cross-encoder blend downstream stays on one scale.
 *
 * Returns the union, ordered by fused rank, each row carrying `fused`.
 */
export declare function fuseRecallArms(vector: VectorSearchResult[], lexical: VectorSearchResult[]): Array<VectorSearchResult & {
    fused: number;
    lexical?: boolean;
}>;
export declare function createRecallToolDef(state: GlobalPluginState, session: SessionState): {
    name: string;
    label: string;
    description: string;
    parameters: import("@sinclair/typebox").TObject<{
        query: import("@sinclair/typebox").TString;
        scope: import("@sinclair/typebox").TOptional<import("@sinclair/typebox").TUnion<[import("@sinclair/typebox").TLiteral<"all">, import("@sinclair/typebox").TLiteral<"memories">, import("@sinclair/typebox").TLiteral<"concepts">, import("@sinclair/typebox").TLiteral<"turns">, import("@sinclair/typebox").TLiteral<"artifacts">, import("@sinclair/typebox").TLiteral<"skills">, import("@sinclair/typebox").TLiteral<"reflections">]>>;
        limit: import("@sinclair/typebox").TOptional<import("@sinclair/typebox").TNumber>;
    }>;
    execute: (_toolCallId: string, params: {
        query: string;
        scope?: string;
        limit?: number;
    }) => Promise<{
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
            ids: string[];
            neighbor_count?: undefined;
        };
    } | {
        content: {
            type: "text";
            text: string;
        }[];
        details: {
            count: number;
            ids: string[];
            neighbor_count: number;
        };
    }>;
};
