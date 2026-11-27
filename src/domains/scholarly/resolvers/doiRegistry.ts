import type { Reference, Resolver, ResolverResult } from "../../../core/types.js";
import type { ApiGateway } from "../../../infra/http/gateway.js";
import { normDoi } from "../scoring.js";

/**
 * Tier 1: is the cited DOI registered with ANY registration agency (Crossref, DataCite,
 * mEDRA, ...)? The DOI handle API answers responseCode 1 / HTTP 200 for a registered DOI and
 * responseCode 100 / HTTP 404 "Handle Not Found" otherwise (docs/apis.md §6). A Crossref 404
 * alone proves nothing: arXiv and Zenodo DOIs are DataCite DOIs.
 */
export function doiRegistryResolver(gw: ApiGateway): Resolver {
  return {
    name: "doi-registry",
    tier: 1,
    applies: (ref) => normDoi(ref.doi) !== null,
    async resolve(ref: Reference): Promise<ResolverResult> {
      const doi = normDoi(ref.doi)!;
      const res = await gw.fetch("doi", `https://doi.org/api/handles/${encodeURIComponent(doi)}`);
      return { candidates: [], raw: res.status === 200 ? JSON.parse(res.body) : null, facts: { "doi.registered": res.status === 200 } };
    },
  };
}
