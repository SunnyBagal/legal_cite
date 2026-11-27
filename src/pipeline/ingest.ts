import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { UnrecoverableError } from "bullmq";
import { config, userAgent } from "../config.js";

export type Source = { kind: "arxiv"; id: string } | { kind: "pdf"; path: string };

const NEW_ARXIV = /^\d{4}\.\d{4,5}(v\d+)?$/;
const OLD_ARXIV = /^[a-z-]+(\.[A-Z]{2})?\/\d{7}(v\d+)?$/;

/**
 * An existing file is always a local PDF. Otherwise "2303.08774", "arXiv:2303.08774v3",
 * "https://arxiv.org/abs/2303.08774" → arXiv; anything else is treated as a PDF path.
 */
export function parseSource(input: string): Source {
  if (existsSync(input)) return { kind: "pdf", path: resolve(input) };
  const id = input
    .trim()
    .replace(/^https?:\/\/(export\.)?arxiv\.org\/(abs|pdf)\//i, "")
    .replace(/^arxiv:/i, "")
    .replace(/\.pdf$/i, "");
  if (NEW_ARXIV.test(id) || OLD_ARXIV.test(id)) return { kind: "arxiv", id };
  return { kind: "pdf", path: resolve(input) };
}

const PDF_DIR = join(config.cacheDir, "pdfs");
export const pdfPath = (sha256: string) => join(PDF_DIR, `${sha256}.pdf`);
const MAX_PDF_BYTES = 100 * 1024 * 1024;

/**
 * Fetch or read the PDF, store it content-addressed, return its sha256.
 * Permanent problems (missing file, not a PDF, arXiv 4xx) throw UnrecoverableError so BullMQ
 * doesn't retry them (arXiv treats repeated requests after a 403 as an attack).
 */
export async function ingest(source: Source): Promise<string> {
  const bytes = source.kind === "arxiv" ? await downloadArxivPdf(source.id) : await readLocal(source.path);
  if (Buffer.from(bytes.subarray(0, 5)).toString("latin1") !== "%PDF-") {
    throw new UnrecoverableError(`not a PDF: ${source.kind === "arxiv" ? source.id : source.path}`);
  }
  const sha = createHash("sha256").update(bytes).digest("hex");
  const dest = pdfPath(sha);
  if (!existsSync(dest)) {
    // Write-then-rename so a concurrent reader never sees a half-written file.
    await mkdir(PDF_DIR, { recursive: true });
    const tmp = `${dest}.${process.pid}.tmp`;
    await writeFile(tmp, bytes);
    await rename(tmp, dest);
  }
  return sha;
}

async function readLocal(path: string): Promise<Uint8Array> {
  try {
    return await readFile(path);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "ENOENT" || code === "EISDIR" || code === "EACCES") throw new UnrecoverableError(`cannot read ${path}: ${code}`);
    throw err;
  }
}

/** arxiv.org robots.txt Crawl-delay (docs/apis.md §5). Per process: run one citecheck at a time. */
const ARXIV_PDF_SPACING_MS = 15_000;
let lastArxivDownload = 0;

async function downloadArxivPdf(id: string): Promise<Uint8Array> {
  const wait = lastArxivDownload + ARXIV_PDF_SPACING_MS - Date.now();
  if (wait > 0) await new Promise((r) => setTimeout(r, wait));
  lastArxivDownload = Date.now();
  const res = await fetch(`https://arxiv.org/pdf/${id}`, {
    headers: { "User-Agent": userAgent },
    signal: AbortSignal.timeout(120_000),
  });
  if (res.status >= 400 && res.status < 500 && res.status !== 429) {
    throw new UnrecoverableError(`arXiv PDF ${id}: HTTP ${res.status}`);
  }
  if (!res.ok) throw new Error(`arXiv PDF ${id}: HTTP ${res.status}`);
  if (Number(res.headers.get("content-length") ?? 0) > MAX_PDF_BYTES) {
    throw new UnrecoverableError(`arXiv PDF ${id} is larger than ${MAX_PDF_BYTES} bytes`);
  }
  return new Uint8Array(await res.arrayBuffer());
}
