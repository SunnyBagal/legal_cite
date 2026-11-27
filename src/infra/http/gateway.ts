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
export type ApiName = "crossref-doi" | "crossref-query" | "openalex" | "s2" | "arxiv" | "doi";

export interface ApiResponse {
  /** 200, or 404 for "no such record" (a cacheable negative result). */
  status: 200 | 404;
  body: string;
  cached: boolean;
}

export interface ApiGateway {
  /** Throws on errors other than 404 (after retries for 429/5xx), or if the API is blocked. */
  fetch(api: ApiName, url: string): Promise<ApiResponse>;
  /** Store a response for `url` obtained another way (e.g. split out of a batched request). */
  prime(api: ApiName, url: string, res: { status: 200 | 404; body: string }): Promise<void>;
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
    // No documented limit for the DOI handle API: stay gentle (docs/apis.md §6).
    doi: { max: 2, duration: 1000, concurrency: 1 },
  };
}

const API_NAMES = Object.keys(apiLimits()) as ApiName[];
const CACHE_TTL_S = 30 * 24 * 3600;
/** arXiv intermittently answers a valid query with an empty feed; don't trust that for 30 days. */
const EMPTY_FEED_TTL_S = 24 * 3600;

export const cacheKey = (api: ApiName, url: string) => `citecheck:api:${createHash("sha256").update(`${api} ${url}`).digest("hex")}`;
const blockKey = (api: ApiName) => `citecheck:api-blocked:${api}`;

/** Add credentials and contact details to the request actually sent. Never part of the cache key. */
export function authorize(api: ApiName, url: string): { url: string; headers: Record<string, string> } {
  const headers: Record<string, string> = { "User-Agent": userAgent, Accept: api === "arxiv" ? "application/atom+xml" : "application/json" };
  const u = new URL(url);
  if (api.startsWith("crossref") && config.contactEmail) u.searchParams.set("mailto", config.contactEmail);
  if (api === "openalex" && config.openalexApiKey) headers.Authorization = `Bearer ${config.openalexApiKey}`;
  if (api === "s2" && config.semanticScholarApiKey) headers["x-api-key"] = config.semanticScholarApiKey;
  return { url: u.toString(), headers };
}

/** The host refused us; stop sending requests to it for `ttlSeconds` (arXiv treats more as an attack). */
export class ApiBlockedError extends UnrecoverableError {
  constructor(
    readonly api: ApiName,
    readonly ttlSeconds: number,
    message: string,
  ) {
    super(message);
  }
}

const secondsToUtcMidnight = () => {
  const now = new Date();
  return Math.max(60, Math.ceil((Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1) - now.getTime()) / 1000));
};

/**
 * One HTTP request, classified. 200/404 are results (bodies validated before anyone caches
 * them); 429/5xx and malformed 200s are retryable; 403 and OpenAlex's daily budget block the
 * API; other 4xx are permanent.
 */
export async function fetchOnce(api: ApiName, url: string, fetchFn: typeof fetch = fetch): Promise<{ status: 200 | 404; body: string; ttl: number }> {
  const req = authorize(api, url);
  const res = await fetchFn(req.url, { headers: req.headers, signal: AbortSignal.timeout(30_000) });
  const body = await res.text();
  if (res.status === 404) return { status: 404, body, ttl: CACHE_TTL_S };
  if (res.status === 200) {
    if (api === "arxiv") {
      if (!body.includes("<feed")) throw new Error(`${api}: 200 without an Atom feed`);
      return { status: 200, body, ttl: body.includes("<entry") ? CACHE_TTL_S : EMPTY_FEED_TTL_S };
    }
    try {
      JSON.parse(body);
    } catch {
      throw new Error(`${api}: 200 with a non-JSON body`); // proxy/error page: retry, never cache
    }
    return { status: 200, body, ttl: CACHE_TTL_S };
  }
  if (res.status === 429 && body.includes("daily_budget")) throw new ApiBlockedError(api, secondsToUtcMidnight(), `${api}: daily budget exhausted`);
  if (res.status === 403) throw new ApiBlockedError(api, 3600, `${api}: HTTP 403 (access refused; pausing this API for 1 h)`);
  if (res.status === 429 || res.status >= 500) throw new Error(`${api} HTTP ${res.status}`); // retried with backoff
  throw new UnrecoverableError(`${api} HTTP ${res.status}: ${body.slice(0, 200)}`);
}

type Cached = { status: 200 | 404; body: string };

/**
 * Production gateway. The response cache lives in its own Redis (`CACHE_REDIS_URL`, LRU
 * eviction) so it can never evict BullMQ's keys; queues use the main Redis (noeviction).
 */
export function createQueuedGateway(connection: ConnectionOptions, cacheUrl = config.cacheRedisUrl) {
  const cache = new Redis(cacheUrl, { maxRetriesPerRequest: 3 });
  cache.on("error", (err) => console.error(`[api cache] ${err.message}`));
  const queues = new Map(API_NAMES.map((api) => [api, new Queue(`api-${api}`, { connection })]));
  const events = new Map(API_NAMES.map((api) => [api, new QueueEvents(`api-${api}`, { connection })]));
  // Every in-flight waitUntilFinished adds a 'closing' listener to its queue; with 64
  // concurrent resolve jobs Node's default limit of 10 prints MaxListenersExceededWarning.
  for (const q of queues.values()) q.setMaxListeners(1000);
  const logError = (err: Error) => console.error(`[api queue] ${err.message}`);
  for (const q of queues.values()) q.on("error", logError);
  for (const e of events.values()) e.on("error", logError);
  let workers: Worker[] = [];

  const readCache = async (key: string): Promise<Cached | null> => {
    const hit = await cache.get(key);
    return hit ? (JSON.parse(hit) as Cached) : null;
  };

  const gateway: ApiGateway = {
    async fetch(api, url) {
      const key = cacheKey(api, url);
      const hit = await readCache(key);
      if (hit) return { ...hit, cached: true };
      const blocked = await cache.get(blockKey(api));
      if (blocked) throw new Error(`${api} is paused: ${blocked}`);
      // jobId = request hash: identical in-flight requests share one HTTP call. Completed jobs
      // linger 5 min so a late waiter still finds them (BullMQ reports a removed job as failed).
      const job = await queues.get(api)!.add(
        "fetch",
        { api, url },
        { jobId: key.slice(-40), attempts: 5, backoff: { type: "exponential", delay: 2_000 }, removeOnComplete: { age: 300 }, removeOnFail: true },
      );
      let returned: Cached | { status: number } | undefined;
      try {
        returned = (await job.waitUntilFinished(events.get(api)!, 10 * 60_000)) as Cached | { status: number };
      } catch (err) {
        const late = await readCache(key); // finished and cached, but the wait lost the race
        if (late) return { ...late, cached: false };
        throw err;
      }
      if (returned && "body" in returned) return { ...returned, cached: false }; // cache write had failed
      const stored = await readCache(key);
      if (!stored) throw new Error(`${api}: response missing from cache`);
      return { ...stored, cached: false };
    },
    async prime(api, url, res) {
      await cache.set(cacheKey(api, url), JSON.stringify(res), "EX", CACHE_TTL_S);
    },
  };

  return {
    gateway,
    /** Start the per-API fetch workers (one process should own them, so limits hold). */
    startWorkers() {
      const limits = apiLimits();
      workers = API_NAMES.map((api) => {
        const { max, duration, concurrency } = limits[api];
        const w = new Worker<{ api: ApiName; url: string }>(
          `api-${api}`,
          async (job) => {
            try {
              const { status, body, ttl } = await fetchOnce(api, job.data.url);
              try {
                await cache.set(cacheKey(api, job.data.url), JSON.stringify({ status, body }), "EX", ttl);
                return { status }; // keep bodies out of BullMQ's job hashes and event stream
              } catch {
                return { status, body };
              }
            } catch (err) {
              if (err instanceof ApiBlockedError) {
                console.error(`[api ${api}] ${err.message}`);
                await cache.set(blockKey(api), err.message, "EX", err.ttlSeconds).catch(() => {});
              }
              throw err;
            }
          },
          { connection, concurrency, limiter: { max, duration } },
        );
        w.on("error", (err) => console.error(`[api ${api}] ${err.message}`));
        return w;
      });
    },
    async close(force = false) {
      await Promise.all(workers.map((w) => w.close(force)));
      await Promise.all([...queues.values(), ...events.values()].map((q) => q.close()));
      cache.disconnect();
    },
  };
}

/** Parse a JSON response; null for 404. */
export async function fetchJson<T>(gw: ApiGateway, api: ApiName, url: string): Promise<T | null> {
  const res = await gw.fetch(api, url);
  return res.status === 404 ? null : (JSON.parse(res.body) as T);
}
