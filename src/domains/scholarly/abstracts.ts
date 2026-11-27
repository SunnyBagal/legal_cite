import type { AbstractFetcher, CandidateRecord } from "../../core/types.js";
import { fetchJson, type ApiGateway } from "../../infra/http/gateway.js";
import { parseArxivFeed } from "./resolvers/arxiv.js";
import { abstractFromInvertedIndex, type OpenAlexWork } from "./resolvers/openalex.js";

/**
 * Abstract of a matched record: the record's own, else OpenAlex by DOI (single-entity
 * lookups are free), else the arXiv API by id. Null when no source has one.
 */
export function scholarlyAbstracts(gw: ApiGateway): AbstractFetcher {
  return {
    async fetch(record: CandidateRecord): Promise<string | null> {
      if (record.abstract) return record.abstract;
      if (record.doi) {
        const url = `https://api.openalex.org/works/doi:${encodeURIComponent(record.doi)}?select=abstract_inverted_index`;
        const w = await fetchJson<Pick<OpenAlexWork, "abstract_inverted_index">>(gw, "openalex", url);
        const text = abstractFromInvertedIndex(w?.abstract_inverted_index);
        if (text) return text;
      }
      if (record.arxivId) {
        const res = await gw.fetch("arxiv", `https://export.arxiv.org/api/query?id_list=${encodeURIComponent(record.arxivId)}`);
        if (res.status === 200) return parseArxivFeed(res.body)[0]?.abstract ?? null;
      }
      return null;
    },
  };
}
