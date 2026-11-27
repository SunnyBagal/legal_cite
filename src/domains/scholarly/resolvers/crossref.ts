import type { CandidateRecord, Reference, Resolver, ResolverResult } from "../../../core/types.js";
import { fetchJson, type ApiGateway } from "../../../infra/http/gateway.js";
import { normDoi } from "../scoring.js";
import { arxivIdFromDoi, searchText, stripMarkup } from "./common.js";

const BASE = "https://api.crossref.org";
const SELECT = "DOI,title,author,issued,published-print,published-online,container-title,abstract,type";

export interface CrossrefWork {
  DOI: string;
  title?: string[];
  author?: { given?: string; family?: string; name?: string }[];
  issued?: DateParts;
  "published-print"?: DateParts;
  "published-online"?: DateParts;
  "container-title"?: string[];
  abstract?: string;
}

type DateParts = { "date-parts"?: (number | null)[][] };
const yearOf = (d: DateParts | undefined) => d?.["date-parts"]?.[0]?.[0] ?? null;

export function crossrefToCandidate(w: CrossrefWork): CandidateRecord {
  const doi = normDoi(w.DOI);
  const altYears = [yearOf(w["published-print"]), yearOf(w["published-online"])].filter((y): y is number => y !== null);
  return {
    source: "crossref",
    sourceId: doi ?? w.DOI,
    title: w.title?.[0] ?? null,
    authors: (w.author ?? []).map((a) => {
      const surname = a.family ?? a.name ?? "";
      return { name: [a.given, surname].filter(Boolean).join(" "), surname };
    }),
    year: yearOf(w.issued),
    ...(altYears.length > 0 ? { altYears } : {}),
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
      const doi = normDoi(ref.doi);
      if (!doi) return { candidates: [], raw: null };
      const raw = await fetchJson<{ message: CrossrefWork }>(gw, "crossref-doi", `${BASE}/works/${encodeURIComponent(doi)}`);
      return { candidates: raw ? [{ ...crossrefToCandidate(raw.message), lookup: "doi" as const }] : [], raw };
    },
  };
}

/**
 * Tier 2: bibliographic query, top 5. Sends the raw reference string when available (what
 * query.bibliographic is designed for; it also covers references whose title GROBID lost),
 * else title + first surname + year.
 */
export function crossrefQueryResolver(gw: ApiGateway): Resolver {
  return {
    name: "crossref-query",
    tier: 2,
    applies: (ref) => Boolean(ref.title || ref.raw),
    async resolve(ref: Reference): Promise<ResolverResult> {
      const q = ref.raw
        ? ref.raw.replace(/https?:\/\/\S+/g, " ").replace(/\s+/g, " ").trim().slice(0, 400)
        : [searchText(ref.title!), ref.authors[0]?.surname, ref.year].filter(Boolean).join(" ");
      const url = `${BASE}/works?query.bibliographic=${encodeURIComponent(q)}&rows=5&select=${SELECT}`;
      const raw = await fetchJson<{ message: { items: CrossrefWork[] } }>(gw, "crossref-query", url);
      return { candidates: (raw?.message.items ?? []).map(crossrefToCandidate), raw };
    },
  };
}
