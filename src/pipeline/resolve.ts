import type { CandidateRecord, CitationDomain, ExistenceResult, Reference } from "../core/types.js";

export interface ResolverCall {
  resolver: string;
  candidateCount: number;
  error: string | null;
  raw: unknown;
}

export interface Resolution {
  calls: ResolverCall[];
  result: ExistenceResult;
  /** Every applicable lookup failed: the verdict reflects an outage, not the reference. */
  degraded: boolean;
}

/**
 * Run the domain's resolvers tier by tier (lowest first, a tier's resolvers in parallel),
 * pooling candidates and re-scoring after each tier; stop as soon as the scorer says VERIFIED.
 * Existence is decided by the domain's deterministic scorer only.
 */
export async function resolveReference(domain: CitationDomain, ref: Reference): Promise<Resolution> {
  const applicable = domain.resolvers.filter((r) => r.applies(ref));
  const tiers = [...new Set(applicable.map((r) => r.tier))].sort((a, b) => a - b);
  const calls: ResolverCall[] = [];
  const candidates: CandidateRecord[] = [];
  let result = domain.scorer.score(ref, []);

  for (const tier of tiers) {
    const inTier = applicable.filter((r) => r.tier === tier);
    const settled = await Promise.allSettled(inTier.map((r) => r.resolve(ref)));
    settled.forEach((s, i) => {
      const resolver = inTier[i]!.name;
      if (s.status === "fulfilled") {
        candidates.push(...s.value.candidates);
        calls.push({ resolver, candidateCount: s.value.candidates.length, error: null, raw: s.value.raw });
      } else {
        calls.push({ resolver, candidateCount: 0, error: s.reason instanceof Error ? s.reason.message : String(s.reason), raw: null });
      }
    });
    result = domain.scorer.score(ref, candidates);
    if (result.verdict === "VERIFIED") break;
  }

  const degraded = calls.length > 0 && calls.every((c) => c.error !== null);
  if (degraded) {
    const errors = calls.map((c) => `${c.resolver}: ${c.error}`).join("; ");
    result = { ...result, verdict: "AMBIGUOUS", match: null, mismatches: [], reason: `All lookups failed (${errors}), so existence could not be checked.` };
  }
  return { calls, result, degraded };
}
