import { describe, expect, it } from "vitest";
import { esc, htmlReporter, safeUrl } from "./html.js";
import { jsonReporter } from "./json.js";
import { RELEVANCE_NOTICE, type PaperReport, type ReportReference } from "./types.js";

const ref = (o: Partial<ReportReference> & { verdict?: ReportReference["existence"]["verdict"] } = {}): ReportReference => ({
  key: "b0",
  raw: null,
  cited: { title: "Long short-term memory", authors: ["Sepp Hochreiter", "Jürgen Schmidhuber"], year: 1997, venue: "Neural computation", doi: null, arxivId: null },
  existence: { verdict: o.verdict ?? "VERIFIED", reason: "Matched crossref.", degraded: false, mismatches: [], match: null },
  contexts: [],
  ...o,
});

const report = (refs: ReportReference[], relevance = true): PaperReport => ({
  schemaVersion: 1,
  generatedAt: "2026-11-28T00:00:00.000Z",
  paper: { id: 1, sourceKind: "arxiv", source: "1706.03762", title: "Attention Is All You Need", pdfSha256: null },
  settings: { relevance, llm: "anthropic", verifierVersion: "relevance-v2" },
  summary: {
    references: refs.length,
    existence: { VERIFIED: refs.filter((r) => r.existence.verdict === "VERIFIED").length, NOT_FOUND: refs.filter((r) => r.existence.verdict === "NOT_FOUND").length },
    degraded: 0,
    relevance: relevance ? { contexts: 1, verdicts: { SUPPORTS: 1 }, notJudged: 0, missing: 0 } : null,
  },
  relevanceNotice: RELEVANCE_NOTICE,
  references: refs,
});

describe("html report", () => {
  it("escapes everything that comes from PDFs, APIs or the LLM", () => {
    const evil = ref({
      cited: { title: '<img src=x onerror="alert(1)">', authors: ["<b>Mallory</b>"], year: 2020, venue: null, doi: null, arxivId: null },
      contexts: [{ section: "<i>Intro</i>", marker: "[1]", sentence: "We use [1] <script>x()</script>.", previousSentence: null, linkedBy: "grobid", relevance: { verdict: "SUPPORTS", reason: "</p><script>steal()</script>", method: "llm", similarity: 0.5, model: "m", scope: "abstract-level, needs human review" } }],
    });
    const html = htmlReporter.render(report([evil]));
    expect(html).not.toContain("<img src=x");
    expect(html).not.toContain("<script>steal");
    expect(html).not.toContain("<script>x()");
    expect(html).toContain("&lt;img src=x");
    expect(html.match(/<script>/g)).toHaveLength(1); // only the report's own script
  });

  it("links only http(s) URLs", () => {
    expect(safeUrl("javascript:alert(1)")).toBeNull();
    expect(safeUrl("data:text/html,x")).toBeNull();
    expect(safeUrl("https://doi.org/10.1/x")).toBe("https://doi.org/10.1/x");
    const html = htmlReporter.render(report([ref({ existence: { verdict: "VERIFIED", reason: "r", degraded: false, mismatches: [], match: { source: "crossref", sourceId: "x", title: "T", authors: [], year: 2020, venue: null, doi: null, arxivId: null, url: "javascript:alert(1)" } } })]));
    expect(html).not.toContain("javascript:");
  });

  it("opens with a summary line and shows the abstract-level notice when relevance ran", () => {
    const html = htmlReporter.render(report([ref(), ref({ key: "b1", verdict: "NOT_FOUND" })]));
    expect(html).toContain("2 references checked: 1 not found, 1 verified.");
    expect(htmlReporter.render(report([ref({ verdict: "MISMATCH" })]))).not.toContain(" mismatch,");
    expect(html).toContain(esc(RELEVANCE_NOTICE));
    expect(htmlReporter.render(report([ref()], false))).toContain("Relevance was not checked in this run.");
  });

  it("shows each citing sentence with its marker highlighted and its relevance verdict labelled", () => {
    const r = ref({ contexts: [{ section: "Introduction", marker: "[13]", sentence: "Long short-term memory [13] networks.", previousSentence: null, linkedBy: "numeric-fallback", relevance: { verdict: "PARTIAL", reason: "Covers LSTM.", method: "llm", similarity: 0.6, model: "claude-opus-5-5", scope: "abstract-level, needs human review" } }] });
    const html = htmlReporter.render(report([r]));
    expect(html).toContain("<mark>[13]</mark>");
    expect(html).toContain("Partly supports");
    expect(html).toContain("abstract-level, needs human review");
    expect(html).toContain("linked to this reference by its number");
  });

  it("states field mismatches as cited vs found", () => {
    const r = ref({ verdict: "MISMATCH", existence: { verdict: "MISMATCH", reason: "r", degraded: false, mismatches: [{ field: "year", cited: "2019", found: "2016" }], match: null } });
    expect(htmlReporter.render(report([r]))).toContain("cited 2019; found 2016");
  });

  it("renders 200 references and stays one self-contained file", () => {
    const refs = Array.from({ length: 200 }, (_, i) => ref({ key: `b${i}` }));
    const html = htmlReporter.render(report(refs));
    expect(html.match(/<article /g)).toHaveLength(200);
    expect(html).not.toMatch(/<link |src="http|@import/);
  });
});

describe("json report", () => {
  it("round-trips the report", () => {
    const rep = report([ref()]);
    expect(JSON.parse(jsonReporter.render(rep))).toEqual(rep);
  });
});

describe("html report (M4 review)", () => {
  it("highlights a bare numeric marker in the text, never inside an escaped entity", () => {
    const r = ref({ contexts: [{ section: "S", marker: "39", sentence: "It's shown in 39 papers.", previousSentence: null, linkedBy: "grobid", relevance: null }] });
    const html = htmlReporter.render(report([r]));
    expect(html).toContain("It&#39;s shown in <mark>39</mark> papers.");
  });

  it("says how many can't-tell verdicts the model never made", () => {
    const rep = report([ref()]);
    rep.summary.relevance = { contexts: 3, verdicts: { CANNOT_TELL: 2, SUPPORTS: 1 }, notJudged: 2, missing: 0 };
    expect(htmlReporter.render(rep)).toMatch(/2 of the “can't tell” were never judged by the model/);
  });
});
