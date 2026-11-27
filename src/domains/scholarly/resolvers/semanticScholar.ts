import type { CandidateRecord, Reference, Resolver, ResolverResult } from "../../../core/types.js";
import { fetchJson, type ApiGateway } from "../../../infra/http/gateway.js";
import { normDoi } from "../scoring.js";
import { authorFromName, searchText } from "./common.js";

const BASE = "https://api.semanticscholar.org/graph/v1";
export const S2_FIELDS = "title,authors,year,venue,externalIds,url,abstract";

export interface S2Paper {
  paperId: string;
  title?: string | null;
  authors?: { name: string }[];
  year?: number | null;
  venue?: string | null;
  externalIds?: { DOI?: string; ArXiv?: string } | null;
  url?: string | null;
  abstract?: string | null;
}

export function s2ToCandidate(p: S2Paper): CandidateRecord {
  return {
    source: "semantic-scholar",
    sourceId: p.paperId,
    title: p.title ?? null,
    authors: (p.authors ?? []).map((a) => authorFromName(a.name)),
    year: p.year ?? null,
    venue: p.venue || null,
    doi: normDoi(p.externalIds?.DOI),
    arxivId: p.externalIds?.ArXiv ?? null,
    url: p.url ?? null,
    abstract: p.abstract ?? null,
  };
}

/** Tier 2: S2's closest-title match (404 = no match, cached as a negative result). */
export function s2MatchResolver(gw: ApiGateway): Resolver {
  return {
    name: "semantic-scholar",
    tier: 2,
    applies: (ref) => Boolean(ref.title),
    async resolve(ref: Reference): Promise<ResolverResult> {
      const url = `${BASE}/paper/search/match?query=${encodeURIComponent(searchText(ref.title!))}&fields=${S2_FIELDS}`;
      const raw = await fetchJson<{ data: S2Paper[] }>(gw, "s2", url);
      return { candidates: (raw?.data ?? []).map(s2ToCandidate), raw };
    },
  };
}
