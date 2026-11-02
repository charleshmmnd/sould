/**
 * Budget-aware cross-encoder (2026-11-01).
 *
 * Live daemon.log: 505 graphTransformContext timeouts, every recent one
 * "died in: score-rerank" after vector search and graph expansion had already
 * delivered their nodes. The cross-encoder runs on CPU and scored 30
 * candidates against a 15s transform clock it did not know about, so the
 * last polish step sank the whole result. These tests pin the contract:
 * the rerank gets the time that is left and never more, keeps what it
 * scored, drops queued work whose transform already gave up, and never
 * counts a budget stop as a model timeout.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

type FakeRankingCtx = {
  model: { tokenize: (s: string) => number[] };
  rankAll: (q: number[], docs: number[][]) => Promise<number[]>;
};

function makeFakeCtx(computeMs: number, score = 0.6): { ctx: FakeRankingCtx; calls: () => number } {
  let calls = 0;
  const ctx: FakeRankingCtx = {
    model: { tokenize: (s: string) => Array.from(s, (_c, i) => i + 1) },
    rankAll: async (_q, docs) => {
      calls++;
      await new Promise<void>((r) => setTimeout(r, computeMs));
      return docs.map(() => score);
    },
  };
  return { ctx, calls: () => calls };
}

function candidates(n: number) {
  return Array.from({ length: n }, (_v, i) => ({
    id: `concept:c${i}`,
    text: `candidate number ${i} about the night city walk`,
    finalScore: 0.9 - i * 0.04,
  }));
}

describe("budget-aware rerank", () => {
  let mod: typeof import("../src/engine/graph-context.js");
  const saved: Record<string, string | undefined> = {};

  beforeEach(async () => {
    for (const k of ["SOULD_RERANK_TIMEOUT_MS", "SOULD_RERANK_MIN_REMAINING_MS"]) saved[k] = process.env[k];
    process.env.SOULD_RERANK_TIMEOUT_MS = "5000";
    process.env.SOULD_RERANK_MIN_REMAINING_MS = "100";
    vi.resetModules();
    mod = await import("../src/engine/graph-context.js");
    mod._resetRerankBreaker();
    mod._resetRerankBudgetStatsForTest();
  });

  afterEach(() => {
    mod._setRankingCtxForTest(null);
    mod._resetRerankBreaker();
    for (const k of Object.keys(saved)) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
    vi.resetModules();
  });

  it("skips the cross-encoder entirely when less than the minimum budget is left", async () => {
    const { ctx, calls } = makeFakeCtx(50);
    mod._setRankingCtxForTest(ctx as unknown as Parameters<typeof mod._setRankingCtxForTest>[0]);
    const input = candidates(12);
    const out = await mod.rerankResults(input, "night city links", { deadlineAt: Date.now() + 40 });
    expect(calls()).toBe(0);
    expect(out.map((c) => c.id)).toEqual(input.map((c) => c.id));
    for (const c of out) expect(c.band).toBeDefined();
    expect(mod._rerankBudgetStatsForTest().skips).toBe(1);
  });

  it("keeps the chunks it scored and the vector order for the rest when the budget runs out mid-rerank", async () => {
    // 18 candidates = 3 chunks of 6. 200ms per chunk, 500ms budget:
    // chunk 1 (0..200) runs, chunk 2 fits (200+200 <= 500) and runs,
    // chunk 3 would end at 600 and is never started.
    const { ctx, calls } = makeFakeCtx(200);
    mod._setRankingCtxForTest(ctx as unknown as Parameters<typeof mod._setRankingCtxForTest>[0]);
    const input = candidates(18);
    const out = await mod.rerankResults(input, "night city links", { deadlineAt: Date.now() + 500 });
    expect(calls()).toBe(2);
    expect(out).toHaveLength(18);
    const scored = out.filter((c) => c.crossScore !== undefined);
    const unscored = out.filter((c) => c.crossScore === undefined);
    expect(scored).toHaveLength(12);
    expect(unscored).toHaveLength(6);
    for (const c of scored) expect(c.band).toBe("supporting");
    for (const c of unscored) expect(c.band).toBeDefined();
    // the unscored six are the tail of the input, in their original order
    expect(unscored.map((c) => c.id)).toEqual(input.slice(12).map((c) => c.id));
    const stats = mod._rerankBudgetStatsForTest();
    expect(stats.partials).toBe(1);
    expect(stats.chunkMsEwma).toBeGreaterThan(100);
  });

  it("drops a queued job whose deadline passed while it waited, without computing it", async () => {
    const { ctx, calls } = makeFakeCtx(400);
    mod._setRankingCtxForTest(ctx as unknown as Parameters<typeof mod._setRankingCtxForTest>[0]);
    const first = mod.crossEncoderScorePairs("anchor", ["doc one"]);
    const second = mod.crossEncoderScorePairs("anchor", ["doc two"], Date.now() + 200);
    const [a, b] = await Promise.all([first, second]);
    expect(a).not.toBeNull();
    expect(b).toBeNull();
    expect(calls()).toBe(1);
    expect(mod._rerankBudgetStatsForTest().drops).toBe(1);
    const state = mod._rerankBreakerState();
    expect(state.consecutiveTimeouts).toBe(0);
    expect(state.open).toBe(false);
  });

  it("a stop caused by the transform budget never counts toward the breaker", async () => {
    const { ctx } = makeFakeCtx(600);
    mod._setRankingCtxForTest(ctx as unknown as Parameters<typeof mod._setRankingCtxForTest>[0]);
    const r = await mod.crossEncoderScorePairs("anchor", ["slow doc"], Date.now() + 250);
    expect(r).toBeNull();
    expect(mod._rerankBudgetStatsForTest().drops).toBe(1);
    const state = mod._rerankBreakerState();
    expect(state.consecutiveTimeouts).toBe(0);
    expect(state.open).toBe(false);
  });

  it("without a deadline the rerank behaves as before", async () => {
    const { ctx, calls } = makeFakeCtx(20);
    mod._setRankingCtxForTest(ctx as unknown as Parameters<typeof mod._setRankingCtxForTest>[0]);
    const out = await mod.rerankResults(candidates(18), "night city links");
    expect(calls()).toBe(3);
    expect(out).toHaveLength(18);
    for (const c of out) expect(c.crossScore).toBeCloseTo(0.6);
    expect(mod._rerankBudgetStatsForTest()).toMatchObject({ drops: 0, skips: 0, partials: 0 });
  });
});
