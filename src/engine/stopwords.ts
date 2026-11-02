// One stopword module for the three places retrieval turns a prompt into terms:
// the lexical (BM25) arm (`extractFtsTerms`), the tag-boost arm
// (`tagBoostedConcepts`) and the RETRIEVAL RATIONALE keyword echo
// (`extractRationaleKeywords`). Until 0.10.9 each kept its own copy, "kept in
// sync" by hand, and the lexical copy was the lightest: function words only.
//
// 2026-11-01, a late-night session on the live graph: every venting prompt
// fetched on its swear word or its contraction. "fuck the bullshit" retrieved
// a memory on `fuck`; "thats on a machine i built" retrieved five nodes on
// `thats`, `machine`, `built`; "took it apart and it did not cooperate"
// retrieved two on `apart`, `cooperate`; "cause it's your soul" retrieved on
// `cause`. BM25's IDF does not save the lexical arm here: contractions without
// apostrophes and interjections are rare in the corpus except in the user's own
// past venting turns, so they rank as high-value terms and match exactly those
// turns. The conversational tier below is the fix; the function tier is the
// old lexical list; the topic tier is the old rationale/tag list of filler
// verbs and nouns, which BM25 handles on its own and so stays out of the
// lexical arm.

/** Function words: articles, pronouns, auxiliaries, prepositions. The old BM25 list. */
export const FUNCTION_STOPWORDS: ReadonlySet<string> = new Set([
  "the","a","an","is","are","was","were","be","been","being","have","has","had","do","does","did",
  "will","would","could","should","can","may","might","shall","to","of","in","for","on","with","at","by",
  "from","as","into","about","between","through","during","and","or","but","if","so","not","no",
  "this","that","these","those","it","its","i","you","we","they","he","she","me","him","her","us","them",
  "my","your","our","their","his","mine","yours","what","which","who","whom","how","when","where","why",
  "all","any","some","more","just","than","then","over","under","such","also","there","here",
  "very","too","much","many","am","up","out","off","own","per",
]);

/**
 * Conversational tier: contractions written without the apostrophe, chat
 * interjections, profanity and acknowledgements. None of these names a topic,
 * and in a graph built from one person's sessions each one matches that
 * person's own earlier chatter and nothing else.
 */
export const CONVERSATIONAL_STOPWORDS: ReadonlySet<string> = new Set([
  // contractions without the apostrophe (the tokenizer strips it)
  "thats","whats","wheres","hows","whos","theres","heres","im","ive","id","ill","youre","youve","youd",
  "youll","hes","shes","theyre","theyve","theyll","weve","wed","well","dont","doesnt","didnt","wont",
  "wouldnt","couldnt","shouldnt","cant","cannot","isnt","arent","wasnt","werent","hasnt","havent",
  "hadnt","lets","aint","gonna","wanna","gotta","cause","cuz","coz","ya","yall",
  // interjections, acknowledgements, chat shorthand
  "haha","hah","hahaha","heh","lol","lmao","lmfao","rofl","omg","wow","yikes","ayo","ayoo","bro","bruh",
  "dude","man","yeah","yea","yep","yup","nope","nah","okay","ok","okey","oh","ooh","ah","aw","hey",
  "hello","hi","hiya","yo","sup","thanks","thank","thx","please","pls","plz","sure","alright","cool",
  "nice","sweet","dope","welp","ugh","hmm","hm","huh","meh","wtf","idk","imo","imho","tbh","btw","fyi",
  "lmk","asap","honestly","literally","seriously","anyway","anyways","whatever","kinda","sorta",
  "gotcha","word","bet","facts","fr","ngl","smh","rn","omw","pop","poppin","popoff","ayy","ayyy",
  // profanity used as emphasis, never as a topic
  "fuck","fucking","fucked","fucker","fuckin","shit","shitty","bullshit","crap","damn","dang","hell",
  "ass","asshole","bitch","piss","pissed","af",
]);

/**
 * Topic tier: filler verbs, adjectives and nouns that appear in almost any
 * prompt ("completely", "incorrect", "search", "context", "thing", "work").
 * Kept out of the lexical arm, where BM25's IDF already down-weights them,
 * and applied to the rationale echo and the tag boost, which have no IDF.
 */
export const TOPIC_STOPWORDS: ReadonlySet<string> = new Set([
  "completely","incorrect","correct","wrong","right","broken","working","missing",
  "really","actually","probably","maybe","perhaps","clearly","obviously","exactly",
  "again","still","even","good","bad","great","fine",
  "basically","mostly","kind","sort","like","want","need","make","made",
  "take","took","give","gave","tell","told","show","shown","said","says","know",
  "knew","think","thought","going","doing","done","got","get","getting","find",
  "found","look","looks","looking","seem","seems","mean","means","meant",
  "feel","feels","felt","guess","hope","hoping","wish","assume","suppose",
  "talk","talks","talked","talking","say","saying","one","ones","nobody","somebody","someone","anyone","everyone",
  "wrote","write","writes","written",
  "pretty","early","late","earlier","lately","ever","never","always","sometimes","often","already","yet",
  "otherwise","likely","unlikely","anyhow","somehow",
  "thing","things","stuff","way","ways","time","times","place","places","part",
  "parts","point","points","case","issue","issues","problem","problems","fix",
  "fixes","bug","bugs","error","errors","change","changes","update","updates",
  "version","versions","question","questions","answer","answers","reason","reasons",
  "context","search","report","reports","check","checks","status","state","states",
  "running","runs","ran","start","started","stop","stopped","keep","kept",
  "work","works","worked","help","helps","helped","needs","needed",
  "wanted","wants","tried","trying","using","used","uses",
  "both","each","every","before","after","above","below","while","other","others",
  "same","different","new","old",
  // chat time words: every prompt has one, none names a topic
  "today","tonight","tomorrow","yesterday","now","later","soon","morning","evening","night",
  "week","weeks","month","months","year","years","day","days","hour","hours","minute","minutes",
  "min","mins",
]);

function union(...sets: ReadonlySet<string>[]): ReadonlySet<string> {
  const out = new Set<string>();
  for (const s of sets) for (const w of s) out.add(w);
  return out;
}

/** Lexical (BM25) arm: function words plus the conversational tier. */
export const FTS_STOPWORDS: ReadonlySet<string> = union(FUNCTION_STOPWORDS, CONVERSATIONAL_STOPWORDS);

/** Rationale echo and tag boost: everything. */
export const RATIONALE_STOPWORDS: ReadonlySet<string> = union(FUNCTION_STOPWORDS, CONVERSATIONAL_STOPWORDS, TOPIC_STOPWORDS);

/**
 * A stretched token ("AYoooooooooooooo", "nooooo", "hahahahaha") is a sound,
 * not a word: any letter run of three or more, in a token with no digit or
 * punctuation, is noise. Technical tokens ("aaa-record", "v2.0.0") keep their
 * shape and never match.
 */
export function isStretchedToken(token: string): boolean {
  return /^[a-z]+$/i.test(token) && /([a-z])\1\1/i.test(token);
}

/** "haha", "hahhaha", "ahahah", "lolol", "lmaoo": a laugh in any spelling. */
export function isLaughToken(token: string): boolean {
  return /^[ha]{4,}$/i.test(token) || /^(lo)+l?$/i.test(token) || /^l(ol)+$/i.test(token) || /^lmao+$/i.test(token);
}

/** True when `word` (already lowercased and de-punctuated) carries no retrieval signal under `set`. */
export function isNoiseWord(word: string, set: ReadonlySet<string>): boolean {
  return set.has(word) || isStretchedToken(word) || isLaughToken(word);
}

/** Tokens that name something: paths, identifiers, versions, camelCase, hyphenated or dotted terms. */
// camelCase (a lowercase letter followed by an uppercase one), an internal
// separator, or a digit. A plain capitalized word ("Wrote", "Hanukkah") is not
// technical; the old rationale regex counted it as one and echoed it.
const TECHNICAL_RE = /[a-z][A-Z]|[a-z0-9]-[a-z0-9]|[a-z0-9]\.[a-z0-9]|[a-z0-9]\/[a-z0-9]|[a-z0-9]_[a-z0-9]|[0-9]/;

/**
 * The words of `text` that could identify a topic: technical-looking tokens
 * first (case kept for display), then plain words of `minLen` or more that
 * are not in `set` and are not a laugh or a stretched sound. Deduplicated in
 * order of appearance, capped at `max`.
 */
export function extractSignalWords(text: string, set: ReadonlySet<string> = RATIONALE_STOPWORDS, max = 6, minLen = 4): string[] {
  const technical: string[] = [];
  const plain: string[] = [];
  for (const raw of (text ?? "").split(/\s+/)) {
    if (raw.length < 3) continue;
    const t = raw.replace(/[^a-zA-Z0-9_./-]/g, "");
    if (t.length >= 3 && TECHNICAL_RE.test(t)) { technical.push(t); continue; }
    // A technical token never doubles as its de-punctuated plain form
    // ("souldsrcenginestopwordsts" beside "/sould/src/engine/stopwords.ts").
    const w = raw.toLowerCase().replace(/[^a-z0-9]/g, "");
    if (w.length >= minLen && !isNoiseWord(w, set)) plain.push(w);
  }
  const seen = new Set<string>();
  const out: string[] = [];
  for (const w of [...technical, ...plain]) {
    const lower = w.toLowerCase();
    if (seen.has(lower)) continue;
    seen.add(lower);
    out.push(w);
    if (out.length >= max) break;
  }
  return out;
}

/**
 * A prompt or a stored turn with no signal word is venting, an acknowledgement
 * or a sound ("fuck the bullshit", "AYoooooo", "keep going", "hahhaha"). Such
 * a prompt has nothing to retrieve on, and such a turn is never useful past
 * context: the daemon distills what mattered about it (the correction, the
 * reflection, the severity) into records that carry a topic and are retrieved
 * on their own.
 */
export function hasRetrievalSignal(text: string | undefined | null): boolean {
  return extractSignalWords(text ?? "", RATIONALE_STOPWORDS, 1, 3).length > 0;
}
