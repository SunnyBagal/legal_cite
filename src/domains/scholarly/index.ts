import type { CitationDomain } from "../../core/types.js";
import type { ApiGateway } from "../../infra/http/gateway.js";
import { scholarlyAbstracts } from "./abstracts.js";
import { arxivIdResolver, arxivSearchResolver } from "./resolvers/arxiv.js";
import { crossrefDoiResolver, crossrefQueryResolver } from "./resolvers/crossref.js";
import { openalexSearchResolver } from "./resolvers/openalex.js";
import { s2MatchResolver } from "./resolvers/semanticScholar.js";
import { scholarlyScorer } from "./scoring.js";

/** Research-paper references: Crossref, Semantic Scholar, OpenAlex and arXiv. */
export function createScholarlyDomain(gw: ApiGateway): CitationDomain {
  return {
    kind: "scholarly",
    resolvers: [
      crossrefDoiResolver(gw),
      arxivIdResolver(gw),
      crossrefQueryResolver(gw),
      s2MatchResolver(gw),
      openalexSearchResolver(gw),
      arxivSearchResolver(gw),
    ],
    scorer: scholarlyScorer,
    abstracts: scholarlyAbstracts(gw),
  };
}
