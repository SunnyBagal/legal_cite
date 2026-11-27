import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { parseTei } from "./tei.js";

// Real GROBID 0.9.1-crf output for arXiv 1706.03762v7 ("Attention Is All You Need"),
// produced with segmentSentences=1, consolidateCitations=0, includeRawCitations=1.
const tei = readFileSync(new URL("../../../test/fixtures/attention.tei.xml", import.meta.url), "utf8");
const doc = parseTei(tei);
const ref = (key: string) => {
  const r = doc.references.find((x) => x.key === key);
  if (!r) throw new Error(`no reference ${key}`);
  return r;
};

describe("parseTei: bibliography", () => {
  it("reads every listBibl entry and not the paper's own header", () => {
    expect(doc.references).toHaveLength(40);
    expect(doc.references.map((r) => r.key)).toContain("b39");
    expect(doc.references.some((r) => r.title === "Attention Is All You Need")).toBe(false);
  });

  it("takes the article-level title for analytic entries and the monograph title otherwise", () => {
    expect(ref("b7").title).toBe("Recurrent neural network grammars");
    expect(ref("b1").title).toBe("Neural machine translation by jointly learning to align and translate");
  });

  it("reads authors as full name + surname, in order", () => {
    expect(ref("b12").authors).toEqual([
      { name: "Sepp Hochreiter", surname: "Hochreiter" },
      { name: "Jürgen Schmidhuber", surname: "Schmidhuber" },
    ]);
    expect(ref("b7").authors[3]).toEqual({ name: "Noah A Smith", surname: "Smith" });
  });

  it("reads year, venue and the raw reference string", () => {
    const b12 = ref("b12");
    expect(b12.year).toBe(1997);
    expect(b12.venue).toBe("Neural computation");
    expect(b12.raw).toMatch(/^Sepp Hochreiter and Jürgen Schmidhuber\. Long short-term memory/);
  });

  it("finds arXiv ids whether GROBID typed them or left them as 'CoRR, abs/…'", () => {
    expect(ref("b0").arxivId).toBe("1607.06450");
    expect(ref("b1").arxivId).toBe("1409.0473");
    expect(ref("b12").arxivId).toBeNull();
  });

  it("recovers a title GROBID misfiled into the report_type note", () => {
    // b0: <title/> empty, <note type="report_type">Layer normalization. arXiv preprint</note>
    expect(ref("b0").title).toBe("Layer normalization");
  });

  it("reads the paper title from the header", () => {
    expect(doc.title).toBe("Attention Is All You Need");
  });
});

describe("parseTei: citation contexts", () => {
  const contextsFor = (key: string) => doc.contexts.filter((c) => c.referenceKey === key);

  it("emits one context per in-text bibr ref that points at a bibliography entry", () => {
    // The fixture has 58 <ref type="bibr"> elements.
    expect(doc.contexts).toHaveLength(58);
    const keys = new Set(doc.references.map((r) => r.key));
    expect(doc.contexts.every((c) => keys.has(c.referenceKey))).toBe(true);
  });

  it("captures the full citing sentence, with marker text, and the sentence before it", () => {
    const [ctx] = contextsFor("b20"); // "factorization tricks [21]"
    expect(ctx?.sentence).toBe(
      "Recent work has achieved significant improvements in computational efficiency through factorization tricks [21] and conditional computation [32], while also improving model performance in case of the latter.",
    );
    expect(ctx?.previousSentence).toBe(
      "This inherently sequential nature precludes parallelization within training examples, which becomes critical at longer sequence lengths, as memory constraints limit batching across examples.",
    );
    expect(ctx?.section).toBe("Introduction");
  });

  it("has no previous sentence for the first sentence of the document body", () => {
    const [ctx] = contextsFor("b12"); // LSTM [13], first body sentence
    expect(ctx?.sentence).toMatch(/^Recurrent neural networks, long short-term memory \[13\]/);
    expect(ctx?.previousSentence).toBeNull();
  });

  it("takes the previous sentence from the preceding paragraph when the citation opens a paragraph", () => {
    const ctx = contextsFor("b1").find((c) => c.sentence.startsWith("Attention mechanisms"));
    expect(ctx?.previousSentence).toBe("The fundamental constraint of sequential computation, however, remains.");
  });

  it("records that every fixture context was linked by GROBID", () => {
    expect(doc.contexts.every((c) => c.linkedBy === "grobid")).toBe(true);
  });

  it("gives each reference in a grouped citation [35,2,5] its own context", () => {
    const sentence = (k: string) => contextsFor(k).map((c) => c.sentence)[0];
    expect(sentence("b34")).toBe(sentence("b4"));
    expect(sentence("b34")).toMatch(/\[35,2,5\]\.$/);
  });
});

// Real GROBID output for arXiv 2303.08774 (GPT-4 Technical Report + appended System Card).
// The PDF has two numbered reference lists that GROBID concatenates into one listBibl
// (report: b0–b84, system card: b85–b189). GROBID leaves markers whose number exists in
// both lists unlinked (no @target), so 181 of 202 markers arrive without a target.
describe("parseTei: numeric markers GROBID could not link", () => {
  const gpt4 = parseTei(
    readFileSync(new URL("../../../test/fixtures/gpt4.tei.xml", import.meta.url), "utf8"),
  );
  const keysFor = (sentencePart: string) =>
    gpt4.contexts.filter((c) => c.sentence.includes(sentencePart)).map((c) => c.referenceKey);

  it("keeps citations that appear in footnotes", () => {
    expect(gpt4.contexts.filter((c) => c.linkedBy === "grobid")).toHaveLength(21);
  });

  it("links unlinked [n] markers in the report to the report's list", () => {
    // "On the MMLU benchmark [35,36]" → b34 = Hendrycks et al., Measuring massive multitask language understanding
    expect(keysFor("On the MMLU benchmark")).toEqual(["b34", "b35"]);
    const ctx = gpt4.contexts.find((c) => c.sentence.startsWith("On the MMLU benchmark"));
    expect(ctx?.linkedBy).toBe("numeric-fallback");
  });

  it("links unlinked [n] markers in the appended system card to the second list", () => {
    // System card "few-shot learning [10]" → its 10th entry, b94 = Brown et al. (GPT-3)
    expect(keysFor("Training language models on large text datasets")).toContain("b94");
  });

  it("does not treat numbers that aren't citation markers (e.g. '85.6') as references", () => {
    expect(gpt4.contexts.some((c) => c.marker === "85.6")).toBe(false);
  });
});
