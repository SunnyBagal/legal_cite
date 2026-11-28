/**
 * Existence eval on the CiteAudit benchmark (Yuan et al., 2026; arXiv 2602.23452).
 *
 *   pnpm eval:citeaudit [--per-cell 100] [--seed 42] [--concurrency 8]
 *
 * The dataset has no license, so it is never committed: it is downloaded from a pinned
 * commit into .cache/ and checked against a sha256. Each raw citation string is parsed by
 * GROBID (processCitationList, the same parser the pipeline uses on PDFs), then resolved by
 * the production resolvers and deterministic scorer. Flagged = NOT_FOUND or MISMATCH.
 */
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { config, projectRoot } from "../src/config.js";
import type { ExistenceVerdict, Reference } from "../src/core/types.js";
import { createScholarlyDomain } from "../src/domains/scholarly/index.js";
import { parseTei } from "../src/domains/scholarly/tei.js";
import { createQueuedGateway, type ApiGateway, type ApiName } from "../src/infra/http/gateway.js";
import { preflight } from "../src/infra/preflight.js";
import { redisConnection } from "../src/pipeline/queues.js";
import { resolveReference } from "../src/pipeline/resolve.js";
import { ceilTo, confusion, floorTo, perClass, precisionAtPrevalence, type Confusion } from "./metrics.js";

const COMMIT = "99744f032ad3b42a1d09929ddcf7f3379e7320d5";
const URL_ = `https://raw.githubusercontent.com/shiiiikw/CiteAudit/${COMMIT}/data/benchmark.json`;
const SHA256 = "0bf0a7b23d13f2ee355ee0742ffadf9b8bf7f8c025226dc9363d8ea012b1bae5";
const FLAGGED: ExistenceVerdict[] = ["NOT_FOUND", "MISMATCH"];

interface Row {
  source_type: "realworld" | "generated";
  citation: string;
  GT: boolean;
}

export interface CaseResult {
  sourceType: Row["source_type"];
  /** true = a real citation in the benchmark. */
  real: boolean;
  citation: string;
  parsed: { title: string | null; authors: string[]; year: number | null; venue: string | null; doi: string | null; arxivId: string | null } | null;
  verdict: ExistenceVerdict | "PARSE_ERROR";
  reason: string;
  degraded: boolean;
  lookups: number;
  networkCalls: number;
  /** Lookups that threw (after the gateway's retries): rate limits, timeouts, blocked APIs. */
  failedLookups?: number;
  callsByApi: Partial<Record<ApiName, number>>;
  ms: number;
}

async function loadDataset(): Promise<Row[]> {
  const path = join(config.cacheDir, "citeaudit", `benchmark-${COMMIT.slice(0, 12)}.json`);
  if (!existsSync(path)) {
    const res = await fetch(URL_);
    if (!res.ok) throw new Error(`could not download CiteAudit: HTTP ${res.status} from ${URL_}`);
    await mkdir(join(config.cacheDir, "citeaudit"), { recursive: true });
    await writeFile(path, Buffer.from(await res.arrayBuffer()));
  }
  const bytes = await readFile(path);
  const sha = createHash("sha256").update(bytes).digest("hex");
  if (sha !== SHA256) throw new Error(`CiteAudit file ${path} has sha256 ${sha}, expected ${SHA256}; delete it to re-download`);
  return (JSON.parse(bytes.toString("utf8")) as { data: Row[] }).data;
}

/** Deterministic PRNG (mulberry32) so the same seed always picks the same sample. */
function rng(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Unique citation strings; a string labelled both real and fake is dropped. Then per-cell seeded samples. */
export function sample(rows: Row[], perCell: number, seed: number) {
  const byText = new Map<string, Row | null>();
  for (const r of rows) {
    const prev = byText.get(r.citation);
    if (prev === undefined) byText.set(r.citation, r);
    else if (prev && prev.GT !== r.GT) byText.set(r.citation, null);
  }
  const unique = [...byText.values()].filter((r): r is Row => r !== null);
  const conflicting = [...byText.values()].filter((r) => r === null).length;
  const rand = rng(seed);
  const cells = new Map<string, Row[]>();
  for (const r of unique) {
    const k = `${r.source_type}/${r.GT ? "real" : "fake"}`;
    cells.set(k, [...(cells.get(k) ?? []), r]);
  }
  const picked: Row[] = [];
  const population: Record<string, number> = {};
  for (const [k, list] of [...cells].sort(([a], [b]) => a.localeCompare(b))) {
    population[k] = list.length;
    const shuffled = list.map((r) => [rand(), r] as const).sort((a, b) => a[0] - b[0]).map(([, r]) => r);
    picked.push(...shuffled.slice(0, perCell));
  }
  return { picked, population, uniqueCount: unique.length, duplicates: rows.length - unique.length - conflicting, conflicting };
}

async function parseCitation(citation: string): Promise<Reference | null> {
  const body = new URLSearchParams({ citations: citation, includeRawCitations: "1", consolidateCitations: "0" });
  const res = await fetch(new URL("/api/processCitationList", config.grobidUrl), { method: "POST", body, signal: AbortSignal.timeout(60_000) });
  if (res.status === 204) return null;
  if (!res.ok) throw new Error(`GROBID HTTP ${res.status}`);
  return parseTei(await res.text()).references[0] ?? null;
}

function countingGateway(gw: ApiGateway, tally: { lookups: number; network: number; failed: number; byApi: Partial<Record<ApiName, number>> }): ApiGateway {
  return {
    async fetch(api, url) {
      tally.lookups++;
      let res;
      try {
        res = await gw.fetch(api, url);
      } catch (err) {
        tally.failed++;
        throw err;
      }
      if (!res.cached) {
        tally.network++;
        tally.byApi[api] = (tally.byApi[api] ?? 0) + 1;
      }
      return res;
    },
    prime: (api, url, res) => gw.prime(api, url, res),
  };
}

async function runCase(row: Row, gw: ApiGateway): Promise<CaseResult> {
  const t0 = performance.now();
  const tally = { lookups: 0, network: 0, failed: 0, byApi: {} as Partial<Record<ApiName, number>> };
  const base = { sourceType: row.source_type, real: row.GT, citation: row.citation };
  let ref: Reference | null;
  try {
    ref = await parseCitation(row.citation);
  } catch (err) {
    return { ...base, parsed: null, verdict: "PARSE_ERROR", reason: String(err), degraded: true, lookups: 0, networkCalls: 0, callsByApi: {}, ms: performance.now() - t0 };
  }
  if (!ref) return { ...base, parsed: null, verdict: "PARSE_ERROR", reason: "GROBID returned no reference", degraded: false, lookups: 0, networkCalls: 0, callsByApi: {}, ms: performance.now() - t0 };
  const domain = createScholarlyDomain(countingGateway(gw, tally));
  const res = await resolveReference(domain, ref);
  return {
    ...base,
    parsed: { title: ref.title, authors: ref.authors.map((a) => a.name), year: ref.year, venue: ref.venue, doi: ref.doi, arxivId: ref.arxivId },
    verdict: res.result.verdict,
    reason: res.result.reason,
    degraded: res.degraded,
    lookups: tally.lookups,
    networkCalls: tally.network,
    failedLookups: tally.failed,
    callsByApi: tally.byApi,
    ms: performance.now() - t0,
  };
}

async function pool<T, R>(items: T[], n: number, fn: (t: T, i: number) => Promise<R>, onDone: (done: number) => void): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let next = 0;
  let done = 0;
  await Promise.all(
    Array.from({ length: Math.min(n, items.length) }, async () => {
      while (next < items.length) {
        const i = next++;
        out[i] = await fn(items[i]!, i);
        onDone(++done);
      }
    }),
  );
  return out;
}

const pct = (xs: number[], p: number) => {
  const s = [...xs].sort((a, b) => a - b);
  return s.length ? s[Math.min(s.length - 1, Math.floor(p * s.length))]! : 0;
};

export function summarize(results: CaseResult[], population: Record<string, number>, flagAmbiguous = false) {
  const flagged = (r: CaseResult) => FLAGGED.includes(r.verdict as ExistenceVerdict) || r.verdict === "PARSE_ERROR" || (flagAmbiguous && r.verdict === "AMBIGUOUS");
  const groups: Record<string, CaseResult[]> = { all: results, realworld: results.filter((r) => r.sourceType === "realworld"), generated: results.filter((r) => r.sourceType === "generated") };
  return Object.fromEntries(
    Object.entries(groups).map(([g, rs]) => {
      const c: Confusion = confusion(rs.map((r) => ({ actual: !r.real, predicted: flagged(r) })));
      const fakePop = Object.entries(population).filter(([k]) => (g === "all" || k.startsWith(g)) && k.endsWith("fake")).reduce((a, [, n]) => a + n, 0);
      const allPop = Object.entries(population).filter(([k]) => g === "all" || k.startsWith(g)).reduce((a, [, n]) => a + n, 0);
      return [g, { confusion: c, ...perClass(c), prevalence: allPop ? fakePop / allPop : null, precisionAtDatasetPrevalence: allPop ? precisionAtPrevalence(c, fakePop / allPop) : null }];
    }),
  );
}

async function main() {
  const { values } = parseArgs({ options: { "per-cell": { type: "string", default: "100" }, seed: { type: "string", default: "42" }, concurrency: { type: "string", default: "8" } } });
  const perCell = Number(values["per-cell"]);
  const seed = Number(values.seed);
  const concurrency = Number(values.concurrency);
  if (![perCell, seed, concurrency].every((x) => Number.isInteger(x) && x >= 0) || perCell === 0 || concurrency === 0) throw new Error("--per-cell, --seed and --concurrency must be whole numbers (per-cell and concurrency > 0)");

  await preflight(["redis", "redis-cache", "grobid"]);
  const rows = await loadDataset();
  const s = sample(rows, perCell, seed);
  console.log(`CiteAudit @${COMMIT.slice(0, 7)}: ${rows.length} rows, ${s.uniqueCount} unique citation strings (${s.duplicates} duplicates, ${s.conflicting} with conflicting labels dropped)`);
  console.log(`population per cell: ${JSON.stringify(s.population)}; sampling ${perCell} per cell with seed ${seed} → ${s.picked.length} citations`);
  console.log(`Crossref pool: ${config.contactEmail ? "polite (CONTACT_EMAIL set)" : "public (no CONTACT_EMAIL)"}; OpenAlex key: ${config.openalexApiKey ? "yes" : "no"}; S2 key: ${config.semanticScholarApiKey ? "yes" : "no"}`);

  const connection = redisConnection();
  const api = createQueuedGateway(connection);
  api.startWorkers();
  const t0 = performance.now();
  let results: CaseResult[];
  try {
    results = await pool(s.picked, concurrency, (row) => runCase(row, api.gateway), (d) => {
      if (d % 25 === 0 || d === s.picked.length) process.stderr.write(`  ${d}/${s.picked.length} (${((performance.now() - t0) / 1000).toFixed(0)} s)\n`);
    });
  } finally {
    await api.close(false);
  }
  const wallS = (performance.now() - t0) / 1000;

  const outDir = join(projectRoot, "eval", "out");
  await mkdir(outDir, { recursive: true });
  await writeFile(join(outDir, "citeaudit-results.jsonl"), results.map((r) => JSON.stringify(r)).join("\n") + "\n");

  const verdicts = (rs: CaseResult[]) => rs.reduce<Record<string, number>>((a, r) => ((a[r.verdict] = (a[r.verdict] ?? 0) + 1), a), {});
  const cold = results.filter((r) => r.lookups > 0 && r.networkCalls === r.lookups);
  const summary = {
    dataset: { name: "CiteAudit", commit: COMMIT, sha256: SHA256, rows: rows.length, unique: s.uniqueCount, population: s.population },
    sample: { perCell, seed, n: results.length },
    flaggedVerdicts: [...FLAGGED, "PARSE_ERROR"],
    verdicts: {
      "realworld/real": verdicts(results.filter((r) => r.sourceType === "realworld" && r.real)),
      "realworld/fake": verdicts(results.filter((r) => r.sourceType === "realworld" && !r.real)),
      "generated/real": verdicts(results.filter((r) => r.sourceType === "generated" && r.real)),
      "generated/fake": verdicts(results.filter((r) => r.sourceType === "generated" && !r.real)),
    },
    metrics: summarize(results, s.population),
    metricsIfAmbiguousFlagged: summarize(results, s.population, true),
    cost: {
      wallSeconds: wallS,
      concurrency,
      wallSecondsPerCitation: wallS / results.length,
      latencyMsP50: pct(results.map((r) => r.ms), 0.5),
      latencyMsP90: pct(results.map((r) => r.ms), 0.9),
      lookupsPerCitation: results.reduce((a, r) => a + r.lookups, 0) / results.length,
      networkCallsPerCitation: results.reduce((a, r) => a + r.networkCalls, 0) / results.length,
      networkCallsByApi: results.reduce<Record<string, number>>((a, r) => {
        for (const [k, v] of Object.entries(r.callsByApi)) a[k] = (a[k] ?? 0) + v;
        return a;
      }, {}),
      fullyColdCitations: cold.length,
      failedLookupsByCitation: results.reduce((a, r) => a + (r.failedLookups ?? 0), 0),
      degradedCitations: results.filter((r) => r.degraded).length,
    },
  };
  await mkdir(join(projectRoot, "eval", "results"), { recursive: true });
  await writeFile(join(projectRoot, "eval", "results", "citeaudit-summary.json"), JSON.stringify(summary, null, 2) + "\n");

  console.log(`\nverdicts: ${JSON.stringify(summary.verdicts)}`);
  for (const [label, m] of [["flagged = NOT_FOUND or MISMATCH (or unparseable)", summary.metrics], ["also flag AMBIGUOUS", summary.metricsIfAmbiguousFlagged]] as const) {
    console.log(`\n${label}  (scores rounded down, error rates rounded up)`);
    console.log("group       n    fake P  fake R  fake F1  FPR(real)  real F1  P@dataset-prevalence");
    for (const [g, x] of Object.entries(m)) {
      console.log(
        `${g.padEnd(10)} ${String(x.n).padStart(4)}   ${floorTo(x.fake.precision, 3)}   ${floorTo(x.fake.recall, 3)}   ${floorTo(x.fake.f1, 3)}    ${ceilTo(x.falsePositiveRate, 3)}      ${floorTo(x.real.f1, 3)}    ${floorTo(x.precisionAtDatasetPrevalence, 3)} (prevalence ${floorTo(x.prevalence, 3)})`,
      );
    }
  }
  const c = summary.cost;
  console.log(`\ncost: ${c.wallSeconds.toFixed(0)} s wall at concurrency ${concurrency} = ${c.wallSecondsPerCitation.toFixed(2)} s/citation; latency p50 ${(c.latencyMsP50 / 1000).toFixed(1)} s, p90 ${(c.latencyMsP90 / 1000).toFixed(1)} s`);
  console.log(`      ${c.lookupsPerCitation.toFixed(2)} lookups/citation, ${c.networkCallsPerCitation.toFixed(2)} network API calls/citation (rest from cache); by API ${JSON.stringify(c.networkCallsByApi)}; ${c.degradedCitations} with a failed lookup`);
  console.log(`\nwrote eval/results/citeaudit-summary.json and eval/out/citeaudit-results.jsonl`);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().then(
    () => process.exit(0),
    (err: unknown) => {
      console.error(`error: ${err instanceof Error ? err.message : String(err)}`);
      process.exit(1);
    },
  );
}
