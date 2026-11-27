import { existsSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { findArxivId, parseTei } from "./tei.js";

// Real GROBID 0.9.1-crf output for arXiv 1706.03762v7 ("Attention Is All You Need"),
// produced with segmentSentences=1, consolidateCitations=0, includeRawCitations=1.
// Real-paper fixtures are not committed (arXiv licence); `pnpm fixtures` regenerates them.
function loadFixture(name: string): string {
  const url = new URL(`../../../test/fixtures/${name}.tei.xml`, import.meta.url);
  if (!existsSync(url)) throw new Error(`missing fixture ${name}.tei.xml: run \`docker compose up -d && pnpm fixtures\``);
  return readFileSync(url, "utf8");
}

const tei = loadFixture("attention");
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
    loadFixture("gpt4"),
  );
  const keysFor = (sentencePart: string) =>
    gpt4.contexts.filter((c) => c.sentence.includes(sentencePart)).map((c) => c.referenceKey);

  it("keeps every GROBID-linked citation: body (incl. footnotes) and back-matter annex", () => {
    // 21 linked refs in <body> (5 of them in footnotes) + 1 in a <back> annex.
    expect(gpt4.contexts.filter((c) => c.linkedBy === "grobid")).toHaveLength(22);
    expect(gpt4.contexts.filter((c) => c.section === "Footnote" && c.linkedBy === "grobid")).toHaveLength(5);
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

// ---------------------------------------------------------------- synthetic TEI (no fixtures needed)

const bibl = (key: string, inner = `<monogr><title level="m">Work ${key}</title></monogr>`) =>
  `<biblStruct xml:id="${key}">${inner}</biblStruct>`;
const sec = (n: string | null, ...sentences: string[]) =>
  `<div>${n === null ? "" : `<head n="${n}">S${n}</head>`}<p>${sentences.map((s) => `<s>${s}</s>`).join("")}</p></div>`;
const teiDoc = (o: { body: string; keys: string[]; abstract?: string; back?: string; bibls?: string }) =>
  `<TEI xmlns="http://www.tei-c.org/ns/1.0"><teiHeader><profileDesc><abstract>${o.abstract ?? ""}</abstract></profileDesc></teiHeader>` +
  `<text><body>${o.body}</body><back>${o.back ?? ""}<div type="references"><listBibl>${o.bibls ?? o.keys.map((k) => bibl(k)).join("")}</listBibl></div></back></text></TEI>`;
const bibr = (text: string, target?: string) => `<ref type="bibr"${target ? ` target="#${target}"` : ""}>${text}</ref>`;
const keysOf = (tei: string) => parseTei(tei).contexts.map((c) => c.referenceKey);
const K4 = ["b0", "b1", "b2", "b3"];

describe("parseTei: numeric fallback edge cases (synthetic)", () => {
  it("offsets a segment with no GROBID links by the previous segment's highest marker", () => {
    const body = sec("1", `A ${bibr("[1]")}.`) + sec("2", `B ${bibr("[2]")}.`) + sec("1", `C ${bibr("[1]")}.`);
    expect(keysOf(teiDoc({ body, keys: K4 }))).toEqual(["b0", "b1", "b2"]);
  });

  it("does not start a new segment on a sub-section head like n=\"1.1\"", () => {
    const body = sec("2", `A ${bibr("[1]")}.`) + sec("1.1", `B ${bibr("[2]")}.`);
    expect(keysOf(teiDoc({ body, keys: K4 }))).toEqual(["b0", "b1"]);
  });

  it("expands several bracket groups inside one ref, e.g. '[1] [2]' and '[3][4]'", () => {
    const body = sec("1", `A ${bibr("[1] [2]")} and B ${bibr("[3][4]")}.`);
    expect(keysOf(teiDoc({ body, keys: K4 }))).toEqual(["b0", "b1", "b2", "b3"]);
  });

  it("ignores bare numbers GROBID mis-tags as citations (figure numbers, scores)", () => {
    const body = sec("1", `Figure ${bibr("1")}.`, `Score ${bibr("85.6")} and ${bibr("3%")}.`, `Real ${bibr("[2,")}${bibr("3")}${bibr("4]")}.`);
    expect(keysOf(teiDoc({ body, keys: K4 }))).toEqual(["b1", "b2", "b3"]);
  });

  it("expands a GROBID-linked range marker to every number in the range", () => {
    const body = sec("1", `A ${bibr("[2-4]", "b1")}.`);
    expect(keysOf(teiDoc({ body, keys: K4 }))).toEqual(["b1", "b2", "b3"]);
  });

  it("falls back to the number when @target names no bibliography entry", () => {
    const body = sec("1", `A ${bibr("[2]", "b99")}.`);
    expect(keysOf(teiDoc({ body, keys: K4 }))).toEqual(["b1"]);
  });

  it("attributes a citation that GROBID pushed to the start of the next sentence to the sentence before", () => {
    const body = sec("1", "Zero.", "First claim.", `${bibr("[1,")}${bibr("2]")} Next sentence.`);
    const ctx = parseTei(teiDoc({ body, keys: K4 })).contexts;
    expect(ctx.map((c) => c.sentence)).toEqual(["First claim.", "First claim."]);
    expect(ctx[0]?.previousSentence).toBe("Zero.");
  });

  it("resolves footnote markers with the segment of the footnote's anchor, not the last segment", () => {
    const body =
      sec("1", `A ${bibr("[1]")} see note<ref type="foot" target="#foot_0">1</ref>.`) +
      sec("2", `B ${bibr("[2]")}.`) +
      sec("1", `C ${bibr("[1]")}.`) +
      `<note place="foot" xml:id="foot_0"><p><s>Footnote cites ${bibr("[2]")}.</s></p></note>`;
    const ctx = parseTei(teiDoc({ body, keys: K4 })).contexts;
    expect(ctx.find((c) => c.section === "Footnote")?.referenceKey).toBe("b1");
  });

  it("never links past the end of a segment's list into the next segment's list", () => {
    // Segment 0's list is b0–b1 (learned from the link); [3] in segment 0 has no entry.
    const body = sec("1", `A ${bibr("[1]", "b0")} ${bibr("[3]")}.`) + sec("2", "x") + sec("1", `B ${bibr("[1]", "b2")}.`);
    expect(keysOf(teiDoc({ body, keys: K4 }))).toEqual(["b0", "b2"]);
  });

  it("captures citations in the abstract and in back-matter annexes", () => {
    const tei = teiDoc({
      abstract: `<div><p><s>Abstract cites ${bibr("[1]")}.</s></p></div>`,
      body: sec("1", `Body ${bibr("[2]")}.`),
      back: `<div type="annex">${sec("A", `Appendix cites ${bibr("[3]")}.`)}</div>`,
      keys: K4,
    });
    const ctx = parseTei(tei).contexts;
    expect(ctx.map((c) => [c.referenceKey, c.section])).toEqual([
      ["b0", "Abstract"],
      ["b1", "S1"],
      ["b2", "SA"],
    ]);
  });
});

describe("parseTei: bibliography edge cases (synthetic)", () => {
  it("uses the monograph title when GROBID leaves the analytic title empty", () => {
    const inner = `<analytic><title/><author><persName><surname>Bai</surname></persName></author></analytic><monogr><title level="j">Training a helpful assistant</title></monogr>`;
    const [r] = parseTei(teiDoc({ body: "", keys: [], bibls: bibl("b0", inner) })).references;
    expect(r?.title).toBe("Training a helpful assistant");
    expect(r?.venue).toBeNull();
  });

  it("gives entries without an xml:id a unique key", () => {
    const bibls = `<biblStruct><monogr><title>X</title></monogr></biblStruct><biblStruct><monogr><title>Y</title></monogr></biblStruct>`;
    const keys = parseTei(teiDoc({ body: "", keys: [], bibls })).references.map((r) => r.key);
    expect(new Set(keys).size).toBe(2);
  });
});

describe("findArxivId", () => {
  it.each([
    ["arXiv:hep-th/9711200v2", "hep-th/9711200"],
    ["CoRR, abs/cs/0112017", "cs/0112017"],
    ["arXiv preprint arXiv:2303.08774v3", "2303.08774"],
    ["Neural computation, 9(8)", null],
  ])("%s → %s", (t, id) => {
    expect(findArxivId([t])).toBe(id);
  });
});

describe("parseTei: regressions found in review (gpt4 fixture)", () => {
  const gpt4 = parseTei(loadFixture("gpt4"));

  it("b102 (empty analytic title) keeps its title instead of storing it as the venue", () => {
    const b102 = gpt4.references.find((r) => r.key === "b102");
    expect(b102?.title).toMatch(/^Training a Helpful and Harmless Assistant/i);
    expect(b102?.venue).toBeNull();
  });

  it("does not turn figure captions into citation contexts", () => {
    expect(gpt4.contexts.filter((c) => /^Figure \d/.test(c.sentence))).toEqual([]);
  });

  it("links both groups of '[77] [78]' and '[89][90]'", () => {
    expect(gpt4.contexts.filter((c) => c.marker === "[77] [78]")).toHaveLength(2);
    expect(gpt4.contexts.filter((c) => c.marker === "[89][90]")).toHaveLength(2);
  });
});

describe("parseTei: publisher glued onto a book title (synthetic)", () => {
  it.each([
    ["Superintelligence: Paths, Dangers, Strategies. University Press", "Superintelligence: Paths, Dangers, Strategies"],
    ["What We Owe The Future. Basic Books", "What We Owe The Future"],
    ["Zen and the Art of the Internet. Project Gutenberg", "Zen and the Art of the Internet"],
    ["Dr. Strangelove and the bomb", "Dr. Strangelove and the bomb"],
    ["Superintelligence: Paths, Dangers, Strategies. United Kingdom: Oxford University Press", "Superintelligence: Paths, Dangers, Strategies"],
    // IEEE style: the quoted title's closing quote kept the rest of the reference.
    ['Truth, Lies, and Automation," tech. rep., Center for Security and Emerging Technology', "Truth, Lies, and Automation"],
  ])("%s → %s", (raw, expected) => {
    const bibls = `<biblStruct xml:id="b0"><monogr><title level="m">${raw}</title></monogr></biblStruct>`;
    expect(parseTei(teiDoc({ body: "", keys: [], bibls })).references[0]?.title).toBe(expected);
  });
});

describe("parseTei: untitled journal-style references (M2 review, synthetic)", () => {
  it("keeps the journal as venue, not title, when the article title is omitted (Nature/PRL style)", () => {
    const inner = `<analytic><author><persName><surname>Abbott</surname></persName></author><idno type="DOI">10.1103/PhysRevLett.116.061102</idno></analytic>
      <monogr><title level="j">Phys. Rev. Lett.</title><imprint><biblScope unit="volume">116</biblScope><biblScope unit="page">061102</biblScope><date type="published" when="2016"/></imprint></monogr>`;
    const [r] = parseTei(teiDoc({ body: "", keys: [], bibls: bibl("b0", inner) })).references;
    expect(r).toMatchObject({ title: null, venue: "Phys. Rev. Lett.", doi: "10.1103/physrevlett.116.061102" });
  });

  it("derives the arXiv id from an arXiv DataCite DOI", () => {
    const inner = `<monogr><title level="m">Some preprint</title></monogr><idno type="DOI">10.48550/arXiv.2303.08774</idno>`;
    expect(parseTei(teiDoc({ body: "", keys: [], bibls: bibl("b0", inner) })).references[0]?.arxivId).toBe("2303.08774");
  });

  it("leaves article titles containing quotes alone (publisher stripping is for book titles)", () => {
    const inner = `<analytic><title level="a">Beyond "Accuracy," Toward Calibrated Models</title></analytic><monogr><title level="j">TMLR</title></monogr>`;
    expect(parseTei(teiDoc({ body: "", keys: [], bibls: bibl("b0", inner) })).references[0]?.title).toBe('Beyond "Accuracy," Toward Calibrated Models');
  });

  it("strips a publisher suffix in linear time on pathological input", () => {
    const evil = `Some title here. ${"A".repeat(5000)}!`;
    const inner = `<monogr><title level="m">${evil}</title></monogr>`;
    const t0 = performance.now();
    parseTei(teiDoc({ body: "", keys: [], bibls: bibl("b0", inner) }));
    expect(performance.now() - t0).toBeLessThan(200); // gstack-timing-ok: ReDoS guard; quadratic backtracking took >600 ms at n=38
  });
});

describe("parseTei: appended-document boundaries (M3 relevance findings)", () => {
  it("puts an unnumbered Abstract just before the numbering restart into the new segment", () => {
    const body =
      sec("1", `A ${bibr("[1]")}.`) + sec("2", `B ${bibr("[2]")}.`) +
      `<div><head>System Card</head><p><s>x</s></p></div>` +
      `<div><head>Abstract</head><p><s>Card abstract cites ${bibr("[1]")}.</s></p></div>` +
      sec("1", `C ${bibr("[1]", "b2")}.`);
    const ctx = parseTei(teiDoc({ body, keys: K4 })).contexts;
    expect(ctx.find((c) => c.sentence.startsWith("Card abstract"))?.referenceKey).toBe("b2");
  });

  it("re-links a GROBID target that lies outside the marker's own segment list", () => {
    // Segment 0 owns b0-b1 (learned), segment 1 owns b2-b3; GROBID linked segment 0's [2] to b3.
    const body = sec("1", `A ${bibr("[1]", "b0")} and ${bibr("[2]", "b3")}.`) + sec("2", "x") + sec("1", `B ${bibr("[1]", "b2")}.`);
    expect(keysOf(teiDoc({ body, keys: K4 }))).toEqual(["b0", "b1", "b2"]);
  });

  it("gpt4: the system card's own Abstract cites the system card's list", () => {
    // Before the fix, "This system card analyzes GPT-4 ... [8,9,10]" linked to b7-b9 (report list).
    const gpt4 = parseTei(loadFixture("gpt4"));
    const card = gpt4.contexts.filter((c) => c.section === "Abstract" && c.sentence.includes("This system card analyzes GPT-4")).map((c) => c.referenceKey);
    expect(card).toEqual(["b92", "b93", "b94"]);
  });
});
