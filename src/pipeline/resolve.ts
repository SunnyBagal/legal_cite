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
  /** Some lookup failed: the scorer was told, and never turns a failure into NOT_FOUND. */
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
  const facts: Record<string, boolean> = {};
  const context = () => ({ facts, failedResolvers: calls.filter((c) => c.error !== null).map((c) => c.resolver) });
  let result = domain.scorer.score(ref, [], context());

  for (const tier of tiers) {
    const inTier = applicable.filter((r) => r.tier === tier);
    const settled = await Promise.allSettled(inTier.map((r) => r.resolve(ref)));
    settled.forEach((s, i) => {
      const resolver = inTier[i]!.name;
      if (s.status === "fulfilled") {
        candidates.push(...s.value.candidates);
        Object.assign(facts, s.value.facts ?? {});
        calls.push({ resolver, candidateCount: s.value.candidates.length, error: null, raw: s.value.raw });
      } else {
        calls.push({ resolver, candidateCount: 0, error: s.reason instanceof Error ? s.reason.message : String(s.reason), raw: null });
      }
    });
    result = domain.scorer.score(ref, candidates, context());
    if (result.verdict === "VERIFIED") break;
  }

  return { calls, result, degraded: calls.some((c) => c.error !== null) };
}
