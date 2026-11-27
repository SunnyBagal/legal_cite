import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { CandidateRecord, Reference } from "../core/types.js";
import { createDb } from "../infra/db/client.js";
import { runMigrations } from "../infra/db/migrate.js";
import { existenceVerdicts, papers, resolutionCandidates } from "../infra/db/schema.js";
import type { Resolution } from "./resolve.js";
import { createPaper, getPaperStatus, saveExtraction, saveResolution, setPaperStatus, verdictCounts } from "./store.js";

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
  bibIds = await saveExtraction(db, paperId, { title: "T", references: [ref("b0"), ref("b1")], contexts: [], raw: "<TEI/>" });
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

  it("never rewinds a reported paper, but failure always wins", async () => {
    await setPaperStatus(db, paperId, "reported");
    await setPaperStatus(db, paperId, "resolving");
    expect((await getPaperStatus(db, paperId)).status).toBe("reported");
    await setPaperStatus(db, paperId, "failed", { error: "x" });
    expect((await getPaperStatus(db, paperId)).status).toBe("failed");
  });
});
