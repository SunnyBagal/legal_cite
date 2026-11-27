import { and, asc, count, eq, inArray, notInArray } from "drizzle-orm";
import type { ExtractedDocument, Reference } from "../core/types.js";
import type { Db } from "../infra/db/client.js";
import type { RelevanceResult } from "../core/types.js";
import {
  bibEntries,
  citationContexts,
  existenceVerdicts,
  papers,
  relevanceVerdicts,
  resolutionCandidates,
  resolverCalls,
  type PaperStatus,
} from "../infra/db/schema.js";
import type { Source } from "./ingest.js";
import type { Resolution } from "./resolve.js";

export async function createPaper(db: Db, source: Source, options: { relevance: boolean }): Promise<number> {
  const [row] = await db
    .insert(papers)
    .values({
      sourceKind: source.kind,
      source: source.kind === "arxiv" ? source.id : source.path,
      options,
    })
    .returning({ id: papers.id });
  if (!row) throw new Error("insert papers returned nothing");
  return row.id;
}

/** Paper row without the (large) raw TEI column. */
export async function getPaper(db: Db, paperId: number) {
  const row = await db.query.papers.findFirst({ where: eq(papers.id, paperId), columns: { tei: false } });
  if (!row) throw new Error(`paper ${paperId} not found`);
  return row;
}

/** Cheap poll for the CLI: status and error only. */
export async function getPaperStatus(db: Db, paperId: number) {
  const [row] = await db.select({ status: papers.status, error: papers.error }).from(papers).where(eq(papers.id, paperId));
  if (!row) throw new Error(`paper ${paperId} not found`);
  return row;
}

/**
 * Move a paper to `status`. Never moves a paper out of a terminal state ("failed",
 * "reported"): a stale or duplicate job must not resurrect or rewind it. "failed" itself
 * always wins so errors are never lost.
 */
export async function setPaperStatus(
  db: Db,
  paperId: number,
  status: Exclude<PaperStatus, "queued">,
  extra: { pdfSha256?: string; error?: string } = {},
): Promise<void> {
  const terminal = status === "reported" || status === "failed";
  await db
    .update(papers)
    .set({ status, error: null, ...extra, finishedAt: terminal ? new Date() : null })
    .where(status === "failed" ? eq(papers.id, paperId) : and(eq(papers.id, paperId), notInArray(papers.status, ["failed", "reported"])));
}

/**
 * Persist an extraction atomically. Idempotent: a retried extract job replaces the
 * previous extraction for this paper rather than duplicating it.
 * Returns the bib entry ids in reference order.
 */
export async function saveExtraction(db: Db, paperId: number, doc: ExtractedDocument): Promise<number[]> {
  return db.transaction(async (tx) => {
    await tx.delete(bibEntries).where(eq(bibEntries.paperId, paperId)); // cascades to contexts
    await tx.update(papers).set({ tei: doc.raw, title: doc.title }).where(eq(papers.id, paperId));
    if (doc.references.length === 0) return [];

    const inserted = await tx
      .insert(bibEntries)
      .values(
        doc.references.map((r) => ({
          paperId,
          key: r.key,
          kind: r.kind,
          title: r.title,
          authors: r.authors,
          year: r.year,
          venue: r.venue,
          doi: r.doi,
          arxivId: r.arxivId,
          ids: r.ids,
          raw: r.raw,
        })),
      )
      .returning({ id: bibEntries.id, key: bibEntries.key });
    const idByKey = new Map(inserted.map((r) => [r.key, r.id]));

    const contexts = doc.contexts.flatMap((c, ordinal) => {
      const bibEntryId = idByKey.get(c.referenceKey);
      return bibEntryId === undefined
        ? []
        : [
            {
              paperId,
              bibEntryId,
              ordinal,
              sentence: c.sentence,
              previousSentence: c.previousSentence,
              section: c.section,
              marker: c.marker,
              linkedBy: c.linkedBy,
            },
          ];
    });
    if (contexts.length > 0) await tx.insert(citationContexts).values(contexts);

    return doc.references.map((r) => idByKey.get(r.key)!);
  });
}

export async function getBibEntry(db: Db, bibEntryId: number) {
  const row = await db.query.bibEntries.findFirst({ where: eq(bibEntries.id, bibEntryId) });
  if (!row) throw new Error(`bib entry ${bibEntryId} not found`);
  return row;
}

export function toReference(row: typeof bibEntries.$inferSelect): Reference {
  return {
    kind: row.kind,
    key: row.key,
    title: row.title,
    authors: row.authors,
    year: row.year,
    venue: row.venue,
    doi: row.doi,
    arxivId: row.arxivId,
    ids: row.ids,
    raw: row.raw,
  };
}

export async function getContexts(db: Db, bibEntryIds: number[]) {
  if (bibEntryIds.length === 0) return [];
  return db
    .select()
    .from(citationContexts)
    .where(inArray(citationContexts.bibEntryId, bibEntryIds))
    .orderBy(asc(citationContexts.ordinal));
}

/**
 * Persist one reference's resolution atomically: raw resolver calls, every scored candidate
 * (with its breakdown) and the verdict. Idempotent: a retried job replaces the previous one.
 */
/** Postgres rejects U+0000 in text and jsonb; third-party API data occasionally contains it. */
function stripNul<T>(value: T): T {
  return JSON.parse(JSON.stringify(value, (_k, v: unknown) => (typeof v === "string" ? v.replaceAll("\u0000", "") : v))) as T;
}

export async function saveResolution(db: Db, bibEntryId: number, resolution: Resolution): Promise<void> {
  const r = stripNul(resolution);
  await db.transaction(async (tx) => {
    await tx.delete(existenceVerdicts).where(eq(existenceVerdicts.bibEntryId, bibEntryId));
    await tx.delete(resolutionCandidates).where(eq(resolutionCandidates.bibEntryId, bibEntryId));
    await tx.delete(resolverCalls).where(eq(resolverCalls.bibEntryId, bibEntryId));

    if (r.calls.length > 0) {
      await tx.insert(resolverCalls).values(
        r.calls.map((c) => ({ bibEntryId, resolver: c.resolver, candidateCount: c.candidateCount, error: c.error, raw: c.raw ?? null })),
      );
    }
    const inserted =
      r.result.scored.length === 0
        ? []
        : await tx
            .insert(resolutionCandidates)
            .values(
              r.result.scored.map((s, rank) => ({
                bibEntryId,
                source: s.candidate.source,
                sourceId: s.candidate.sourceId,
                rank,
                record: s.candidate,
                scoreTotal: s.breakdown.total,
                breakdown: s.breakdown,
              })),
            )
            .returning({ id: resolutionCandidates.id, source: resolutionCandidates.source, sourceId: resolutionCandidates.sourceId });
    const m = r.result.match?.candidate;
    const matchedCandidateId = m ? (inserted.find((c) => c.source === m.source && c.sourceId === m.sourceId)?.id ?? null) : null;
    await tx.insert(existenceVerdicts).values({
      bibEntryId,
      verdict: r.result.verdict,
      mismatches: r.result.mismatches,
      matchedCandidateId,
      reason: r.result.reason,
      degraded: r.degraded,
    });
  });
}

/** Existence verdict → count for a paper; references without a verdict count as "ERROR". */
export async function verdictCounts(db: Db, paperId: number): Promise<Record<string, number>> {
  const rows = await db
    .select({ verdict: existenceVerdicts.verdict, n: count() })
    .from(bibEntries)
    .leftJoin(existenceVerdicts, eq(existenceVerdicts.bibEntryId, bibEntries.id))
    .where(eq(bibEntries.paperId, paperId))
    .groupBy(existenceVerdicts.verdict);
  return Object.fromEntries(rows.map((r) => [r.verdict ?? "ERROR", r.n]));
}

/** A reference's existence verdict and its matched record (null record if none). */
export async function getExistence(db: Db, bibEntryId: number) {
  const [row] = await db
    .select({ verdict: existenceVerdicts.verdict, record: resolutionCandidates.record })
    .from(existenceVerdicts)
    .leftJoin(resolutionCandidates, eq(resolutionCandidates.id, existenceVerdicts.matchedCandidateId))
    .where(eq(existenceVerdicts.bibEntryId, bibEntryId));
  return row ?? null;
}

/** Upsert one context's relevance verdict (idempotent for retried jobs). */
export async function saveRelevance(db: Db, citationContextId: number, r: RelevanceResult, citedText: string): Promise<void> {
  const values = { citationContextId, verdict: r.verdict, reason: r.reason, method: r.method, similarity: r.similarity, model: r.model, citedText };
  await db
    .insert(relevanceVerdicts)
    .values(stripNul(values))
    .onConflictDoUpdate({ target: relevanceVerdicts.citationContextId, set: stripNul(values) });
}

/** Relevance verdict → count over a paper's citing contexts that got one. */
export async function relevanceCounts(db: Db, paperId: number): Promise<Record<string, number>> {
  const rows = await db
    .select({ verdict: relevanceVerdicts.verdict, n: count() })
    .from(relevanceVerdicts)
    .innerJoin(citationContexts, eq(citationContexts.id, relevanceVerdicts.citationContextId))
    .where(eq(citationContexts.paperId, paperId))
    .groupBy(relevanceVerdicts.verdict);
  return Object.fromEntries(rows.map((r) => [r.verdict, r.n]));
}

/** Every stored candidate record for a reference, best first. */
export async function getCandidateRecords(db: Db, bibEntryId: number) {
  const rows = await db
    .select({ record: resolutionCandidates.record, breakdown: resolutionCandidates.breakdown })
    .from(resolutionCandidates)
    .where(eq(resolutionCandidates.bibEntryId, bibEntryId))
    .orderBy(asc(resolutionCandidates.rank));
  return rows;
}
