import { describe, it, expect } from "vitest";
import {
  fitByRelevance,
  retrievalBudgetChars,
  tier0FullBudgetChars,
  RETRIEVAL_MIN_BUDGET_CHARS,
  RETRIEVAL_WRAPPER_RESERVE,
  RETRIEVAL_TRAILER_RESERVE,
  DEFAULT_HOOK_INLINE_MAX_CHARS,
} from "../src/engine/inline-budget.js";

describe("fitByRelevance (0.10.18)", () => {
  const cost = (n: { len: number }) => n.len;

  it("keeps everything when it fits", () => {
    const items = [{ len: 100 }, { len: 200 }, { len: 300 }, { len: 50 }];
    const fit = fitByRelevance(items, cost, 1000);
    expect(fit.kept).toEqual(items);
    expect(fit.dropped).toBe(0);
  });

  it("drops from the low-ranked end, never from the head", () => {
    // Best first. A long, loosely related note sits at rank 1; the short
    // exact match sits at rank 2. The old tail cut by section could lose the
    // rank 2 item; a relevance fit keeps both and drops ranks 4 and 5.
    const items = [{ len: 900 }, { len: 60 }, { len: 400 }, { len: 800 }, { len: 700 }];
    const fit = fitByRelevance(items, cost, 1500);
    expect(fit.kept).toEqual(items.slice(0, 3));
    expect(fit.dropped).toBe(2);
  });

  it("returns a prefix, so ranks do not shift", () => {
    // Rank 4 is small enough to fit after rank 3 is refused, but taking it
    // would renumber the list; the fit stops at the first refusal.
    const items = [{ len: 500 }, { len: 500 }, { len: 500 }, { len: 900 }, { len: 10 }];
    const fit = fitByRelevance(items, cost, 1600);
    expect(fit.kept.length).toBe(3);
    expect(fit.kept).toEqual(items.slice(0, 3));
  });

  it("keeps the best three even when they do not fit", () => {
    const items = [{ len: 1000 }, { len: 1000 }, { len: 1000 }, { len: 10 }];
    const fit = fitByRelevance(items, cost, 500);
    expect(fit.kept.length).toBe(3);
    expect(fit.dropped).toBe(1);
  });
});

describe("retrievalBudgetChars (0.10.18)", () => {
  it("is what the ceiling leaves after the directives and the wrapper", () => {
    const b = retrievalBudgetChars(7600, 3000, 0);
    expect(b).toBe(7600 - RETRIEVAL_WRAPPER_RESERVE - 3000);
  });

  it("holds back a bounded amount for skills and reflections", () => {
    const small = retrievalBudgetChars(7600, 1000, 300);
    const large = retrievalBudgetChars(7600, 1000, 5000);
    expect(small).toBe(7600 - RETRIEVAL_WRAPPER_RESERVE - 1000 - 300);
    expect(large).toBe(7600 - RETRIEVAL_WRAPPER_RESERVE - 1000 - RETRIEVAL_TRAILER_RESERVE);
  });

  it("never falls below the floor", () => {
    expect(retrievalBudgetChars(7600, 9000, 5000)).toBe(RETRIEVAL_MIN_BUDGET_CHARS);
  });

  it("still gives the best matches a floor on a prompt that carries a full directive batch", () => {
    const ceiling = DEFAULT_HOOK_INLINE_MAX_CHARS;
    const directives = tier0FullBudgetChars(ceiling) + 1100; // full batch, digest lines, pillars
    expect(retrievalBudgetChars(ceiling, directives, 2000)).toBe(RETRIEVAL_MIN_BUDGET_CHARS);
  });
});
