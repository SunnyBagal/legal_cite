import { sql } from "drizzle-orm";
import {
  bigint,
  boolean,
  check,
  index,
  integer,
  jsonb,
  pgTable,
  real,
  text,
  timestamp,
  uniqueIndex,
} from "drizzle-orm/pg-core";
import type { Author, CandidateRecord, ScoreBreakdown } from "../../core/types.js";

// Conventions (see DECISIONS.md §Data model): bigint identity PKs, text over varchar,
// timestamptz, enums as text + CHECK, every FK indexed, ON DELETE CASCADE from papers down.

const id = () => bigint("id", { mode: "number" }).primaryKey().generatedAlwaysAsIdentity();
const fk = (name: string) => bigint(name, { mode: "number" });
const createdAt = () => timestamp("created_at", { withTimezone: true }).notNull().defaultNow();

/** One row per `citecheck run` (a paper may be run more than once). */
export const papers = pgTable(
  "papers",
  {
    id: id(),
    sourceKind: text("source_kind").notNull(),
    source: text("source").notNull(),
    title: text("title"),
    pdfSha256: text("pdf_sha256"),
    /** Raw GROBID TEI, kept for debugging. */
    tei: text("tei"),
    status: text("status").notNull().default("queued"),
    error: text("error"),
    options: jsonb("options").$type<{ relevance: boolean }>().notNull(),
    createdAt: createdAt(),
    finishedAt: timestamp("finished_at", { withTimezone: true }),
  },
  (t) => [
    check("papers_source_kind_chk", sql`${t.sourceKind} in ('arxiv', 'pdf')`),
    check(
      "papers_status_chk",
      sql`${t.status} in ('queued', 'ingested', 'extracted', 'resolving', 'reported', 'failed')`,
    ),
  ],
);

export const bibEntries = pgTable(
  "bib_entries",
  {
    id: id(),
    paperId: fk("paper_id")
      .notNull()
      .references(() => papers.id, { onDelete: "cascade" }),
    key: text("key").notNull(),
    kind: text("kind").notNull(),
    title: text("title"),
    authors: jsonb("authors").$type<Author[]>().notNull(),
    year: integer("year"),
    venue: text("venue"),
    doi: text("doi"),
    arxivId: text("arxiv_id"),
    ids: jsonb("ids").$type<Record<string, string>>().notNull(),
    raw: text("raw"),
  },
  (t) => [uniqueIndex("bib_entries_paper_key_uq").on(t.paperId, t.key)],
);

export const citationContexts = pgTable(
  "citation_contexts",
  {
    id: id(),
    paperId: fk("paper_id")
      .notNull()
      .references(() => papers.id, { onDelete: "cascade" }),
    bibEntryId: fk("bib_entry_id")
      .notNull()
      .references(() => bibEntries.id, { onDelete: "cascade" }),
    /** Order of appearance in the paper. */
    ordinal: integer("ordinal").notNull(),
    sentence: text("sentence").notNull(),
    previousSentence: text("previous_sentence"),
    section: text("section"),
    marker: text("marker").notNull(),
    linkedBy: text("linked_by").notNull(),
  },
  (t) => [
    index("citation_contexts_paper_idx").on(t.paperId),
    index("citation_contexts_bib_entry_idx").on(t.bibEntryId),
    check("citation_contexts_linked_by_chk", sql`${t.linkedBy} in ('grobid', 'numeric-fallback')`),
  ],
);

/** One row per (bib entry, resolver) attempt: the raw API response or the error. */
export const resolverCalls = pgTable(
  "resolver_calls",
  {
    id: id(),
    bibEntryId: fk("bib_entry_id")
      .notNull()
      .references(() => bibEntries.id, { onDelete: "cascade" }),
    resolver: text("resolver").notNull(),
    candidateCount: integer("candidate_count").notNull(),
    error: text("error"),
    raw: jsonb("raw"),
    createdAt: createdAt(),
  },
  (t) => [index("resolver_calls_bib_entry_idx").on(t.bibEntryId)],
);

export const resolutionCandidates = pgTable(
  "resolution_candidates",
  {
    id: id(),
    bibEntryId: fk("bib_entry_id")
      .notNull()
      .references(() => bibEntries.id, { onDelete: "cascade" }),
    source: text("source").notNull(),
    sourceId: text("source_id").notNull(),
    /** 0 = best. */
    rank: integer("rank").notNull(),
    record: jsonb("record").$type<CandidateRecord>().notNull(),
    scoreTotal: real("score_total").notNull(),
    breakdown: jsonb("breakdown").$type<ScoreBreakdown>().notNull(),
  },
  (t) => [index("resolution_candidates_bib_entry_idx").on(t.bibEntryId, t.rank)],
);

export const existenceVerdicts = pgTable(
  "existence_verdicts",
  {
    id: id(),
    bibEntryId: fk("bib_entry_id")
      .notNull()
      .references(() => bibEntries.id, { onDelete: "cascade" }),
    verdict: text("verdict").notNull(),
    mismatches: text("mismatches").array().notNull(),
    matchedCandidateId: fk("matched_candidate_id").references(() => resolutionCandidates.id, {
      onDelete: "set null",
    }),
    reason: text("reason").notNull(),
    /** True when every applicable resolver errored, so NOT_FOUND may be an outage. */
    degraded: boolean("degraded").notNull().default(false),
    createdAt: createdAt(),
  },
  (t) => [
    uniqueIndex("existence_verdicts_bib_entry_uq").on(t.bibEntryId),
    index("existence_verdicts_matched_candidate_idx").on(t.matchedCandidateId),
    check(
      "existence_verdicts_verdict_chk",
      sql`${t.verdict} in ('VERIFIED', 'MISMATCH', 'NOT_FOUND', 'AMBIGUOUS')`,
    ),
  ],
);

export const relevanceVerdicts = pgTable(
  "relevance_verdicts",
  {
    id: id(),
    citationContextId: fk("citation_context_id")
      .notNull()
      .references(() => citationContexts.id, { onDelete: "cascade" }),
    verdict: text("verdict").notNull(),
    reason: text("reason").notNull(),
    method: text("method").notNull(),
    similarity: real("similarity"),
    model: text("model"),
    /** The cited text the verdict was based on (title + abstract). */
    citedText: text("cited_text"),
    createdAt: createdAt(),
  },
  (t) => [
    uniqueIndex("relevance_verdicts_context_uq").on(t.citationContextId),
    check(
      "relevance_verdicts_verdict_chk",
      sql`${t.verdict} in ('SUPPORTS', 'PARTIAL', 'UNRELATED', 'CANNOT_TELL')`,
    ),
    check("relevance_verdicts_method_chk", sql`${t.method} in ('prefilter', 'llm', 'skipped')`),
  ],
);
