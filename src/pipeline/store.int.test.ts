import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { CandidateRecord, Reference } from "../core/types.js";
import { createDb } from "../infra/db/client.js";
import { runMigrations } from "../infra/db/migrate.js";
import { citationContexts, existenceVerdicts, papers, relevanceVerdicts, resolutionCandidates } from "../infra/db/schema.js";
import type { Resolution } from "./resolve.js";
import {
  createPaper,
  doneContextIds,
  getExistence,
  getPaperStatus,
  llmVerdictCount,
  relevanceSummary,
  saveExtraction,
  saveRelevance,
  saveResolution,
  setPaperStatus,
  verdictCounts,
} from "./store.js";

// Needs `docker compose up -d` (Postgres). Uses its own paper rows and deletes them afterwards.
const { db, close } = createDb();
let paperId: number;
let bibIds: number[];

const ref = (key: string): Reference => ({ kind: "scholarly", key, title: `Title ${key}`, authors: [], year: 2020, venue: null, doi: null, arxivId: null, ids: {}, raw: null });
const record: CandidateRecord = {
  source: "crossref",
  sourceId: "10.1/x",
  title: "Title b0\u0000",
  authors: [],
  year: 2020,
  venue: null,
  doi: "10.1/x",
  arxivId: null,
  url: null,
  abstract: null,
};
const breakdown = { titleSimilarity: 1, authorOverlap: null, yearDelta: 0, venueMatch: null, identifierMatch: null, total: 0.8 };
const resolution: Resolution = {
  calls: [{ resolver: "crossref-query", candidateCount: 1, error: null, raw: { note: "nul \u0000 byte" } }],
  result: { verdict: "VERIFIED", match: { candidate: record, breakdown }, mismatches: [], scored: [{ candidate: record, breakdown }], reason: "Matched." },
  degraded: false,
};

beforeAll(async () => {
  await runMigrations();
  paperId = await createPaper(db, { kind: "pdf", path: "/tmp/int-test.pdf" }, { relevance: false });
  const context = (key: string, n: number) => ({ referenceKey: key, sentence: `S${n}.`, previousSentence: null, section: null, marker: "[1]", linkedBy: "grobid" as const });
  bibIds = await saveExtraction(db, paperId, { title: "T", references: [ref("b0"), ref("b1")], contexts: [context("b0", 1), context("b0", 2), context("b1", 3)], raw: "<TEI/>" });
});

afterAll(async () => {
  await db.delete(papers).where(eq(papers.id, paperId));
  await close();
});

describe("store (Postgres)", () => {
  it("saveResolution is idempotent, links the matched candidate and survives NUL bytes", async () => {
    await saveResolution(db, bibIds[0]!, resolution);
    await saveResolution(db, bibIds[0]!, resolution);
    const verdicts = await db.select().from(existenceVerdicts).where(eq(existenceVerdicts.bibEntryId, bibIds[0]!));
    const cands = await db.select().from(resolutionCandidates).where(eq(resolutionCandidates.bibEntryId, bibIds[0]!));
    expect(verdicts).toHaveLength(1);
    expect(cands).toHaveLength(1);
    expect(verdicts[0]?.matchedCandidateId).toBe(cands[0]?.id);
    expect(cands[0]?.record.title).toBe("Title b0");
  });

  it("counts references without a verdict as ERROR", async () => {
    expect(await verdictCounts(db, paperId)).toEqual({ VERIFIED: 1, ERROR: 1 });
  });

  it("upserts relevance verdicts with the abstract-level label, and summarizes coverage per context", async () => {
    const ctxs = await db.select().from(citationContexts).where(eq(citationContexts.bibEntryId, bibIds[0]!));
    const r = { verdict: "SUPPORTS" as const, reason: "r", method: "llm" as const, similarity: 0.5, model: "m" };
    await saveRelevance(db, ctxs[0]!.id, r, "T", "crossref:10.1/x");
    await saveRelevance(db, ctxs[0]!.id, r, "T", "crossref:10.1/x");
    const rows = await db.select().from(relevanceVerdicts).where(eq(relevanceVerdicts.citationContextId, ctxs[0]!.id));
    expect(rows).toHaveLength(1);
    expect(rows[0]?.scope).toBe("abstract-level, needs human review");
    expect(await doneContextIds(db, ctxs.map((c) => c.id))).toEqual(new Set([ctxs[0]!.id]));
    expect(await llmVerdictCount(db, paperId)).toBe(1);
    // b0 is VERIFIED with 2 contexts (1 judged); b1 has no verdict, so its context isn't eligible.
    expect(await relevanceSummary(db, paperId)).toMatchObject({ eligible: 2, unjudged: 1, byVerdict: { SUPPORTS: 1 } });
    expect((await getExistence(db, bibIds[1]!))).toBeNull();
  });

  it("never rewinds a reported paper, but failure always wins", async () => {
    await setPaperStatus(db, paperId, "reported");
    await setPaperStatus(db, paperId, "resolving");
    expect((await getPaperStatus(db, paperId)).status).toBe("reported");
    await setPaperStatus(db, paperId, "failed", { error: "x" });
    expect((await getPaperStatus(db, paperId)).status).toBe("failed");
  });
});
