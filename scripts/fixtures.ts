/**
 * Regenerate the real-paper TEI test fixtures locally.
 *
 * They are not committed: both papers carry arXiv's default (non-redistributable) licence,
 * and the repo is public. Requires `docker compose up` (GROBID). PDFs are pinned by arXiv
 * version and sha256, and downloads are spaced by arXiv's robots.txt Crawl-delay (15 s).
 */
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import { config, userAgent } from "../src/config.js";
import { GrobidExtractor } from "../src/domains/scholarly/grobid.js";

const FIXTURES = [
  { name: "attention", arxiv: "1706.03762v7", sha256: "bdfaa68d8984f0dc02beaca527b76f207d99b666d31d1da728ee0728182df697" },
  { name: "gpt4", arxiv: "2303.08774v6", sha256: "c33a66dadca2388d7b172d6293b00dc32b71110c6f38fafe0d41112e61be7774" },
];
const dir = new URL("../test/fixtures/", import.meta.url);
const grobid = new GrobidExtractor(config.grobidUrl);

let downloaded = false;
for (const f of FIXTURES) {
  const pdfPath = new URL(`${f.name}.pdf`, dir);
  if (!existsSync(pdfPath)) {
    if (downloaded) await new Promise((r) => setTimeout(r, 15_000));
    const res = await fetch(`https://arxiv.org/pdf/${f.arxiv}`, { headers: { "User-Agent": userAgent } });
    if (!res.ok) throw new Error(`arXiv ${f.arxiv}: HTTP ${res.status}`);
    await writeFile(pdfPath, new Uint8Array(await res.arrayBuffer()));
    downloaded = true;
  }
  const pdf = await readFile(pdfPath);
  const sha = createHash("sha256").update(pdf).digest("hex");
  if (sha !== f.sha256) throw new Error(`${f.name}.pdf sha256 ${sha} != pinned ${f.sha256}`);
  const { raw } = await grobid.extract(pdf);
  await writeFile(new URL(`${f.name}.tei.xml`, dir), raw);
  console.log(`test/fixtures/${f.name}.tei.xml  (${f.arxiv}, ${raw.length} bytes)`);
}
