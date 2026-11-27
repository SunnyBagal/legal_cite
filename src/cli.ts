import { existsSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { Command } from "commander";
import { config } from "./config.js";
import { GrobidExtractor } from "./domains/scholarly/grobid.js";
import { createScholarlyDomain } from "./domains/scholarly/index.js";
import { arxivIdUrl, parseArxivFeed } from "./domains/scholarly/resolvers/arxiv.js";
import { loadReport } from "./report/build.js";
import { htmlReporter } from "./report/html.js";
import { jsonReporter } from "./report/json.js";
import { createDb } from "./infra/db/client.js";
import { createQueuedGateway } from "./infra/http/gateway.js";
import { runMigrations } from "./infra/db/migrate.js";
import { parseSource } from "./pipeline/ingest.js";
import { createQueues, redisConnection } from "./pipeline/queues.js";
import { createPaper, getPaperStatus, relevanceSummary, setPaperStatus, verdictCounts } from "./pipeline/store.js";
import { localEmbedder } from "./relevance/embedder.js";
import { selectLLM, type LLMChoice } from "./relevance/llm/select.js";
import { createRelevanceVerifier } from "./relevance/verifier.js";
import { startWorkers, type PipelineDeps } from "./pipeline/workers.js";

const DONE_STATUS = "reported";

const program = new Command("citecheck").description("Check the citations in a research paper.");

program
  .command("run")
  .argument("<source>", "arXiv id (e.g. 2303.08774) or path to a local PDF")
  .option("--timeout <minutes>", "give up after this many minutes", "30")
  .option("--no-relevance", "skip the relevance stage (works without any LLM key)")
  .option("--llm <provider>", "LLM for relevance: anthropic | openai (default: whichever key is set, Anthropic first)")
  .option("--out <dir>", "write reports under this directory", "reports")
  .description("Run the full pipeline on one paper and wait for the result")
  .action(async (input: string, opts: { timeout: string; relevance: boolean; llm?: string; out: string }) => {
    const source = parseSource(input);
    if (source.kind === "pdf" && !existsSync(source.path)) throw new Error(`no such file: ${input}`);
    if (opts.llm && opts.llm !== "anthropic" && opts.llm !== "openai") throw new Error(`--llm must be anthropic or openai, got ${opts.llm}`);
    const llm = opts.relevance ? selectLLM(opts.llm as LLMChoice | undefined) : null;
    if (opts.relevance && !llm) {
      throw new Error("relevance needs an LLM: set ANTHROPIC_API_KEY or OPENAI_API_KEY in .env, or pass --no-relevance");
    }
    const deadline = Date.now() + Number(opts.timeout) * 60_000;

    await runMigrations();
    const connection = redisConnection();
    const { db, close: closeDb } = createDb();
    const queues = createQueues(connection);
    const api = createQueuedGateway(connection);
    api.startWorkers();
    const scholarly = createScholarlyDomain(api.gateway);
    const embedder = localEmbedder();
    if (llm) embedder.warmup(); // the first load (download + ONNX init) overlaps ingest/resolve
    const deps: PipelineDeps = {
      db,
      queues,
      extractor: new GrobidExtractor(config.grobidUrl),
      domains: new Map([[scholarly.kind, scholarly]]),
      verifier: llm
        ? createRelevanceVerifier({ embedder, llm, prefilterThreshold: process.env.PREFILTER_THRESHOLD ? Number(process.env.PREFILTER_THRESHOLD) : null })
        : null,
      verifierProvider: llm?.name ?? null,
      lookupTitle: async (s) => {
        if (s.kind !== "arxiv") return null;
        const res = await api.gateway.fetch("arxiv", arxivIdUrl(s.id.replace(/v\d+$/, "")));
        return res.status === 200 ? (parseArxivFeed(res.body)[0]?.title ?? null) : null;
      },
      reportDir: resolve(opts.out),
      reporters: [jsonReporter, htmlReporter],
    };
    const workers = startWorkers(deps, connection);
    let paperId: number | undefined;
    let stopReason: string | undefined;
    let interrupted = false;
    const onSignal = (sig: string) => (stopReason = `interrupted (${sig})`);
    process.once("SIGINT", () => onSignal("SIGINT"));
    process.once("SIGTERM", () => onSignal("SIGTERM"));

    try {
      paperId = await createPaper(db, source, { relevance: opts.relevance, ...(llm ? { llm: llm.name } : {}) });
      console.log(`paper #${paperId}: ${source.kind} ${source.kind === "arxiv" ? source.id : source.path}`);
      console.log(`  relevance: ${llm ? `${llm.name} ${llm.model} (abstract-level, needs human review)` : "off"}`);
      await queues.queues.ingest.add("ingest", { paperId });

      let last = "";
      for (;;) {
        const paper = await getPaperStatus(db, paperId);
        if (paper.status !== last) console.log(`  ${paper.status}`);
        last = paper.status;
        if (paper.status === "failed") throw new Error(paper.error ?? "pipeline failed");
        if (paper.status === DONE_STATUS) {
          const counts = await verdictCounts(db, paperId);
          console.log(`  existence: ${Object.entries(counts).map(([v, n]) => `${v} ${n}`).join(", ") || "no references"}`);
          if (llm) {
            const rel = await relevanceSummary(db, paperId);
            const verdicts = Object.entries(rel.byVerdict).map(([v, n]) => `${v} ${n}`).join(", ") || "none";
            console.log(`  relevance, per citing context (abstract-level, needs human review): ${verdicts}`);
            console.log(
              `    ${rel.eligible} contexts of existing works; ${rel.prefilter} by embedding pre-filter; ` +
                `${rel.notJudgedByModel} not judged (no abstract, failure or budget); ${rel.unjudged} missing`,
            );
          }
          const dir = join(resolve(opts.out), String(paperId));
          console.log(`  report: ${join(dir, htmlReporter.filename)}`);
          console.log(`          ${join(dir, jsonReporter.filename)}`);
          break;
        }
        if (Date.now() > deadline) stopReason ??= `timed out after ${opts.timeout} min`;
        if (stopReason) {
          // Mark it failed so leftover jobs for this paper are skipped by the next run.
          await setPaperStatus(db, paperId, "failed", { error: stopReason });
          interrupted = true;
          throw new Error(stopReason);
        }
        await new Promise((r) => setTimeout(r, 500));
      }
    } finally {
      // After a timeout/interrupt, don't wait for in-flight jobs (they can wait minutes on API queues).
      await workers.close(interrupted);
      await api.close(interrupted);
      await queues.close();
      await closeDb();
    }
  });

program
  .command("report")
  .argument("<paper-id>", "id printed by `citecheck run` (paper #N)")
  .option("--out <dir>", "write reports under this directory", "reports")
  .description("Re-render the JSON and HTML reports for a finished run from the database")
  .action(async (id: string, opts: { out: string }) => {
    const { db, close } = createDb();
    try {
      const report = await loadReport(db, Number(id));
      const dir = join(resolve(opts.out), String(report.paper.id));
      await mkdir(dir, { recursive: true });
      for (const r of [jsonReporter, htmlReporter]) await writeFile(join(dir, r.filename), r.render(report));
      console.log(`report: ${join(dir, htmlReporter.filename)}`);
    } finally {
      await close();
    }
  });

program
  .command("migrate")
  .description("Apply database migrations")
  .action(async () => {
    await runMigrations();
    console.log("migrations applied");
  });

program.parseAsync().catch((err: unknown) => {
  console.error(`error: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
});
