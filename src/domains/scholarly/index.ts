import type { CitationDomain } from "../../core/types.js";
import type { ApiGateway } from "../../infra/http/gateway.js";
import { scholarlyAbstracts } from "./abstracts.js";
import { arxivIdResolver, arxivSearchResolver, prefetchArxivIds } from "./resolvers/arxiv.js";
import { crossrefDoiResolver, crossrefQueryResolver } from "./resolvers/crossref.js";
import { doiRegistryResolver } from "./resolvers/doiRegistry.js";
import { openalexSearchResolver } from "./resolvers/openalex.js";
import { s2MatchResolver } from "./resolvers/semanticScholar.js";
import { isSameWorkRecord, scholarlyScorer } from "./scoring.js";

/** Research-paper references: Crossref, Semantic Scholar, OpenAlex and arXiv. */
export function createScholarlyDomain(gw: ApiGateway): CitationDomain {
  return {
    kind: "scholarly",
    prefetch: (refs) => prefetchArxivIds(gw, refs.flatMap((r) => (r.arxivId ? [r.arxivId] : []))),
    resolvers: [
      crossrefDoiResolver(gw),
      doiRegistryResolver(gw),
      arxivIdResolver(gw),
      crossrefQueryResolver(gw),
      s2MatchResolver(gw),
      openalexSearchResolver(gw),
      arxivSearchResolver(gw),
    ],
    scorer: scholarlyScorer,
    abstracts: scholarlyAbstracts(gw),
    sameWork: isSameWorkRecord,
  };
}
