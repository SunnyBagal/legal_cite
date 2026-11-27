import { FlowProducer, Queue, type ConnectionOptions, type DefaultJobOptions } from "bullmq";
import { config } from "../config.js";

/** One queue per pipeline stage. Jobs carry ids only; state lives in Postgres. */
export const STAGES = ["ingest", "extract", "resolve", "relevance", "report"] as const;
export type Stage = (typeof STAGES)[number];

export interface StageJob {
  paperId: number;
  /** Set for per-reference stages (resolve, relevance). */
  bibEntryId?: number;
}

export function redisConnection(url = config.redisUrl): ConnectionOptions {
  const u = new URL(url);
  if (u.protocol !== "redis:" && u.protocol !== "rediss:") throw new Error(`REDIS_URL must be redis:// or rediss://, got ${u.protocol}`);
  const db = u.pathname.length > 1 ? Number(u.pathname.slice(1)) : 0;
  if (!Number.isInteger(db)) throw new Error(`REDIS_URL database must be a number: ${u.pathname}`);
  return {
    host: u.hostname,
    port: Number(u.port || 6379),
    username: u.username ? decodeURIComponent(u.username) : undefined,
    password: u.password ? decodeURIComponent(u.password) : undefined,
    db,
    tls: u.protocol === "rediss:" ? {} : undefined,
    // Required by BullMQ workers (blocking commands).
    maxRetriesPerRequest: null,
  };
}

export const defaultJobOptions: DefaultJobOptions = {
  attempts: 3,
  backoff: { type: "exponential", delay: 2_000 },
  removeOnComplete: { age: 24 * 3600, count: 1000 },
  removeOnFail: { age: 7 * 24 * 3600 },
};

export function createQueues(connection: ConnectionOptions) {
  const queues = Object.fromEntries(
    STAGES.map((s) => {
      const q = new Queue<StageJob>(s, { connection, defaultJobOptions });
      q.on("error", (err) => console.error(`[queue ${s}] ${err.message}`));
      return [s, q];
    }),
  ) as Record<Stage, Queue<StageJob>>;
  const flows = new FlowProducer({ connection });
  return {
    queues,
    flows,
    close: async () => {
      await Promise.all([...Object.values(queues).map((q) => q.close()), flows.close()]);
    },
  };
}

export type Queues = ReturnType<typeof createQueues>;
