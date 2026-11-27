import { existsSync } from "node:fs";
import { Command } from "commander";
import { config } from "./config.js";
import { GrobidExtractor } from "./domains/scholarly/grobid.js";
import { createScholarlyDomain } from "./domains/scholarly/index.js";
import { createDb } from "./infra/db/client.js";
import { createQueuedGateway } from "./infra/http/gateway.js";
import { runMigrations } from "./infra/db/migrate.js";
import { parseSource } from "./pipeline/ingest.js";
import { createQueues, redisConnection } from "./pipeline/queues.js";
import { createPaper, getPaperStatus, setPaperStatus, verdictCounts } from "./pipeline/store.js";
import { startWorkers, type PipelineDeps } from "./pipeline/workers.js";

const DONE_STATUS = "reported";

const program = new Command("citecheck").description("Check the citations in a research paper.");

program
  .command("run")
  .argument("<source>", "arXiv id (e.g. 2303.08774) or path to a local PDF")
  .option("--timeout <minutes>", "give up after this many minutes", "30")
  .description("Run the full pipeline on one paper and wait for the result")
  .action(async (input: string, opts: { timeout: string }) => {
    const source = parseSource(input);
    if (source.kind === "pdf" && !existsSync(source.path)) throw new Error(`no such file: ${input}`);
    const deadline = Date.now() + Number(opts.timeout) * 60_000;

    await runMigrations();
    const connection = redisConnection();
    const { db, close: closeDb } = createDb();
    const queues = createQueues(connection);
    const api = createQueuedGateway(connection);
    api.startWorkers();
    const scholarly = createScholarlyDomain(api.gateway);
    const deps: PipelineDeps = {
      db,
      queues,
      extractor: new GrobidExtractor(config.grobidUrl),
      domains: new Map([[scholarly.kind, scholarly]]),
    };
    const workers = startWorkers(deps, connection);
    let paperId: number | undefined;
    let stopReason: string | undefined;
    const onSignal = (sig: string) => (stopReason = `interrupted (${sig})`);
    process.once("SIGINT", () => onSignal("SIGINT"));
    process.once("SIGTERM", () => onSignal("SIGTERM"));

    try {
      paperId = await createPaper(db, source, { relevance: true });
      console.log(`paper #${paperId}: ${source.kind} ${source.kind === "arxiv" ? source.id : source.path}`);
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
          break;
        }
        if (Date.now() > deadline) stopReason ??= `timed out after ${opts.timeout} min`;
        if (stopReason) {
          // Mark it failed so leftover jobs for this paper are skipped by the next run.
          await setPaperStatus(db, paperId, "failed", { error: stopReason });
          throw new Error(stopReason);
        }
        await new Promise((r) => setTimeout(r, 500));
      }
    } finally {
      await workers.close();
      await api.close();
      await queues.close();
      await closeDb();
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
