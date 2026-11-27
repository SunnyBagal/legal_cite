import { describe, expect, it } from "vitest";
import type { Author, CandidateRecord, Reference } from "../../core/types.js";
import { normalizeTitle, scholarlyScorer, titleSimilarity } from "./scoring.js";

describe("normalizeTitle", () => {
  it.each([
    ["Attention Is All You Need", "attention is all you need"],
    ["BERT: Pre-training of Deep Bidirectional Transformers", "bert pre training of deep bidirectional transformers"],
    // GROBID keeps line-break hyphenation from the PDF: "Convolu- tional"
    ["Convolu- tional sequence to sequence learning", "convolutional sequence to sequence learning"],
    ["Deep residual learning for im- age recognition", "deep residual learning for image recognition"],
    ["Ünsupervised  {L}earning of Çát   Features", "unsupervised learning of cat features"],
    ["<i>Escherichia coli</i> growth", "escherichia coli growth"],
  ])("%s → %s", (input, expected) => {
    expect(normalizeTitle(input)).toBe(expected);
  });
});

describe("titleSimilarity", () => {
  it("is 1 for titles that differ only in case, punctuation or hyphenation", () => {
    expect(titleSimilarity("Long Short-Term Memory", "Long short-term memory.")).toBe(1);
  });

  it("stays high for a small typo", () => {
    expect(titleSimilarity("Neural machine translation by jointly learning to align and translate", "Neural machine translation by jointly learning to align and tranlate")).toBeGreaterThan(0.95);
  });

  it("is low for unrelated titles", () => {
    expect(titleSimilarity("Attention is all you need", "Deep residual learning for image recognition")).toBeLessThan(0.5);
  });

  it("is low for a short title against a longer title that starts with it", () => {
    expect(titleSimilarity("Deep learning", "Deep learning for symbolic mathematics")).toBeLessThan(0.75);
  });
});

// ---------------------------------------------------------------- verdicts

const au = (...names: string[]): Author[] =>
  names.map((name) => ({ name, surname: name.split(" ").at(-1)! }));

const REF: Reference = {
  kind: "scholarly",
  key: "b0",
  title: "Deep residual learning for image recognition",
  authors: au("Kaiming He", "Xiangyu Zhang", "Shaoqing Ren", "Jian Sun"),
  year: 2016,
  venue: "Proceedings of the IEEE Conference on Computer Vision and Pattern Recognition",
  doi: null,
  arxivId: null,
  ids: {},
  raw: null,
};
const ref = (o: Partial<Reference> = {}): Reference => ({ ...REF, ...o });

const cand = (o: Partial<CandidateRecord> = {}): CandidateRecord => ({
  source: "crossref",
  sourceId: "10.1109/cvpr.2016.90",
  title: "Deep Residual Learning for Image Recognition",
  authors: au("Kaiming He", "Xiangyu Zhang", "Shaoqing Ren", "Jian Sun"),
  year: 2016,
  venue: "2016 IEEE Conference on Computer Vision and Pattern Recognition (CVPR)",
  doi: "10.1109/cvpr.2016.90",
  arxivId: null,
  url: "https://doi.org/10.1109/cvpr.2016.90",
  abstract: null,
  ...o,
});
const score = (r: Reference, cs: CandidateRecord[]) => scholarlyScorer.score(r, cs);
/** The same record as seen by a second, independent source (MISMATCH needs corroboration). */
const s2 = (o: Partial<CandidateRecord> = {}) => cand({ source: "semantic-scholar", sourceId: "2c03df8b", venue: "Computer Vision and Pattern Recognition", ...o });

describe("scholarlyScorer: verdicts", () => {
  it("VERIFIED when title, authors, year and venue agree", () => {
    const res = score(ref(), [cand()]);
    expect(res.verdict).toBe("VERIFIED");
    expect(res.mismatches).toEqual([]);
    expect(res.match?.candidate.doi).toBe("10.1109/cvpr.2016.90");
  });

  it("NOT_FOUND with no candidates", () => {
    expect(score(ref(), []).verdict).toBe("NOT_FOUND");
  });

  it("NOT_FOUND for a fabricated title whose search hits are unrelated", () => {
    const res = score(ref({ title: "Recursive gradient folding for sparse quantum attention" }), [cand()]);
    expect(res.verdict).toBe("NOT_FOUND");
    expect(res.match).toBeNull();
  });

  it("AMBIGUOUS when the closest title is near but not a match", () => {
    const res = score(ref({ title: "Deep residual learning for video recognition tasks" }), [cand()]);
    expect(res.verdict).toBe("AMBIGUOUS");
  });

  it("MISMATCH(authors) for a real title with swapped authors", () => {
    const res = score(ref({ authors: au("Yann LeCun", "Geoffrey Hinton") }), [cand(), s2()]);
    expect(res.verdict).toBe("MISMATCH");
    expect(res.mismatches).toEqual(["authors"]);
  });

  it("tolerates GROBID's name splitting ('Jimmy Lei Ba' → surname 'Lei Ba')", () => {
    const r = ref({ authors: [{ name: "Jimmy Lei Ba", surname: "Lei Ba" }, ...au("Jamie Kiros", "Geoffrey Hinton")] });
    const c = cand({ authors: au("Jimmy Ba", "Jamie Ryan Kiros", "Geoffrey E. Hinton") });
    expect(score(r, [c]).mismatches).not.toContain("authors");
  });

  it("accepts a year off by one but flags MISMATCH(year) beyond that", () => {
    expect(score(ref({ year: 2015 }), [cand()]).verdict).toBe("VERIFIED");
    const res = score(ref({ year: 2019 }), [cand(), s2()]);
    expect(res.verdict).toBe("MISMATCH");
    expect(res.mismatches).toEqual(["year"]);
  });

  it("passes a field if ANY record of the same work agrees (arXiv v1 year vs. proceedings year)", () => {
    const arxiv = cand({ source: "arxiv", sourceId: "1512.03385", year: 2015, venue: "arXiv", doi: null, arxivId: "1512.03385" });
    const journal = cand({ year: 2018 });
    expect(score(ref({ year: 2018 }), [arxiv, journal]).verdict).toBe("VERIFIED");
  });

  it("MISMATCH(doi) for a real title with a fabricated DOI", () => {
    const res = score(ref({ doi: "10.9999/fake.2016.123" }), [cand(), s2()]);
    expect(res.verdict).toBe("MISMATCH");
    expect(res.mismatches).toEqual(["doi"]);
  });

  it("NOT_FOUND, naming the DOI, when the cited DOI resolves to a different work and the title isn't found", () => {
    const other = cand({ title: "A survey of graph neural networks", doi: "10.1000/xyz", authors: au("A Person") });
    const res = score(ref({ title: "Fabricated title about residual quantum widgets", doi: "10.1000/xyz" }), [other]);
    expect(res.verdict).toBe("NOT_FOUND");
    expect(res.reason).toMatch(/DOI/);
  });

  it("matches venues by acronym and ignores preprint venues", () => {
    const neurips = { title: "Attention is all you need", authors: au("Ashish Vaswani", "Noam Shazeer"), year: 2017 };
    const r = ref({ ...neurips, venue: "NeurIPS" });
    expect(score(r, [cand({ ...neurips, venue: "Advances in Neural Information Processing Systems 30" })]).verdict).toBe("VERIFIED");
    expect(score(r, [cand({ ...neurips, venue: "arXiv (Cornell University)" })]).verdict).toBe("VERIFIED");
    const wrong = score(ref({ ...neurips, venue: "International Conference on Machine Learning" }), [
      cand({ ...neurips, venue: "Advances in Neural Information Processing Systems" }),
      s2({ ...neurips, venue: "Neural Information Processing Systems" }),
    ]);
    expect(wrong.mismatches).toEqual(["venue"]);
  });

  it("AMBIGUOUS, not MISMATCH, when only one source has the work and it disagrees", () => {
    // 2303.08774: a book review titled "Superintelligence" in Crossref; an S2 record dated 2026.
    const res = score(ref({ authors: au("Nick Bostrom") }), [cand()]);
    expect(res.verdict).toBe("AMBIGUOUS");
    expect(res.mismatches).toEqual(["authors"]);
    expect(res.reason).toMatch(/only one source/i);
  });

  it("accepts any of Crossref's publication years (online-first vs. print issue)", () => {
    // 2303.08774 b135: issued 2020 (online), print issue 2022, cited 2022.
    expect(score(ref({ year: 2022 }), [cand({ year: 2020, altYears: [2020, 2022] }), s2({ year: 2020 })]).verdict).toBe("VERIFIED");
  });

  it("explains a NOT_FOUND web page instead of implying it was fabricated", () => {
    const res = score(ref({ title: "Introducing the new Bing", authors: [], raw: '"Introducing the new Bing." https://www.bing.com/new.' }), []);
    expect(res.verdict).toBe("NOT_FOUND");
    expect(res.reason).toMatch(/web page/i);
  });

  it("AMBIGUOUS, not MISMATCH, for a short generic title with no author agreement", () => {
    const res = score(ref({ title: "Deep learning", authors: au("Ian Goodfellow") }), [cand({ title: "Deep learning", authors: au("Yann LeCun", "Yoshua Bengio", "Geoffrey Hinton"), year: 2015, venue: "Nature" })]);
    expect(res.verdict).toBe("AMBIGUOUS");
  });

  it("VERIFIED by identifier when GROBID lost the title", () => {
    const r = ref({ title: null, arxivId: "1512.03385", venue: null });
    expect(score(r, [cand({ arxivId: "1512.03385" })]).verdict).toBe("VERIFIED");
  });

  it("AMBIGUOUS when there is no title and no identifier to check", () => {
    expect(score(ref({ title: null }), [cand()]).verdict).toBe("AMBIGUOUS");
  });

  it("returns every candidate scored, best first, with a full breakdown", () => {
    const res = score(ref(), [cand({ title: "Something else entirely", doi: "10.1/x", sourceId: "10.1/x" }), cand()]);
    expect(res.scored.map((s) => s.candidate.doi)).toEqual(["10.1109/cvpr.2016.90", "10.1/x"]);
    expect(res.scored[0]?.breakdown).toMatchObject({ titleSimilarity: 1, authorOverlap: 1, yearDelta: 0, venueMatch: true });
  });
});

describe("scholarlyScorer: cited main title vs. record title + subtitle", () => {
  it("is the same work when the record's title starts with the cited title and the authors agree", () => {
    // 1706.03762 b26 cites "A decomposable attention model" (EMNLP 2016).
    const parikh = au("Ankur Parikh", "Oscar Täckström", "Dipanjan Das", "Jakob Uszkoreit");
    const r = ref({ title: "A decomposable attention model", authors: parikh, venue: "Empirical Methods in Natural Language Processing" });
    const full = { title: "A Decomposable Attention Model for Natural Language Inference", authors: parikh, venue: "EMNLP" };
    expect(score(r, [cand(full), s2(full)]).verdict).toBe("VERIFIED");
  });

  it("is not the same work when only the title prefix agrees", () => {
    // 2303.08774 b176: "AI and Job Quality" (Partnership on AI report) vs an SSRN paper.
    const r = ref({ title: "AI and Job Quality", authors: au("Partnership AI") });
    const ssrn = cand({ title: "AI and Job Quality: Insights from Frontline Workers", authors: au("Someone Else") });
    expect(score(r, [ssrn]).verdict).not.toMatch(/VERIFIED|MISMATCH/);
  });

  it("needs at least 4 words for a prefix match", () => {
    const r = ref({ title: "Deep learning", authors: au("Ian Goodfellow") });
    expect(score(r, [cand({ title: "Deep learning for symbolic mathematics", authors: au("Ian Goodfellow") })]).verdict).not.toBe("VERIFIED");
  });
});

describe("scholarlyScorer: book reviews that share the book's title", () => {
  it("is AMBIGUOUS, not MISMATCH(authors), when a record is titled '<cited title> by <cited author>'", () => {
    // 2303.08774 b133 "What We Owe The Future" (MacAskill): only reviews are indexed.
    const r = ref({ title: "What We Owe The Future", authors: au("William MacAskill"), year: 2022, venue: null });
    const review = (o: Partial<CandidateRecord>) => cand({ title: "What We Owe The Future", year: 2022, venue: "TPM", authors: au("Jean Kazez"), ...o });
    const res = score(r, [
      review({}),
      s2({ title: "What We Owe The Future", year: 2022, authors: au("Jean Kazez"), venue: null }),
      cand({ sourceId: "x", title: "What We Owe the Future by William MacAskill", year: 2024, authors: au("Daniel Sportiello") }),
    ]);
    expect(res.verdict).toBe("AMBIGUOUS");
    expect(res.reason).toMatch(/review/i);
  });
});
