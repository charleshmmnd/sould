/** Function words: articles, pronouns, auxiliaries, prepositions. The old BM25 list. */
export declare const FUNCTION_STOPWORDS: ReadonlySet<string>;
/**
 * Conversational tier: contractions written without the apostrophe, chat
 * interjections, profanity and acknowledgements. None of these names a topic,
 * and in a graph built from one person's sessions each one matches that
 * person's own earlier chatter and nothing else.
 */
export declare const CONVERSATIONAL_STOPWORDS: ReadonlySet<string>;
/**
 * Topic tier: filler verbs, adjectives and nouns that appear in almost any
 * prompt ("completely", "incorrect", "search", "context", "thing", "work").
 * Kept out of the lexical arm, where BM25's IDF already down-weights them,
 * and applied to the rationale echo and the tag boost, which have no IDF.
 */
export declare const TOPIC_STOPWORDS: ReadonlySet<string>;
/** Lexical (BM25) arm: function words plus the conversational tier. */
export declare const FTS_STOPWORDS: ReadonlySet<string>;
/** Rationale echo and tag boost: everything. */
export declare const RATIONALE_STOPWORDS: ReadonlySet<string>;
/**
 * A stretched token ("AYoooooooooooooo", "nooooo", "hahahahaha") is a sound,
 * not a word: any letter run of three or more, in a token with no digit or
 * punctuation, is noise. Technical tokens ("aaa-record", "v2.0.0") keep their
 * shape and never match.
 */
export declare function isStretchedToken(token: string): boolean;
/** "haha", "hahhaha", "ahahah", "lolol", "lmaoo": a laugh in any spelling. */
export declare function isLaughToken(token: string): boolean;
/** True when `word` (already lowercased and de-punctuated) carries no retrieval signal under `set`. */
export declare function isNoiseWord(word: string, set: ReadonlySet<string>): boolean;
/**
 * The words of `text` that could identify a topic: technical-looking tokens
 * first (case kept for display), then plain words of `minLen` or more that
 * are not in `set` and are not a laugh or a stretched sound. Deduplicated in
 * order of appearance, capped at `max`.
 */
export declare function extractSignalWords(text: string, set?: ReadonlySet<string>, max?: number, minLen?: number): string[];
/**
 * A prompt or a stored turn with no signal word is venting, an acknowledgement
 * or a sound ("fuck the bullshit", "AYoooooo", "keep going", "hahhaha"). Such
 * a prompt has nothing to retrieve on, and such a turn is never useful past
 * context: the daemon distills what mattered about it (the correction, the
 * reflection, the severity) into records that carry a topic and are retrieved
 * on their own.
 */
export declare function hasRetrievalSignal(text: string | undefined | null): boolean;
