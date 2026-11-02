// 0.10.9: venting never retrieves venting.
//
// 2026-11-01 on the live graph, every venting prompt fetched on its swear word
// or its contraction: "fuck the bullshit" retrieved a memory on `fuck`, "thats
// on a machine i built" retrieved five nodes on `thats`, "took it apart and it
// did not cooperate" two on `apart`, "AYoooooooooooooo" and "hahhaha" each one.
// Three retrieval arms kept three copied stopword lists, and the lexical one
// was function words only, so a contraction or a swear was a rare, high-IDF
// term that matched the user's own earlier venting turns. One shared module
// now gates all three arms, a prompt with no signal word skips retrieval, and
// a stored turn with no signal word is never past context.
import { describe, it, expect } from "vitest";
import {
  FUNCTION_STOPWORDS, CONVERSATIONAL_STOPWORDS, TOPIC_STOPWORDS, FTS_STOPWORDS, RATIONALE_STOPWORDS,
  isStretchedToken, isLaughToken, isNoiseWord, extractSignalWords, hasRetrievalSignal,
} from "../src/engine/stopwords.js";
import { extractFtsTerms } from "../src/engine/surreal.js";
import { isEchoOfCurrentPrompt } from "../src/engine/graph-context.js";

const VENTING = [
  "fuck the bullshit",
  "AYoooooooooooooo",
  "AYO",
  "hahhaha",
  "haha",
  "keep going",
  "the word!",
  "NO ONE FUCKING TALKS TO ME",
  "yikes pretty early",
  "POP THE FUCK OFF!!",
];

describe("stopword tiers", () => {
  it("the lexical set is function words plus the conversational tier, and nothing from the topic tier", () => {
    for (const w of FUNCTION_STOPWORDS) expect(FTS_STOPWORDS.has(w)).toBe(true);
    for (const w of CONVERSATIONAL_STOPWORDS) expect(FTS_STOPWORDS.has(w)).toBe(true);
    for (const w of TOPIC_STOPWORDS) {
      if (!FUNCTION_STOPWORDS.has(w) && !CONVERSATIONAL_STOPWORDS.has(w)) expect(FTS_STOPWORDS.has(w), w).toBe(false);
    }
  });
  it("the rationale set is the union of all three", () => {
    for (const w of [...FUNCTION_STOPWORDS, ...CONVERSATIONAL_STOPWORDS, ...TOPIC_STOPWORDS]) expect(RATIONALE_STOPWORDS.has(w)).toBe(true);
  });
  it("names the contractions and swears that drove the 2026-11-01 noise", () => {
    for (const w of ["thats", "fuck", "bullshit", "cause", "im", "dont", "haha", "ayo", "word"]) expect(CONVERSATIONAL_STOPWORDS.has(w), w).toBe(true);
  });
});

describe("sounds and laughs", () => {
  it("a capitalized word is not a technical token, camelCase and separators are", () => {
    expect(extractSignalWords("Wrote 111 lines to the file")).toEqual(["111", "lines", "file"]);
    expect(extractSignalWords("Wrote 111 lines to ~/sould/src/engine/stopwords.ts")).toEqual(["111", "/sould/src/engine/stopwords.ts", "lines"]);
    expect(extractSignalWords("AYoooooooooooooo Hello")).toEqual([]);
    expect(extractSignalWords("call recordFinding on surreal.ts")).toEqual(["recordFinding", "surreal.ts", "call"]);
  });
  it("a stretched token is a sound, a technical token is not", () => {
    expect(isStretchedToken("AYoooooooooooooo")).toBe(true);
    expect(isStretchedToken("nooooo")).toBe(true);
    expect(isStretchedToken("aaa-record")).toBe(false);
    expect(isStretchedToken("v2.0.0")).toBe(false);
    expect(isStretchedToken("bookkeeper")).toBe(false);
  });
  it("a laugh in any spelling", () => {
    for (const t of ["haha", "hahhaha", "ahahah", "HAHAHA", "lol", "lolol", "lmaoo"]) expect(isLaughToken(t), t).toBe(true);
    for (const t of ["hash", "halo", "lola", "hall"]) expect(isLaughToken(t), t).toBe(false);
  });
  it("isNoiseWord folds the set, the stretch and the laugh", () => {
    expect(isNoiseWord("thats", RATIONALE_STOPWORDS)).toBe(true);
    expect(isNoiseWord("hahhaha", FUNCTION_STOPWORDS)).toBe(true);
    expect(isNoiseWord("surrealdb", RATIONALE_STOPWORDS)).toBe(false);
  });
});

describe("extractSignalWords", () => {
  it("returns nothing for every venting prompt from the incident", () => {
    for (const p of VENTING) expect(extractSignalWords(p), p).toEqual([]);
  });
  it("keeps technical tokens first and real words after, deduplicated and capped", () => {
    expect(extractSignalWords("fix the footer on picksbygift/build.py tonight, the footer is wrong")).toEqual(["picksbygift/build.py", "footer"]);
    expect(extractSignalWords("alpha beta gamma delta epsilon zeta eta theta", RATIONALE_STOPWORDS, 3)).toEqual(["alpha", "beta", "gamma"]);
  });
  it("a sentence with ordinary nouns keeps them: the filter is a stoplist, not a mood detector", () => {
    expect(extractSignalWords("thats exactly the flip side and i wouldnt have it otherwise")).toEqual(["flip", "side"]);
  });
  it("a venting prompt that names a thing keeps the thing", () => {
    expect(extractSignalWords("fuck, the cooler screw on quicksilver broke")).toEqual(["cooler", "screw", "quicksilver", "broke"]);
  });
});

describe("hasRetrievalSignal", () => {
  it("is false for venting and acknowledgements", () => {
    for (const p of VENTING) expect(hasRetrievalSignal(p), p).toBe(false);
    expect(hasRetrievalSignal("")).toBe(false);
    expect(hasRetrievalSignal(undefined)).toBe(false);
  });
  it("is true as soon as one topical word appears, three letters or more", () => {
    expect(hasRetrievalSignal("ssh is down")).toBe(true);
    expect(hasRetrievalSignal("remind me to send sergio the october payment text")).toBe(true);
    expect(hasRetrievalSignal("why?")).toBe(false);
    expect(hasRetrievalSignal("why is nginx returning 406?")).toBe(true);
  });
});

describe("lexical arm", () => {
  it("drops the conversational tier and laughs, keeps topic words for IDF", () => {
    expect(extractFtsTerms("fuck the bullshit")).toEqual([]);
    expect(extractFtsTerms("thats on a machine i built hahhaha")).toEqual(["machine", "built"]);
    expect(extractFtsTerms("How does the BGE-M3 reranker work?")).toEqual(["bge-m3", "reranker", "work"]);
  });
});

describe("stored venting turns are never past context", () => {
  const old = new Date(Date.now() - 86_400_000).toISOString();
  it("a turn with no signal word is filtered like an echo", () => {
    for (const p of VENTING) expect(isEchoOfCurrentPrompt({ table: "turn", timestamp: old, text: p }, "anything", Date.now() - 5_000), p).toBe(true);
  });
  it("a turn with a topic still passes, and non-turn rows are never touched", () => {
    expect(isEchoOfCurrentPrompt({ table: "turn", timestamp: old, text: "fix the footer" }, "anything", Date.now() - 5_000)).toBe(false);
    expect(isEchoOfCurrentPrompt({ table: "memory", timestamp: old, text: "haha" }, "anything", Date.now() - 5_000)).toBe(false);
  });
});
