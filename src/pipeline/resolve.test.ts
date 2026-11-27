import { describe, expect, it } from "vitest";
import type { CandidateRecord, CitationDomain, Reference, Resolver } from "../core/types.js";
import { scholarlyScorer } from "../domains/scholarly/scoring.js";
import { resolveReference } from "./resolve.js";

const REF: Reference = {
  kind: "scholarly",
  key: "b0",
  title: "Attention is all you need",
  authors: [{ name: "Ashish Vaswani", surname: "Vaswani" }],
  year: 2017,
  venue: null,
  doi: null,
  arxivId: "1706.03762",
  ids: {},
  raw: null,
};
const HIT: CandidateRecord = {
  source: "arxiv",
  sourceId: "1706.03762",
  title: "Attention Is All You Need",
  authors: [{ name: "Ashish Vaswani", surname: "Vaswani" }],
  year: 2017,
  venue: "arXiv",
  doi: null,
  arxivId: "1706.03762",
  url: null,
  abstract: null,
};

function resolver(name: string, tier: number, behaviour: CandidateRecord[] | Error): Resolver & { calls: number } {
  const r = {
    name,
    tier,
    calls: 0,
    applies: () => true,
    async resolve() {
      r.calls++;
      if (behaviour instanceof Error) throw behaviour;
      return { candidates: behaviour, raw: { from: name } };
    },
  };
  return r;
}
const domain = (resolvers: Resolver[]): CitationDomain => ({
  kind: "scholarly",
  resolvers,
  scorer: scholarlyScorer,
  abstracts: { fetch: async () => null },
});

describe("resolveReference", () => {
  it("stops after the first tier that verifies the reference", async () => {
    const t1 = resolver("id", 1, [HIT]);
    const t2 = resolver("search", 2, []);
    const out = await resolveReference(domain([t2, t1]), REF);
    expect(out.result.verdict).toBe("VERIFIED");
    expect(t2.calls).toBe(0);
    expect(out.calls.map((c) => c.resolver)).toEqual(["id"]);
  });

  it("keeps going through tiers while not verified, pooling candidates", async () => {
    const t1 = resolver("id", 1, []);
    const t2 = resolver("search", 2, [HIT]);
    const out = await resolveReference(domain([t1, t2]), REF);
    expect(out.result.verdict).toBe("VERIFIED");
    expect(out.calls.map((c) => [c.resolver, c.candidateCount])).toEqual([["id", 0], ["search", 1]]);
  });

  it("records a failing resolver and still uses the others", async () => {
    const out = await resolveReference(domain([resolver("broken", 1, new Error("HTTP 500")), resolver("ok", 1, [HIT])]), REF);
    expect(out.result.verdict).toBe("VERIFIED");
    expect(out.calls.find((c) => c.resolver === "broken")?.error).toBe("HTTP 500");
    expect(out.degraded).toBe(true);
  });

  it("says AMBIGUOUS (degraded), never NOT_FOUND, when every lookup failed", async () => {
    const out = await resolveReference(domain([resolver("a", 1, new Error("timeout")), resolver("b", 2, new Error("HTTP 429"))]), REF);
    expect(out.result.verdict).toBe("AMBIGUOUS");
    expect(out.degraded).toBe(true);
    expect(out.result.reason).toMatch(/lookups failed \(a, b\)/);
  });

  it("passes resolver facts to the scorer", async () => {
    const withFacts = { ...resolver("registry", 1, []), resolve: async () => ({ candidates: [], raw: null, facts: { "doi.registered": false } }) };
    const out = await resolveReference(domain([withFacts]), { ...REF, title: "Fabricated nonsense about quantum widgets", doi: "10.9999/x" });
    expect(out.result.reason).toMatch(/not registered/);
  });

  it("skips resolvers that don't apply", async () => {
    const r = { ...resolver("doi", 1, [HIT]), applies: () => false };
    const out = await resolveReference(domain([r]), REF);
    expect(out.calls).toEqual([]);
    expect(out.result.verdict).toBe("NOT_FOUND");
  });
});
