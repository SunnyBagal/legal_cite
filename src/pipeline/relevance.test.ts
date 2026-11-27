import { describe, expect, it } from "vitest";
import type { CandidateRecord, CitationDomain, RelevanceResult, ScoreBreakdown } from "../core/types.js";
import { judgeReference, type ContextRow } from "./relevance.js";

const rec = (o: Partial<CandidateRecord>): CandidateRecord => ({
  source: "crossref", sourceId: "x", title: "T", authors: [], year: 2020, venue: null, doi: null, arxivId: null, url: null, abstract: null, ...o,
});
const bd = (o: Partial<ScoreBreakdown> = {}): ScoreBreakdown => ({ titleSimilarity: 1, authorOverlap: 1, yearDelta: 0, venueMatch: null, identifierMatch: null, total: 1, ...o });
const ctx = (id: number): ContextRow => ({ id, sentence: `Sentence ${id}.`, previousSentence: null, section: "Intro", marker: "[1]", linkedBy: "grobid" });

function harness(o: {
  fetch?: (r: CandidateRecord) => Promise<string | null>;
  verify?: (abstract: string | null) => Promise<RelevanceResult>;
  budget?: number;
  finalAttempt?: boolean;
} = {}) {
  const saved: { id: number; result: RelevanceResult; source: string | null }[] = [];
  const verified: (string | null)[] = [];
  const domain = {
    abstracts: { fetch: o.fetch ?? (async () => null) },
    sameWork: (b: ScoreBreakdown) => b.titleSimilarity >= 0.9 && (b.authorOverlap ?? 0) >= 0.5,
  } as unknown as CitationDomain;
  const deps = {
    domain,
    verifier: {
      async verify(_c: unknown, cited: { abstract: string | null }) {
        verified.push(cited.abstract);
        return o.verify ? o.verify(cited.abstract) : ({ verdict: "SUPPORTS", reason: "r", method: "llm", similarity: 0.5, model: "m" } as RelevanceResult);
      },
    },
    save: async (id: number, result: RelevanceResult, _cited: string, source: string | null) => void saved.push({ id, result, source }),
    llmCallsLeft: async () => o.budget ?? 100,
    finalAttempt: o.finalAttempt ?? true,
  };
  return { deps, saved, verified };
}

const base = (o: Partial<Parameters<typeof judgeReference>[0]> = {}) => ({
  existence: { verdict: "VERIFIED", record: rec({ sourceId: "m", abstract: null }) },
  entryTitle: "T",
  contexts: [ctx(1), ctx(2)],
  candidates: [],
  doneContextIds: new Set<number>(),
  ...o,
});

describe("judgeReference", () => {
  it("skips references that don't exist (only VERIFIED/MISMATCH are judged)", async () => {
    const h = harness();
    expect(await judgeReference(base({ existence: { verdict: "NOT_FOUND", record: null } }), h.deps)).toMatchObject({ skipped: expect.stringMatching(/NOT_FOUND/) });
    expect(h.saved).toEqual([]);
  });

  it("uses an abstract already stored on another record of the same work before any fetch", async () => {
    let fetched = 0;
    const h = harness({ fetch: async () => (fetched++, "fetched") });
    const candidates = [{ record: rec({ source: "arxiv", sourceId: "a", abstract: "inline arxiv abstract" }), breakdown: bd() }];
    await judgeReference(base({ candidates }), h.deps);
    expect(h.verified).toEqual(["inline arxiv abstract", "inline arxiv abstract"]);
    expect(fetched).toBe(0);
    expect(h.saved[0]?.source).toBe("arxiv:a");
  });

  it("does not borrow an abstract from a same-title record of a different work", async () => {
    const h = harness();
    const candidates = [{ record: rec({ sourceId: "other", abstract: "someone else's" }), breakdown: bd({ authorOverlap: 0, yearDelta: 9 }) }];
    await judgeReference(base({ candidates }), h.deps);
    expect(h.verified).toEqual([null, null]);
  });

  it("skips contexts already judged on an earlier attempt", async () => {
    const h = harness();
    await judgeReference(base({ doneContextIds: new Set([1]) }), h.deps);
    expect(h.saved.map((s) => s.id)).toEqual([2]);
  });

  it("retries (throws) on a failed abstract fetch rather than recording 'no abstract'", async () => {
    const h = harness({ fetch: async () => Promise.reject(new Error("HTTP 503")), finalAttempt: false });
    await expect(judgeReference(base(), h.deps)).rejects.toThrow(/abstract/);
    expect(h.saved).toEqual([]);
  });

  it("on the last attempt, records failures as CANNOT_TELL instead of leaving silent gaps", async () => {
    const h = harness({ verify: async () => Promise.reject(new Error("HTTP 529")), finalAttempt: true });
    await judgeReference(base(), h.deps);
    expect(h.saved.map((s) => [s.result.verdict, s.result.reason])).toEqual([
      ["CANNOT_TELL", expect.stringMatching(/failed.*529/)],
      ["CANNOT_TELL", expect.stringMatching(/failed.*529/)],
    ]);
  });

  it("before the last attempt, saves what succeeded and throws so the rest is retried", async () => {
    let n = 0;
    const h = harness({
      verify: async () => (++n === 1 ? ({ verdict: "SUPPORTS", reason: "r", method: "llm", similarity: 0.5, model: "m" } as RelevanceResult) : Promise.reject(new Error("timeout"))),
      finalAttempt: false,
    });
    await expect(judgeReference(base(), h.deps)).rejects.toThrow(/timeout/);
    expect(h.saved.map((s) => s.id)).toEqual([1]);
  });

  it("stops calling the LLM when the paper's budget is spent", async () => {
    const h = harness({ budget: 0 });
    await judgeReference(base(), h.deps);
    expect(h.verified).toEqual([]);
    expect(h.saved.map((s) => s.result.reason)).toEqual([expect.stringMatching(/budget/), expect.stringMatching(/budget/)]);
  });
});
