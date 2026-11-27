import { readFile } from "node:fs/promises";
import { UnrecoverableError, Worker, type ConnectionOptions, type Job, type WorkerOptions } from "bullmq";
import type { CitationDomain, Extractor } from "../core/types.js";
import type { Db } from "../infra/db/client.js";
import { ingest, pdfPath, type Source } from "./ingest.js";
import { defaultJobOptions, STAGES, type Queues, type Stage, type StageJob } from "./queues.js";
import { resolveReference } from "./resolve.js";
import { getBibEntry, getPaper, saveExtraction, saveResolution, setPaperStatus, toReference } from "./store.js";

export interface PipelineDeps {
  db: Db;
  queues: Queues;
  extractor: Extractor;
  /** Registered citation domains, keyed by Reference.kind. */
  domains: Map<string, CitationDomain>;
}

type Processor = (job: Job<StageJob>, deps: PipelineDeps) => Promise<unknown>;

/** The job's paper, or null when it has already failed (e.g. an interrupted run's leftover jobs). */
async function activePaper(db: Db, paperId: number) {
  const paper = await getPaper(db, paperId);
  return paper.status === "failed" ? null : paper;
}

const processors: Partial<Record<Stage, Processor>> = {
  async ingest(job, { db, queues }) {
    const paper = await activePaper(db, job.data.paperId);
    if (!paper) return { skipped: "paper failed" };
    const source: Source =
      paper.sourceKind === "arxiv" ? { kind: "arxiv", id: paper.source } : { kind: "pdf", path: paper.source };
    const sha = await ingest(source);
    await setPaperStatus(db, paper.id, "ingested", { pdfSha256: sha });
    await queues.queues.extract.add("extract", { paperId: paper.id });
  },

  async extract(job, deps) {
    const { db } = deps;
    const paper = await activePaper(db, job.data.paperId);
    if (!paper) return { skipped: "paper failed" };
    // Scoped to this paper row (createdAt survives DB resets, unlike the id alone).
    const reportJobId = `report-${paper.id}-${paper.createdAt.getTime()}`;
    if (await deps.queues.queues.report.getJob(reportJobId)) {
      // A retry after the flow was created: re-extracting would delete entries it is resolving.
      await setPaperStatus(db, paper.id, "resolving");
      return { skipped: "flow already created" };
    }
    if (!paper.pdfSha256) throw new UnrecoverableError(`paper ${paper.id} has no PDF`);
    const doc = await deps.extractor.extract(await readFile(pdfPath(paper.pdfSha256)));
    // An empty bibliography must not look like "all citations checked".
    if (doc.references.length === 0) throw new UnrecoverableError("no references extracted from the PDF");
    const bibEntryIds = await saveExtraction(db, paper.id, doc);
    await setPaperStatus(db, paper.id, "extracted");

    // Warm caches per domain (e.g. one batched arXiv request); purely an optimization.
    for (const domain of deps.domains.values()) {
      const refs = doc.references.filter((r) => r.kind === domain.kind);
      await domain.prefetch?.(refs).catch((err: unknown) => console.error(`[prefetch ${domain.kind}] ${String(err)}`));
    }
    // "resolving" before the flow exists, so a fast report can't be rewound to it.
    await setPaperStatus(db, paper.id, "resolving");

    // One resolve job per reference, all children of the paper's report job: the report
    // runs once every reference has finished, and a reference whose job fails for good is
    // ignored rather than blocking the report (it shows up without a verdict).
    await deps.queues.flows.add({
      name: "report",
      queueName: "report",
      data: { paperId: paper.id },
      children: bibEntryIds.map((bibEntryId) => ({
        name: "resolve",
        queueName: "resolve",
        data: { paperId: paper.id, bibEntryId },
        opts: { ...defaultJobOptions, ignoreDependencyOnFailure: true },
      })),
      opts: { ...defaultJobOptions, jobId: reportJobId },
    });
    return { references: bibEntryIds.length, contexts: doc.contexts.length };
  },

  async resolve(job, { db, domains }) {
    const paper = await activePaper(db, job.data.paperId);
    if (!paper) return { skipped: "paper failed" };
    const ref = toReference(await getBibEntry(db, job.data.bibEntryId!));
    const domain = domains.get(ref.kind);
    if (!domain) throw new UnrecoverableError(`no citation domain registered for kind "${ref.kind}"`);
    const resolution = await resolveReference(domain, ref);
    // Failed lookups: retry while attempts remain (successful calls are cached, so it's cheap);
    // on the last attempt keep the degraded result, which never says NOT_FOUND.
    if (resolution.degraded && job.attemptsMade + 1 < (job.opts.attempts ?? 1)) {
      const failed = resolution.calls.filter((c) => c.error).map((c) => `${c.resolver}: ${c.error}`);
      throw new Error(`lookups failed, retrying: ${failed.join("; ")}`);
    }
    await saveResolution(db, job.data.bibEntryId!, resolution);
    return { verdict: resolution.result.verdict };
  },

  async report(job, { db }) {
    const paper = await activePaper(db, job.data.paperId);
    if (!paper) return { skipped: "paper failed" };
    await setPaperStatus(db, paper.id, "reported");
  },
};

const WORKER_OPTIONS: Record<Stage, Pick<WorkerOptions, "concurrency" | "limiter">> = {
  // Single connection; arXiv's 15 s crawl delay is enforced in ingest.ts, not here,
  // so local PDFs never wait behind it.
  ingest: { concurrency: 1 },
  extract: { concurrency: 2 },
  // Resolve jobs mostly wait on the per-API queues, which enforce the rate limits;
  // a paper's worth of concurrency keeps fast APIs busy while slow ones drain.
  resolve: { concurrency: 64 },
  relevance: { concurrency: 4 },
  report: { concurrency: 2 },
};

/** Paper-level stages: their final failure fails the paper. Per-reference failures are reported. */
const FATAL_STAGES: ReadonlySet<Stage> = new Set(["ingest", "extract", "report"]);

export function startWorkers(deps: PipelineDeps, connection: ConnectionOptions) {
  const workers = STAGES.flatMap((stage) => {
    const processor = processors[stage];
    if (!processor) return [];
    const worker = new Worker<StageJob>(stage, (job) => processor(job, deps), { connection, ...WORKER_OPTIONS[stage] });
    // Without a listener, a Redis reconnect error would crash the process.
    worker.on("error", (err) => console.error(`[${stage}] worker error: ${err.message}`));
    worker.on("failed", async (job, err) => {
      if (!job || !FATAL_STAGES.has(stage)) return;
      try {
        // Final failure = the job is in the failed set. Covers exhausted attempts,
        // UnrecoverableError and stalled-limit failures alike; retries are "delayed".
        if ((await job.getState()) !== "failed") return;
        await setPaperStatus(deps.db, job.data.paperId, "failed", { error: `${stage}: ${err.message}` });
      } catch (e) {
        console.error(`[${stage}] could not record failure of paper ${job.data.paperId}: ${String(e)}`);
      }
    });
    return [worker];
  });
  return { close: (force = false) => Promise.all(workers.map((w) => w.close(force))) };
}
