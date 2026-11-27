import type { CandidateRecord, Reference, Resolver, ResolverResult } from "../../../core/types.js";
import { fetchJson, type ApiGateway } from "../../../infra/http/gateway.js";
import { normDoi } from "../scoring.js";
import { arxivIdFromDoi, searchText, stripMarkup } from "./common.js";

const BASE = "https://api.crossref.org";
const SELECT = "DOI,title,author,issued,container-title,abstract,type";

export interface CrossrefWork {
  DOI: string;
  title?: string[];
  author?: { given?: string; family?: string; name?: string }[];
  issued?: { "date-parts"?: (number | null)[][] };
  "container-title"?: string[];
  abstract?: string;
}

export function crossrefToCandidate(w: CrossrefWork): CandidateRecord {
  const doi = normDoi(w.DOI);
  return {
    source: "crossref",
    sourceId: doi ?? w.DOI,
    title: w.title?.[0] ?? null,
    authors: (w.author ?? []).map((a) => {
      const surname = a.family ?? a.name ?? "";
      return { name: [a.given, surname].filter(Boolean).join(" "), surname };
    }),
    year: w.issued?.["date-parts"]?.[0]?.[0] ?? null,
    venue: w["container-title"]?.[0] ?? null,
    doi,
    arxivId: arxivIdFromDoi(doi),
    url: doi ? `https://doi.org/${doi}` : null,
    abstract: stripMarkup(w.abstract),
  };
}

/** Tier 1: look the cited DOI up directly. */
export function crossrefDoiResolver(gw: ApiGateway): Resolver {
  return {
    name: "crossref-doi",
    tier: 1,
    applies: (ref) => Boolean(ref.doi),
    async resolve(ref: Reference): Promise<ResolverResult> {
      const raw = await fetchJson<{ message: CrossrefWork }>(gw, "crossref-doi", `${BASE}/works/${encodeURIComponent(normDoi(ref.doi)!)}`);
      return { candidates: raw ? [crossrefToCandidate(raw.message)] : [], raw };
    },
  };
}

/** Tier 2: bibliographic query (title + first surname + year), top 5. */
export function crossrefQueryResolver(gw: ApiGateway): Resolver {
  return {
    name: "crossref-query",
    tier: 2,
    applies: (ref) => Boolean(ref.title),
    async resolve(ref: Reference): Promise<ResolverResult> {
      const q = [searchText(ref.title!), ref.authors[0]?.surname, ref.year].filter(Boolean).join(" ");
      const url = `${BASE}/works?query.bibliographic=${encodeURIComponent(q)}&rows=5&select=${SELECT}`;
      const raw = await fetchJson<{ message: { items: CrossrefWork[] } }>(gw, "crossref-query", url);
      return { candidates: (raw?.message.items ?? []).map(crossrefToCandidate), raw };
    },
  };
}
