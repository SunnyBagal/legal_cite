import { and, asc, eq, inArray, ne } from "drizzle-orm";
import type { ExtractedDocument, Reference } from "../core/types.js";
import type { Db } from "../infra/db/client.js";
import { bibEntries, citationContexts, papers, type PaperStatus } from "../infra/db/schema.js";
import type { Source } from "./ingest.js";

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
 * Move a paper to `status`. Never moves a paper out of "failed" (a stale or duplicate
 * job must not resurrect it); "failed" itself always wins so errors are never lost.
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
    .where(status === "failed" ? eq(papers.id, paperId) : and(eq(papers.id, paperId), ne(papers.status, "failed")));
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
