import { DOMParser, XMLSerializer, type Element } from "@xmldom/xmldom";
import type { CandidateRecord, Reference, Resolver, ResolverResult } from "../../../core/types.js";
import type { ApiGateway } from "../../../infra/http/gateway.js";
import { isWebPage, normDoi } from "../scoring.js";
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
      const res = await gw.fetch("arxiv", arxivIdUrl(ref.arxivId!));
      const candidates = res.status === 200 ? parseArxivFeed(res.body).map((c) => ({ ...c, lookup: "arxivId" as const })) : [];
      // arXiv answers an unknown id with an empty feed or an "Error" entry.
      return { candidates, raw: res.body, facts: { "arxiv.exists": candidates.length > 0 } };
    },
  };
}

/** Tier 3: title phrase search (1 request / 3 s, so last resort). */
export function arxivSearchResolver(gw: ApiGateway): Resolver {
  return {
    name: "arxiv-search",
    tier: 3,
    applies: (ref) => Boolean(ref.title) && !isWebPage(ref),
    async resolve(ref: Reference): Promise<ResolverResult> {
      const q = `ti:"${searchText(ref.title!)}"`;
      const res = await gw.fetch("arxiv", `${BASE}?search_query=${encodeURIComponent(q)}&max_results=3`);
      return { candidates: res.status === 200 ? parseArxivFeed(res.body) : [], raw: res.body };
    },
  };
}

const ATOM_OPEN = '<feed xmlns="http://www.w3.org/2005/Atom" xmlns:arxiv="http://arxiv.org/schemas/atom">';
export const arxivIdUrl = (id: string) => `${BASE}?id_list=${encodeURIComponent(id)}`;

/**
 * One id_list request per 50 arXiv ids instead of one request (3 s each) per reference.
 * Each returned entry is primed under its single-id URL, so arxivIdResolver hits the cache.
 * Ids missing from the batch, or a batch arXiv rejects, fall back to single lookups.
 */
export async function prefetchArxivIds(gw: ApiGateway, ids: string[]): Promise<void> {
  const unique = [...new Set(ids)];
  for (let i = 0; i < unique.length; i += 50) {
    const chunk = unique.slice(i, i + 50);
    const res = await gw.fetch("arxiv", `${BASE}?id_list=${chunk.map(encodeURIComponent).join(",")}&max_results=${chunk.length}`);
    if (res.status !== 200) continue;
    const doc = new DOMParser().parseFromString(res.body, "text/xml").documentElement;
    if (!doc) continue;
    const entries = Array.from(doc.getElementsByTagName("entry"));
    for (const entry of entries) {
      const xml = new XMLSerializer().serializeToString(entry);
      const [c] = parseArxivFeed(`${ATOM_OPEN}${xml}</feed>`);
      if (c && chunk.includes(c.arxivId!)) await gw.prime("arxiv", arxivIdUrl(c.arxivId!), { status: 200, body: `${ATOM_OPEN}${xml}</feed>` });
    }
  }
}
