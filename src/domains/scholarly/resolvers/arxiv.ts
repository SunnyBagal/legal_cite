import { DOMParser, type Element } from "@xmldom/xmldom";
import type { CandidateRecord, Reference, Resolver, ResolverResult } from "../../../core/types.js";
import type { ApiGateway } from "../../../infra/http/gateway.js";
import { normDoi } from "../scoring.js";
import { arxivIdFromUrl, authorFromName, searchText } from "./common.js";

const BASE = "https://export.arxiv.org/api/query";

/** Parse an arXiv API Atom feed into candidates (arXiv reports bad ids as an "Error" entry). */
export function parseArxivFeed(atom: string): CandidateRecord[] {
  const doc = new DOMParser().parseFromString(atom, "text/xml").documentElement;
  if (!doc) return [];
  const text = (el: Element, tag: string) => el.getElementsByTagName(tag).item(0)?.textContent?.replace(/\s+/g, " ").trim() || null;
  return Array.from(doc.getElementsByTagName("entry")).flatMap((e): CandidateRecord[] => {
    const absUrl = text(e, "id");
    const arxivId = arxivIdFromUrl(absUrl);
    const title = text(e, "title");
    if (!arxivId || !title || title === "Error") return [];
    const year = Number(text(e, "published")?.slice(0, 4)) || null;
    // Last revision year: citing the latest version (vN) is legitimate.
    const updated = Number(text(e, "updated")?.slice(0, 4)) || null;
    return [
      {
        source: "arxiv",
        sourceId: arxivId,
        title,
        authors: Array.from(e.getElementsByTagName("author")).map((a) => authorFromName(text(a, "name") ?? "")),
        year,
        ...(updated && updated !== year ? { altYears: [updated] } : {}),
        venue: text(e, "arxiv:journal_ref") ?? "arXiv",
        doi: normDoi(text(e, "arxiv:doi")),
        arxivId,
        url: `https://arxiv.org/abs/${arxivId}`,
        abstract: text(e, "summary"),
      },
    ];
  });
}

/** Tier 1: look the cited arXiv id up directly. */
export function arxivIdResolver(gw: ApiGateway): Resolver {
  return {
    name: "arxiv-id",
    tier: 1,
    applies: (ref) => Boolean(ref.arxivId),
    async resolve(ref: Reference): Promise<ResolverResult> {
      const res = await gw.fetch("arxiv", `${BASE}?id_list=${encodeURIComponent(ref.arxivId!)}`);
      return { candidates: res.status === 200 ? parseArxivFeed(res.body) : [], raw: res.body };
    },
  };
}

/** Tier 3: title phrase search (1 request / 3 s, so last resort). */
export function arxivSearchResolver(gw: ApiGateway): Resolver {
  return {
    name: "arxiv-search",
    tier: 3,
    applies: (ref) => Boolean(ref.title),
    async resolve(ref: Reference): Promise<ResolverResult> {
      const q = `ti:"${searchText(ref.title!)}"`;
      const res = await gw.fetch("arxiv", `${BASE}?search_query=${encodeURIComponent(q)}&max_results=3`);
      return { candidates: res.status === 200 ? parseArxivFeed(res.body) : [], raw: res.body };
    },
  };
}
