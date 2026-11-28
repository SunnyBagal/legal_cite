import { Redis } from "ioredis";
import postgres from "postgres";
import { config } from "../config.js";

export type Service = "postgres" | "redis" | "redis-cache" | "grobid";

const START_HINT = "Start the services with `docker compose up -d` (and wait until `docker compose ps` shows them healthy).";

/** Hide credentials in URLs before they go into an error message. */
export function redact(url: string): string {
  try {
    const u = new URL(url);
    if (u.password) u.password = "***";
    return u.toString();
  } catch {
    return "(unparseable URL)";
  }
}

async function pingRedis(url: string, timeoutMs: number): Promise<void> {
  // No retries: ioredis would otherwise reconnect forever and the CLI would hang.
  const r = new Redis(url, { lazyConnect: true, connectTimeout: timeoutMs, maxRetriesPerRequest: 0, retryStrategy: () => null, enableOfflineQueue: false });
  r.on("error", () => {});
  try {
    await r.connect();
    await r.ping();
  } finally {
    r.disconnect();
  }
}

async function pingPostgres(url: string, timeoutMs: number): Promise<void> {
  const sql = postgres(url, { max: 1, connect_timeout: Math.ceil(timeoutMs / 1000), onnotice: () => {} });
  try {
    await sql`select 1`;
  } finally {
    await sql.end({ timeout: 1 });
  }
}

async function pingGrobid(url: string, timeoutMs: number): Promise<void> {
  const res = await fetch(new URL("/api/isalive", url), { signal: AbortSignal.timeout(timeoutMs) });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
}

const CHECKS: Record<Service, { url: () => string; ping: (url: string, ms: number) => Promise<void> }> = {
  postgres: { url: () => config.databaseUrl, ping: pingPostgres },
  redis: { url: () => config.redisUrl, ping: pingRedis },
  "redis-cache": { url: () => config.cacheRedisUrl, ping: pingRedis },
  grobid: { url: () => config.grobidUrl, ping: pingGrobid },
};

/**
 * Check that every service a command needs answers, in parallel, within `timeoutMs`.
 * Throws one error naming every service that is down, so the user fixes them in one go.
 */
export async function preflight(services: Service[], timeoutMs = 5_000): Promise<void> {
  const results = await Promise.allSettled(services.map((s) => CHECKS[s].ping(CHECKS[s].url(), timeoutMs)));
  const down = results.flatMap((r, i) => {
    if (r.status === "fulfilled") return [];
    const s = services[i]!;
    const e = r.reason as { code?: string; message?: string; name?: string };
    const why = e?.code ?? (e?.message || e?.name || String(r.reason));
    return [`  ${s} is not reachable at ${redact(CHECKS[s].url())} (${why})`];
  });
  if (down.length > 0) throw new Error(`required services are down:\n${down.join("\n")}\n${START_HINT}`);
}
