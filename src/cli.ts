import { Command } from "commander";
import { config } from "./config.js";
import { GrobidExtractor } from "./domains/scholarly/grobid.js";
import { createDb } from "./infra/db/client.js";
import { runMigrations } from "./infra/db/migrate.js";
import { parseSource } from "./pipeline/ingest.js";
import { createQueues, redisConnection } from "./pipeline/queues.js";
import { createPaper, getPaper } from "./pipeline/store.js";
import { startWorkers, type PipelineDeps } from "./pipeline/workers.js";

const program = new Command("citecheck").description("Check the citations in a research paper.");

program
  .command("run")
  .argument("<source>", "arXiv id (e.g. 2303.08774) or path to a local PDF")
  .description("Run the full pipeline on one paper and wait for the result")
  .action(async (input: string) => {
    await runMigrations();
    const connection = redisConnection();
    const { db, close: closeDb } = createDb();
    const queues = createQueues(connection);
    const deps: PipelineDeps = { db, queues, extractor: new GrobidExtractor(config.grobidUrl), domains: new Map() };
    const workers = startWorkers(deps, connection);
    try {
      const source = parseSource(input);
      const paperId = await createPaper(db, source, { relevance: true });
      console.log(`paper #${paperId}: ${source.kind} ${source.kind === "arxiv" ? source.id : source.path}`);
      await queues.queues.ingest.add("ingest", { paperId });

      let last = "";
      for (;;) {
        const paper = await getPaper(db, paperId);
        if (paper.status !== last) console.log(`  ${paper.status}`);
        last = paper.status;
        if (paper.status === "failed") throw new Error(paper.error ?? "pipeline failed");
        if (paper.status === "extracted") break;
        await new Promise((r) => setTimeout(r, 500));
      }
    } finally {
      await workers.close();
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
