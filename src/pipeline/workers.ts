import { readFile } from "node:fs/promises";
import { Worker, type ConnectionOptions, type Job } from "bullmq";
import type { CitationDomain, Extractor } from "../core/types.js";
import type { Db } from "../infra/db/client.js";
import { ingest, pdfPath, type Source } from "./ingest.js";
import { STAGES, type Queues, type Stage, type StageJob } from "./queues.js";
import { getPaper, saveExtraction, setPaperStatus } from "./store.js";

export interface PipelineDeps {
  db: Db;
  queues: Queues;
  extractor: Extractor;
  /** Registered citation domains, keyed by Reference.kind. */
  domains: Map<string, CitationDomain>;
}

type Processor = (job: Job<StageJob>, deps: PipelineDeps) => Promise<unknown>;

const processors: Partial<Record<Stage, Processor>> = {
  async ingest(job, { db, queues }) {
    const paper = await getPaper(db, job.data.paperId);
    const source: Source =
      paper.sourceKind === "arxiv" ? { kind: "arxiv", id: paper.source } : { kind: "pdf", path: paper.source };
    const sha = await ingest(source);
    await setPaperStatus(db, paper.id, "ingested", { pdfSha256: sha });
    await queues.queues.extract.add("extract", { paperId: paper.id });
  },

  async extract(job, deps) {
    const { db } = deps;
    const paper = await getPaper(db, job.data.paperId);
    if (!paper.pdfSha256) throw new Error(`paper ${paper.id} has no PDF`);
    const doc = await deps.extractor.extract(await readFile(pdfPath(paper.pdfSha256)));
    const bibEntryIds = await saveExtraction(db, paper.id, doc);
    await setPaperStatus(db, paper.id, "extracted");
    return { references: bibEntryIds.length, contexts: doc.contexts.length };
  },
};

const CONCURRENCY: Record<Stage, number> = { ingest: 2, extract: 2, resolve: 8, relevance: 4, report: 2 };

export function startWorkers(deps: PipelineDeps, connection: ConnectionOptions) {
  const workers = STAGES.flatMap((stage) => {
    const processor = processors[stage];
    if (!processor) return [];
    const worker = new Worker<StageJob>(stage, (job) => processor(job, deps), {
      connection,
      concurrency: CONCURRENCY[stage],
    });
    worker.on("failed", async (job, err) => {
      if (!job || job.attemptsMade < (job.opts.attempts ?? 1)) return;
      // Paper-level stages are fatal; per-reference failures are recorded by the report.
      if (stage === "ingest" || stage === "extract" || stage === "report") {
        await setPaperStatus(deps.db, job.data.paperId, "failed", { error: `${stage}: ${err.message}` });
      }
    });
    return [worker];
  });
  return { close: () => Promise.all(workers.map((w) => w.close())) };
}
