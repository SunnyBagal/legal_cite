import type { ExtractedDocument, Extractor } from "../../core/types.js";
import { parseTei } from "./tei.js";

/**
 * GROBID processFulltextDocument → TEI → references + contexts.
 * consolidateCitations/Header=0 on purpose: consolidation would replace what the paper
 * actually printed with Crossref metadata, hiding exactly the errors we're checking for.
 */
export class GrobidExtractor implements Extractor {
  constructor(
    private readonly baseUrl: string,
    private readonly timeoutMs = 300_000,
  ) {}

  async extract(pdf: Uint8Array): Promise<ExtractedDocument> {
    const form = new FormData();
    form.set("input", new Blob([new Uint8Array(pdf)], { type: "application/pdf" }), "paper.pdf");
    form.set("segmentSentences", "1");
    form.set("consolidateCitations", "0");
    form.set("consolidateHeader", "0");
    form.set("includeRawCitations", "1");

    const res = await fetch(`${this.baseUrl}/api/processFulltextDocument`, {
      method: "POST",
      body: form,
      signal: AbortSignal.timeout(this.timeoutMs),
    });
    // 503 = GROBID's worker pool is busy; the job is retried with backoff.
    if (!res.ok) throw new Error(`GROBID ${res.status}: ${(await res.text()).slice(0, 200)}`);
    return parseTei(await res.text());
  }
}
