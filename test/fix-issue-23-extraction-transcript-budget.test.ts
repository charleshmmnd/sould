/**
 * Issue #23: coalesced_extraction shipped preamble-only transcripts once the
 * tier-0 preamble exceeded the 30000-char cap, because
 * `transcript.slice(0, 30000 - preamble.length)` went negative and String.slice
 * with a negative end trims from the END. Two items drained 2026-09-08
 * (27 and 14 real turns) reached the extractor with zero turns.
 */
import { describe, it, expect } from "vitest";
import { composeExtractionTranscript, buildDirectivePreamble, EXTRACTION_TRANSCRIPT_CAP, PREAMBLE_SOUL_CHARS, PREAMBLE_RULE_CHARS } from "../src/tools/pending-work.js";

const preamble46k = "ACTIVE RULES (judge compliance against these):\n" + "[rules] x".repeat(5100) + "\n\n---\n\n";
const turns = (n: number) => Array.from({ length: n }, (_, i) => `[user] turn ${i}\n[assistant] reply ${i}`).join("\n");

describe("composeExtractionTranscript (issue #23)", () => {
  it("keeps every turn when the preamble alone exceeds the cap", () => {
    expect(preamble46k.length).toBeGreaterThan(EXTRACTION_TRANSCRIPT_CAP);
    const body = turns(27);
    const out = composeExtractionTranscript(preamble46k, body);
    expect(out.startsWith(preamble46k)).toBe(true);
    expect(out.slice(preamble46k.length)).toBe(body);
  });

  it("never returns a preamble-only payload for a non-empty conversation", () => {
    const out = composeExtractionTranscript(preamble46k, "[user] hi\n[assistant] hello");
    expect(out.length).toBeGreaterThan(preamble46k.length);
    expect(out.endsWith("[assistant] hello")).toBe(true);
  });

  it("keeps the TAIL when the conversation exceeds the cap", () => {
    const body = turns(3000);
    expect(body.length).toBeGreaterThan(EXTRACTION_TRANSCRIPT_CAP);
    const out = composeExtractionTranscript("", body);
    expect(out.endsWith("[assistant] reply 2999")).toBe(true);
    expect(out.startsWith("[... ")).toBe(true);
    expect(out.length).toBeLessThanOrEqual(EXTRACTION_TRANSCRIPT_CAP + 80);
  });

  it("leaves short conversations untouched with a short preamble", () => {
    const out = composeExtractionTranscript("RULES\n\n---\n\n", "[user] a\n[assistant] b");
    expect(out).toBe("RULES\n\n---\n\n[user] a\n[assistant] b");
  });
});

describe("buildDirectivePreamble caps each entry (2026-10-07: three soul rows made a 100 K preamble)", () => {
  it("caps soul rows hard and rules gently, keeps the header and separator", () => {
    const out = buildDirectivePreamble([
      { category: "soul", text: "s".repeat(32_000) },
      { category: "rules", text: "r".repeat(5_000) },
      { category: "rules", text: "short rule." },
    ]);
    expect(out.startsWith("ACTIVE RULES")).toBe(true);
    expect(out.endsWith("\n\n---\n\n")).toBe(true);
    expect(out.length).toBeLessThan(PREAMBLE_SOUL_CHARS + PREAMBLE_RULE_CHARS + 200);
    expect(out).toContain("[rules] short rule.");
  });
  it("returns an empty preamble for no directives", () => {
    expect(buildDirectivePreamble([])).toBe("");
  });
});
