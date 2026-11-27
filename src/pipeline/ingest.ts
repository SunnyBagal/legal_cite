import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { userAgent } from "../config.js";

export type Source = { kind: "arxiv"; id: string } | { kind: "pdf"; path: string };

const NEW_ARXIV = /^\d{4}\.\d{4,5}(v\d+)?$/;
const OLD_ARXIV = /^[a-z-]+(\.[A-Z]{2})?\/\d{7}(v\d+)?$/;

/**
 * An existing file is always a local PDF. Otherwise "2303.08774", "arXiv:2303.08774v3",
 * "https://arxiv.org/abs/2303.08774" → arXiv; anything else is treated as a PDF path.
 */
export function parseSource(input: string): Source {
  if (existsSync(input)) return { kind: "pdf", path: input };
  const id = input
    .trim()
    .replace(/^https?:\/\/(export\.)?arxiv\.org\/(abs|pdf)\//i, "")
    .replace(/^arxiv:/i, "")
    .replace(/\.pdf$/i, "");
  if (NEW_ARXIV.test(id) || OLD_ARXIV.test(id)) return { kind: "arxiv", id };
  return { kind: "pdf", path: input };
}

export const PDF_DIR = ".cache/pdfs";
export const pdfPath = (sha256: string) => join(PDF_DIR, `${sha256}.pdf`);

/** Fetch or read the PDF, store it content-addressed, return its sha256. */
export async function ingest(source: Source): Promise<string> {
  const bytes = source.kind === "arxiv" ? await downloadArxivPdf(source.id) : await readFile(source.path);
  if (Buffer.from(bytes.subarray(0, 5)).toString("latin1") !== "%PDF-") {
    throw new Error(`not a PDF: ${source.kind === "arxiv" ? source.id : source.path}`);
  }
  const sha = createHash("sha256").update(bytes).digest("hex");
  await mkdir(PDF_DIR, { recursive: true });
  await writeFile(pdfPath(sha), bytes);
  return sha;
}

async function downloadArxivPdf(id: string): Promise<Uint8Array> {
  const res = await fetch(`https://arxiv.org/pdf/${id}`, {
    headers: { "User-Agent": userAgent },
    signal: AbortSignal.timeout(120_000),
  });
  if (!res.ok) throw new Error(`arXiv PDF ${id}: HTTP ${res.status}`);
  return new Uint8Array(await res.arrayBuffer());
}
