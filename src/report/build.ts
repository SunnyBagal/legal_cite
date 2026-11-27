import { asc, eq, inArray } from "drizzle-orm";
import type { CandidateRecord, ExistenceVerdict, MismatchField, RelevanceLabel } from "../core/types.js";
import type { Db } from "../infra/db/client.js";
import { bibEntries, citationContexts, existenceVerdicts, papers, relevanceVerdicts, resolutionCandidates } from "../infra/db/schema.js";
import { VERIFIER_VERSION } from "../relevance/verifier.js";
import { RELEVANCE_NOTICE, type PaperReport, type ReportRecord, type ReportReference } from "./types.js";

const toRecord = (r: CandidateRecord): ReportRecord => ({
  source: r.source,
  sourceId: r.sourceId,
  title: r.title,
  authors: r.authors.map((a) => a.name || a.surname),
  year: r.year,
  venue: r.venue,
  doi: r.doi,
  arxivId: r.arxivId,
  url: r.url ?? (r.doi ? `https://doi.org/${r.doi}` : r.arxivId ? `https://arxiv.org/abs/${r.arxivId}` : null),
});

/** Cited vs found value for a mismatched field, as display strings. */
function mismatchValues(field: MismatchField, cited: ReportReference["cited"], found: CandidateRecord | null) {
  const years = (r: CandidateRecord) => [r.year, ...(r.altYears ?? [])].filter((y) => y != null).join(" / ");
  const pick: Record<MismatchField, [string | null, string | null]> = {
    authors: [cited.authors.join(", ") || null, found ? found.authors.map((a) => a.name || a.surname).join(", ") : null],
    year: [cited.year?.toString() ?? null, found ? years(found) || null : null],
    venue: [cited.venue, found?.venue ?? null],
    doi: [cited.doi, found?.doi ?? null],
    arxivId: [cited.arxivId, found?.arxivId ?? null],
  };
  const [c, f] = pick[field];
  return { field, cited: c, found: f };
}

/** Assemble the whole report for a paper (4 queries). */
export async function loadReport(db: Db, paperId: number): Promise<PaperReport> {
  const paper = await db.query.papers.findFirst({ where: eq(papers.id, paperId), columns: { tei: false } });
  if (!paper) throw new Error(`paper ${paperId} not found`);

  const entries = await db
    .select({ entry: bibEntries, verdict: existenceVerdicts, match: resolutionCandidates.record })
    .from(bibEntries)
    .leftJoin(existenceVerdicts, eq(existenceVerdicts.bibEntryId, bibEntries.id))
    .leftJoin(resolutionCandidates, eq(resolutionCandidates.id, existenceVerdicts.matchedCandidateId))
    .where(eq(bibEntries.paperId, paperId))
    .orderBy(asc(bibEntries.id));
  const contexts = await db.select().from(citationContexts).where(eq(citationContexts.paperId, paperId)).orderBy(asc(citationContexts.ordinal));
  const rel = contexts.length
    ? await db.select().from(relevanceVerdicts).where(inArray(relevanceVerdicts.citationContextId, contexts.map((c) => c.id)))
    : [];
  const relByContext = new Map(rel.map((r) => [r.citationContextId, r]));

  const references: ReportReference[] = entries.map(({ entry, verdict, match }) => {
    const cited = {
      title: entry.title,
      authors: entry.authors.map((a) => a.name || a.surname),
      year: entry.year,
      venue: entry.venue,
      doi: entry.doi,
      arxivId: entry.arxivId,
    };
    return {
      key: entry.key,
      raw: entry.raw,
      cited,
      existence: {
        verdict: (verdict?.verdict as ExistenceVerdict | undefined) ?? "ERROR",
        reason: verdict?.reason ?? "No verdict: the lookup job for this reference did not finish.",
        degraded: verdict?.degraded ?? false,
        mismatches: ((verdict?.mismatches ?? []) as MismatchField[]).map((f) => mismatchValues(f, cited, match)),
        match: match ? toRecord(match) : null,
      },
      contexts: contexts
        .filter((c) => c.bibEntryId === entry.id)
        .map((c) => {
          const r = relByContext.get(c.id);
          return {
            section: c.section,
            marker: c.marker,
            sentence: c.sentence,
            previousSentence: c.previousSentence,
            linkedBy: c.linkedBy,
            relevance: r
              ? { verdict: r.verdict as RelevanceLabel, reason: r.reason, method: r.method, similarity: r.similarity, model: r.model, scope: r.scope }
              : null,
          };
        }),
    };
  });

  const existence: PaperReport["summary"]["existence"] = {};
  for (const r of references) existence[r.existence.verdict] = (existence[r.existence.verdict] ?? 0) + 1;
  let relevance: PaperReport["summary"]["relevance"] = null;
  if (paper.options.relevance) {
    const eligible = references.filter((r) => r.existence.verdict === "VERIFIED" || r.existence.verdict === "MISMATCH").flatMap((r) => r.contexts);
    const verdicts: Partial<Record<RelevanceLabel, number>> = {};
    for (const c of eligible) if (c.relevance) verdicts[c.relevance.verdict] = (verdicts[c.relevance.verdict] ?? 0) + 1;
    relevance = {
      contexts: eligible.length,
      verdicts,
      notJudged: eligible.filter((c) => c.relevance?.method === "skipped").length,
      missing: eligible.filter((c) => !c.relevance).length,
    };
  }

  return {
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    paper: { id: paper.id, sourceKind: paper.sourceKind, source: paper.source, title: paper.title, pdfSha256: paper.pdfSha256 },
    settings: { relevance: paper.options.relevance, llm: paper.options.llm ?? null, verifierVersion: VERIFIER_VERSION },
    summary: { references: references.length, existence, degraded: references.filter((r) => r.existence.degraded).length, relevance },
    relevanceNotice: RELEVANCE_NOTICE,
    references,
  };
}
