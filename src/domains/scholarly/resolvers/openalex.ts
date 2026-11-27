import type { CandidateRecord, Reference, Resolver, ResolverResult } from "../../../core/types.js";
import { fetchJson, type ApiGateway } from "../../../infra/http/gateway.js";
import { normDoi } from "../scoring.js";
import { arxivIdFromUrl, authorFromName, searchText } from "./common.js";

const BASE = "https://api.openalex.org";
export const OPENALEX_SELECT = "id,doi,title,authorships,publication_year,primary_location,locations,abstract_inverted_index";

export interface OpenAlexWork {
  id: string;
  doi?: string | null;
  title?: string | null;
  authorships?: { author: { display_name: string } }[];
  publication_year?: number | null;
  primary_location?: { source?: { display_name?: string } | null } | null;
  locations?: { landing_page_url?: string | null }[];
  abstract_inverted_index?: Record<string, number[]> | null;
}

/** OpenAlex ships abstracts as word → positions; rebuild the text. */
export function abstractFromInvertedIndex(index: Record<string, number[]> | null | undefined): string | null {
  if (!index) return null;
  const words: string[] = [];
  for (const [word, positions] of Object.entries(index)) for (const p of positions) words[p] = word;
  const text = words.filter((w) => w !== undefined).join(" ").trim();
  return text || null;
}

export function openalexToCandidate(w: OpenAlexWork): CandidateRecord {
  const doi = normDoi(w.doi);
  return {
    source: "openalex",
    sourceId: w.id.replace("https://openalex.org/", ""),
    title: w.title ?? null,
    authors: (w.authorships ?? []).map((a) => authorFromName(a.author.display_name)),
    year: w.publication_year ?? null,
    venue: w.primary_location?.source?.display_name ?? null,
    doi,
    arxivId: (w.locations ?? []).map((l) => arxivIdFromUrl(l.landing_page_url)).find(Boolean) ?? null,
    url: w.id,
    abstract: abstractFromInvertedIndex(w.abstract_inverted_index),
  };
}

/**
 * Tier 3: title search. Each search costs $0.001 of a $0.10/day keyless budget (100/day),
 * so it only runs for references the cheaper tiers couldn't verify (docs/apis.md §2).
 */
export function openalexSearchResolver(gw: ApiGateway): Resolver {
  return {
    name: "openalex",
    tier: 3,
    applies: (ref) => Boolean(ref.title),
    async resolve(ref: Reference): Promise<ResolverResult> {
      const url = `${BASE}/works?search.title=${encodeURIComponent(searchText(ref.title!))}&per_page=5&select=${OPENALEX_SELECT}`;
      const raw = await fetchJson<{ results: OpenAlexWork[] }>(gw, "openalex", url);
      return { candidates: (raw?.results ?? []).map(openalexToCandidate), raw };
    },
  };
}
