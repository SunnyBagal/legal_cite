import { createHash } from "node:crypto";
import { Queue, QueueEvents, UnrecoverableError, Worker, type ConnectionOptions } from "bullmq";
import { Redis } from "ioredis";
import { config, userAgent } from "../../config.js";

/**
 * Every external API call goes through an ApiGateway: cached in Redis by request hash, and
 * rate-limited by one BullMQ queue per API (limits from docs/apis.md). Resolvers only build
 * URLs and parse bodies. Credentials (mailto, keys) are added at fetch time, so they never
 * appear in cache keys, stored URLs or raw responses.
 */
export type ApiName = "crossref-doi" | "crossref-query" | "openalex" | "s2" | "arxiv";

export interface ApiResponse {
  /** 200, or 404 for "no such record" (a cacheable negative result). */
  status: 200 | 404;
  body: string;
  cached: boolean;
}

export interface ApiGateway {
  /** Throws on errors other than 404 (after retries for 429/5xx). */
  fetch(api: ApiName, url: string): Promise<ApiResponse>;
}

/** BullMQ limiter + concurrency per API, keyed on whether we identify ourselves. See docs/apis.md. */
export function apiLimits(): Record<ApiName, { max: number; duration: number; concurrency: number }> {
  const polite = Boolean(config.contactEmail);
  return {
    "crossref-doi": polite ? { max: 8, duration: 1000, concurrency: 3 } : { max: 4, duration: 1000, concurrency: 1 },
    "crossref-query": polite ? { max: 2, duration: 1000, concurrency: 2 } : { max: 1, duration: 1200, concurrency: 1 },
    openalex: config.openalexApiKey ? { max: 10, duration: 1000, concurrency: 4 } : { max: 5, duration: 1000, concurrency: 2 },
    s2: { max: 1, duration: 1100, concurrency: 1 },
    arxiv: { max: 1, duration: 3000, concurrency: 1 },
  };
}

const API_NAMES = Object.keys(apiLimits()) as ApiName[];
const CACHE_TTL_S = 30 * 24 * 3600;
const cacheKey = (api: ApiName, url: string) => `citecheck:api:${createHash("sha256").update(`${api} ${url}`).digest("hex")}`;

interface ApiJob {
  api: ApiName;
  url: string;
}

/** Add credentials and contact details for the request actually sent. */
function authorize(api: ApiName, url: string): { url: string; headers: Record<string, string> } {
  const headers: Record<string, string> = { "User-Agent": userAgent, Accept: api === "arxiv" ? "application/atom+xml" : "application/json" };
  const u = new URL(url);
  if (api.startsWith("crossref") && config.contactEmail) u.searchParams.set("mailto", config.contactEmail);
  if (api === "openalex" && config.openalexApiKey) headers.Authorization = `Bearer ${config.openalexApiKey}`;
  if (api === "s2" && config.semanticScholarApiKey) headers["x-api-key"] = config.semanticScholarApiKey;
  return { url: u.toString(), headers };
}

async function fetchOnce(job: ApiJob): Promise<{ status: 200 | 404; body: string }> {
  const { url, headers } = authorize(job.api, job.url);
  const res = await fetch(url, { headers, signal: AbortSignal.timeout(30_000) });
  const body = await res.text();
  if (res.status === 200 || res.status === 404) return { status: res.status, body };
  // OpenAlex's daily budget only resets at midnight UTC; retrying is pointless.
  if (res.status === 429 && body.includes("daily_budget")) throw new UnrecoverableError(`${job.api}: daily budget exhausted`);
  if (res.status === 429 || res.status >= 500) throw new Error(`${job.api} HTTP ${res.status}`); // retried with backoff
  throw new UnrecoverableError(`${job.api} HTTP ${res.status}: ${body.slice(0, 200)}`);
}

/** Production gateway: Redis cache in front of per-API rate-limited BullMQ queues. */
export function createQueuedGateway(connection: ConnectionOptions) {
  const redis = new Redis({ ...(connection as object), maxRetriesPerRequest: 3 });
  redis.on("error", (err) => console.error(`[api cache] ${err.message}`));
  const queues = new Map(API_NAMES.map((api) => [api, new Queue<ApiJob>(`api-${api}`, { connection })]));
  const events = new Map(API_NAMES.map((api) => [api, new QueueEvents(`api-${api}`, { connection })]));
  const logError = (err: Error) => console.error(`[api queue] ${err.message}`);
  for (const q of queues.values()) q.on("error", logError);
  for (const e of events.values()) e.on("error", logError);
  let workers: Worker[] = [];

  const gateway: ApiGateway = {
    async fetch(api, url) {
      const key = cacheKey(api, url);
      const hit = await redis.get(key);
      if (hit) return { ...(JSON.parse(hit) as { status: 200 | 404; body: string }), cached: true };
      // jobId = request hash: identical in-flight requests share one HTTP call.
      const job = await queues.get(api)!.add(
        "fetch",
        { api, url },
        { jobId: key.slice(-40), attempts: 5, backoff: { type: "exponential", delay: 2_000 }, removeOnComplete: true, removeOnFail: true },
      );
      const res = (await job.waitUntilFinished(events.get(api)!, 10 * 60_000)) as { status: 200 | 404; body: string };
      return { ...res, cached: false };
    },
  };

  return {
    gateway,
    /** Start the per-API fetch workers (one process should own them, so limits hold). */
    startWorkers() {
      const limits = apiLimits();
      workers = API_NAMES.map((api) => {
        const { max, duration, concurrency } = limits[api];
        const w = new Worker<ApiJob>(
          `api-${api}`,
          async (job) => {
            const res = await fetchOnce(job.data);
            await redis.set(cacheKey(api, job.data.url), JSON.stringify(res), "EX", CACHE_TTL_S);
            return res;
          },
          { connection, concurrency, limiter: { max, duration } },
        );
        w.on("error", (err) => console.error(`[api ${api}] ${err.message}`));
        return w;
      });
    },
    async close() {
      await Promise.all(workers.map((w) => w.close()));
      await Promise.all([...queues.values(), ...events.values()].map((q) => q.close()));
      redis.disconnect();
    },
  };
}

/** Parse a JSON response; null for 404. */
export async function fetchJson<T>(gw: ApiGateway, api: ApiName, url: string): Promise<T | null> {
  const res = await gw.fetch(api, url);
  return res.status === 404 ? null : (JSON.parse(res.body) as T);
}
