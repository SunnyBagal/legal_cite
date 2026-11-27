import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { UnrecoverableError, Worker, type ConnectionOptions, type Job, type WorkerOptions } from "bullmq";
import type { CitationDomain, Extractor, RelevanceVerifier } from "../core/types.js";
import type { Db } from "../infra/db/client.js";
import { loadReport } from "../report/build.js";
import type { Reporter } from "../report/types.js";
import { ingest, pdfPath, type Source } from "./ingest.js";
import { defaultJobOptions, STAGES, type Queues, type Stage, type StageJob } from "./queues.js";
import { judgeReference } from "./relevance.js";
import { resolveReference } from "./resolve.js";
import {
  getBibEntry,
  doneContextIds,
  getCandidateRecords,
  getContexts,
  getExistence,
  getPaper,
  llmVerdictCount,
  saveExtraction,
  saveRelevance,
  saveResolution,
  setPaperStatus,
  toReference,
} from "./store.js";

export interface PipelineDeps {
  db: Db;
  queues: Queues;
  extractor: Extractor;
  /** Registered citation domains, keyed by Reference.kind. */
  domains: Map<string, CitationDomain>;
  /** Null when no LLM is configured; papers must then be run with relevance off. */
  verifier: RelevanceVerifier | null;
  /** Provider name behind `verifier` ("anthropic" | "openai"). */
  verifierProvider: string | null;
  /** Authoritative title for a source (e.g. arXiv metadata); GROBID's header title is a fallback. */
  lookupTitle?: (source: Source) => Promise<string | null>;
  /** Where report files are written: <reportDir>/<paperId>/. */
  reportDir: string;
  reporters: Reporter[];
}

/** Spend cap: at most this many LLM relevance calls per paper (env MAX_LLM_CALLS_PER_PAPER). */
const MAX_LLM_CALLS_PER_PAPER = Number(process.env.MAX_LLM_CALLS_PER_PAPER ?? 600);

type Processor = (job: Job<StageJob>, deps: PipelineDeps) => Promise<unknown>;

/** The job's paper, or null when it has already failed (e.g. an interrupted run's leftover jobs). */
async function activePaper(db: Db, paperId: number) {
  const paper = await getPaper(db, paperId);
  return paper.status === "failed" ? null : paper;
}

const processors: Partial<Record<Stage, Processor>> = {
  async ingest(job, deps) {
    const { db, queues } = deps;
    const paper = await activePaper(db, job.data.paperId);
    if (!paper) return { skipped: "paper failed" };
    const source: Source =
      paper.sourceKind === "arxiv" ? { kind: "arxiv", id: paper.source } : { kind: "pdf", path: paper.source };
    const sha = await ingest(source);
    const title = await deps.lookupTitle?.(source).catch(() => null);
    await setPaperStatus(db, paper.id, "ingested", { pdfSha256: sha, ...(title ? { title } : {}) });
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

    // Per reference: resolve → relevance, all under the paper's report job. The report runs
    // once every reference has finished; a job that fails for good is ignored rather than
    // blocking the report (the reference then shows up without that verdict).
    const child = { ...defaultJobOptions, ignoreDependencyOnFailure: true };
    await deps.queues.flows.add({
      name: "report",
      queueName: "report",
      data: { paperId: paper.id },
      children: bibEntryIds.map((bibEntryId) => ({
        name: "relevance",
        queueName: "relevance",
        data: { paperId: paper.id, bibEntryId },
        opts: child,
        children: [{ name: "resolve", queueName: "resolve", data: { paperId: paper.id, bibEntryId }, opts: child }],
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

  /**
   * Relevance for one reference (only existing works, only when the run asked for it).
   * The judging itself is judgeReference; this wires it to the DB and BullMQ attempts.
   */
  async relevance(job, { db, domains, verifier, verifierProvider }) {
    const paper = await activePaper(db, job.data.paperId);
    if (!paper || !paper.options.relevance) return { skipped: "relevance off" };
    if (!verifier) throw new UnrecoverableError("relevance requested but no LLM is configured");
    // Leftover jobs from another run must be judged by the provider that run chose.
    if (paper.options.llm && paper.options.llm !== verifierProvider) {
      throw new UnrecoverableError(`paper ${paper.id} was run with --llm ${paper.options.llm}; this process uses ${verifierProvider}`);
    }
    const entry = await getBibEntry(db, job.data.bibEntryId!);
    const domain = domains.get(entry.kind);
    if (!domain) throw new UnrecoverableError(`no citation domain registered for kind "${entry.kind}"`);
    const contexts = await getContexts(db, [entry.id]);
    return judgeReference(
      {
        existence: await getExistence(db, entry.id),
        entryTitle: entry.title,
        contexts,
        candidates: await getCandidateRecords(db, entry.id),
        doneContextIds: await doneContextIds(db, contexts.map((c) => c.id)),
      },
      {
        domain,
        verifier,
        save: (id, result, citedText, source) => saveRelevance(db, id, result, citedText, source),
        llmCallsLeft: async () => MAX_LLM_CALLS_PER_PAPER - (await llmVerdictCount(db, paper.id)),
        finalAttempt: job.attemptsMade + 1 >= (job.opts.attempts ?? 1),
      },
    );
  },

  async report(job, { db, reportDir, reporters }) {
    const paper = await activePaper(db, job.data.paperId);
    if (!paper) return { skipped: "paper failed" };
    const report = await loadReport(db, paper.id);
    const dir = join(reportDir, String(paper.id));
    await mkdir(dir, { recursive: true });
    for (const r of reporters) await writeFile(join(dir, r.filename), r.render(report));
    await setPaperStatus(db, paper.id, "reported");
    return { dir };
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
  // LLM calls take ~3 s each; 8 in flight stays well inside provider rate limits.
  relevance: { concurrency: 8 },
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
      if (!job) return;
      if (!FATAL_STAGES.has(stage)) {
        // Per-reference stages don't fail the paper, but a final failure must be visible.
        if ((await job.getState().catch(() => "")) === "failed") {
          console.error(`[${stage}] paper ${job.data.paperId} reference ${job.data.bibEntryId}: ${err.message}`);
        }
        return;
      }
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
