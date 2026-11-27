/**
 * Deterministic existence scoring for scholarly references. No I/O, no LLM.
 * See DECISIONS.md §Existence scoring for the thresholds and their rationale.
 */
import type {
  Author,
  CandidateRecord,
  ExistenceResult,
  ExistenceScorer,
  MismatchField,
  Reference,
  ScoreBreakdown,
  ScoredCandidate,
} from "../../core/types.js";


/** Lowercase ASCII words: strips markup, diacritics, braces, punctuation and PDF line-break hyphenation. */
export function normalizeTitle(title: string): string {
  return title
    .replace(/<[^>]+>/g, " ")
    .replace(/(\p{L})- +(\p{Ll})/gu, "$1$2") // "Convolu- tional" → "Convolutional"
    .normalize("NFKD")
    .replace(/\p{M}/gu, "")
    .replace(/[{}]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

/**
 * Similarity of two titles in [0, 1]: the better of character-level edit similarity and
 * the same on sorted tokens (word order changes).
 */
export function titleSimilarity(a: string, b: string): number {
  const na = normalizeTitle(a);
  const nb = normalizeTitle(b);
  if (!na || !nb) return 0;
  if (na === nb) return 1;
  const sorted = (s: string) => s.split(" ").sort().join(" ");
  return Math.max(editSimilarity(na, nb), editSimilarity(sorted(na), sorted(nb)));
}

/** One title is the other plus a subtitle ("X" vs "X for Natural Language Inference"), 4+ words. */
export function isTitlePrefix(a: string, b: string): boolean {
  const na = normalizeTitle(a);
  const nb = normalizeTitle(b);
  const [short, long] = na.length <= nb.length ? [na, nb] : [nb, na];
  return short.split(" ").length >= 4 && long.startsWith(`${short} `);
}

function editSimilarity(a: string, b: string): number {
  const max = Math.max(a.length, b.length);
  return max === 0 ? 1 : 1 - levenshtein(a, b) / max;
}

function levenshtein(a: string, b: string): number {
  let prev = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    const cur = [i];
    for (let j = 1; j <= b.length; j++) {
      cur[j] = Math.min(prev[j]! + 1, cur[j - 1]! + 1, prev[j - 1]! + (a[i - 1] === b[j - 1] ? 0 : 1));
    }
    prev = cur;
  }
  return prev[b.length]!;
}

// ---------------------------------------------------------------- the scorer

/** Thresholds. Tuned against eval/ (see eval/RESULTS.md); change them only with an eval run. */
export const THRESHOLDS = {
  /** Title similarity at or above which a candidate is the cited work. */
  sameWork: 0.9,
  /** With a matching DOI/arXiv id, a looser title match still counts as the same work. */
  sameWorkWithId: 0.6,
  /** Best title in [nearMiss, sameWork) → AMBIGUOUS rather than NOT_FOUND. */
  nearMiss: 0.75,
  /** Fraction of cited surnames that must appear in the record's author list. */
  authorOverlap: 0.5,
  /** Allowed |cited year − record year| (preprint vs. publication year). */
  yearTolerance: 1,
  /** Titles this short are too generic to call MISMATCH(authors) on; → AMBIGUOUS. */
  genericTitleWords: 3,
} as const;

export const scholarlyScorer: ExistenceScorer = { score };

function score(ref: Reference, candidates: CandidateRecord[]): ExistenceResult {
  const scored = dedupe(candidates)
    .map((candidate) => ({ candidate, breakdown: breakdown(ref, candidate) }))
    .sort((a, b) => b.breakdown.total - a.breakdown.total);

  if (!ref.title && !ref.doi && !ref.arxivId) {
    return { verdict: "AMBIGUOUS", match: null, mismatches: [], scored, reason: "No title or identifier was extracted, so the reference can't be looked up." };
  }

  const same = scored.filter(({ candidate: c, breakdown: b }) =>
    ref.title
      ? b.titleSimilarity >= THRESHOLDS.sameWork ||
        (b.identifierMatch === true && b.titleSimilarity >= THRESHOLDS.sameWorkWithId) ||
        // Main title vs title + subtitle is weaker evidence: only with author agreement.
        (c.title !== null && isTitlePrefix(ref.title, c.title) && (b.authorOverlap ?? 0) >= THRESHOLDS.authorOverlap)
      : b.identifierMatch === true,
  );

  if (same.length === 0) return notFound(ref, scored);

  const match = same[0]!;
  const mismatches = fieldMismatches(ref, same);
  const review = mismatches.includes("authors") ? reviewOfCitedWork(ref, scored) : undefined;
  if (review) {
    return {
      verdict: "AMBIGUOUS",
      match,
      mismatches,
      scored,
      reason: `Records with this title look like reviews of the cited work (e.g. "${review.candidate.title}"); the work itself was not found.`,
    };
  }
  if (mismatches.includes("authors") && ref.title && normalizeTitle(ref.title).split(" ").length <= THRESHOLDS.genericTitleWords) {
    return { verdict: "AMBIGUOUS", match, mismatches, scored, reason: `The title "${ref.title}" is generic and no record with it has matching authors.` };
  }
  const where = `${match.candidate.source} (${match.candidate.sourceId})`;
  // One database record can be wrong (an S2 record dated 2026) or be a different item with
  // the same title (a book review). A MISMATCH needs two independent sources to agree.
  const sources = new Set(same.map((s) => s.candidate.source));
  if (mismatches.length > 0 && sources.size < 2) {
    return {
      verdict: "AMBIGUOUS",
      match,
      mismatches,
      scored,
      reason: `Only one source (${where}) has this work, and it disagrees on: ${mismatches.join(", ")}. Needs corroboration.`,
    };
  }
  return mismatches.length === 0
    ? { verdict: "VERIFIED", match, mismatches, scored, reason: `Matched ${where}.` }
    : { verdict: "MISMATCH", match, mismatches, scored, reason: `Found in ${where}, but these fields disagree: ${mismatches.join(", ")}.` };
}

function notFound(ref: Reference, scored: ScoredCandidate[]): ExistenceResult {
  const closest = scored.reduce<ScoredCandidate | null>(
    (best, s) => (best === null || s.breakdown.titleSimilarity > best.breakdown.titleSimilarity ? s : best),
    null,
  );
  if (ref.title && closest && closest.breakdown.titleSimilarity >= THRESHOLDS.nearMiss) {
    return {
      verdict: "AMBIGUOUS",
      match: null,
      mismatches: [],
      scored,
      reason: `Closest record has a similar but different title (${closest.breakdown.titleSimilarity.toFixed(2)}): "${closest.candidate.title}".`,
    };
  }
  const doiTarget = ref.doi ? scored.find((s) => s.candidate.doi === normDoi(ref.doi)) : undefined;
  const webPage = !ref.doi && !ref.arxivId && /https?:\/\/|www\./i.test(ref.raw ?? "");
  const reason = doiTarget
    ? `The cited DOI resolves to a different work ("${doiTarget.candidate.title}") and the cited title was not found.`
    : webPage
      ? "Not in Crossref, Semantic Scholar, OpenAlex or arXiv. The citation points to a web page, which these indexes don't cover; check the URL by hand."
      : scored.length === 0
        ? "No source returned any candidate."
        : `No record matches the cited ${ref.title ? "title" : "identifier"}.`;
  return { verdict: "NOT_FOUND", match: null, mismatches: [], scored, reason };
}

/** A record titled "<cited title> by <cited author>": a review that names the cited author. */
function reviewOfCitedWork(ref: Reference, scored: ScoredCandidate[]): ScoredCandidate | undefined {
  if (!ref.title) return undefined;
  const title = normalizeTitle(ref.title);
  const surnames = ref.authors.map((a) => normalizeTitle(a.surname).split(" ").at(-1)).filter((s): s is string => Boolean(s && s.length > 1));
  return scored.find((s) => {
    const t = normalizeTitle(s.candidate.title ?? "");
    return t.startsWith(title) && t !== title && surnames.some((n) => t.slice(title.length).split(" ").includes(n));
  });
}

/** A field fails only if NO record of the same work agrees; unknown values never fail. */
function fieldMismatches(ref: Reference, same: ScoredCandidate[]): MismatchField[] {
  const out: MismatchField[] = [];
  const b = same.map((s) => s.breakdown);
  const c = same.map((s) => s.candidate);
  if (!b.some((x) => x.authorOverlap === null || x.authorOverlap >= THRESHOLDS.authorOverlap)) out.push("authors");
  if (!b.some((x) => x.yearDelta === null || x.yearDelta <= THRESHOLDS.yearTolerance)) out.push("year");
  if (!b.some((x) => x.venueMatch !== false)) out.push("venue");
  // Identifiers: flag only when a record of the work carries a different one (DOI lookups of
  // the cited DOI are among the candidates, so works with several DOIs still pass).
  const doi = normDoi(ref.doi);
  if (doi && !c.some((x) => x.doi === doi) && c.some((x) => x.doi)) out.push("doi");
  const arxiv = normArxiv(ref.arxivId);
  if (arxiv && !c.some((x) => normArxiv(x.arxivId) === arxiv) && c.some((x) => x.arxivId)) out.push("arxivId");
  return out;
}

function breakdown(ref: Reference, c: CandidateRecord): ScoreBreakdown {
  const titleSim = ref.title && c.title ? titleSimilarity(ref.title, c.title) : 0;
  const authorOverlap = surnameOverlap(ref.authors, c.authors);
  const years = [c.year, ...(c.altYears ?? [])].filter((y): y is number => typeof y === "number");
  const yearDelta = ref.year && years.length > 0 ? Math.min(...years.map((y) => Math.abs(ref.year! - y))) : null;
  const venueMatch = venuesMatch(ref.venue, c.venue);
  const identifierMatch = idMatch(ref, c);
  const part = (v: number | null, f: (x: number) => number) => (v === null ? 0.5 : f(v));
  const total =
    0.5 * titleSim +
    0.2 * part(authorOverlap, (x) => x) +
    0.1 * part(yearDelta, (d) => (d === 0 ? 1 : d <= THRESHOLDS.yearTolerance ? 0.7 : 0)) +
    0.05 * (venueMatch === null ? 0.5 : venueMatch ? 1 : 0) +
    0.15 * (identifierMatch === null ? 0.5 : identifierMatch ? 1 : 0);
  return { titleSimilarity: round(titleSim), authorOverlap: authorOverlap === null ? null : round(authorOverlap), yearDelta, venueMatch, identifierMatch, total: round(total) };
}

const round = (x: number) => Math.round(x * 1000) / 1000;

/**
 * Fraction of cited surnames found among ALL name tokens of the record's authors.
 * Matching on any token absorbs GROBID's splitting ("Jimmy Lei Ba" → surname "Lei Ba";
 * "Quoc V. Le" → "V Quoc" + "Le"). Null when either side has no authors.
 */
function surnameOverlap(cited: Author[], record: Author[]): number | null {
  const surnames = cited.map((a) => normalizeTitle(a.surname).split(" ").at(-1) ?? "").filter((s) => s.length > 1 && s !== "al" && s !== "others");
  if (surnames.length === 0 || record.length === 0) return null;
  const tokens = new Set(record.flatMap((a) => normalizeTitle(`${a.name} ${a.surname}`).split(" ")));
  return surnames.filter((s) => tokens.has(s)).length / surnames.length;
}

function idMatch(ref: Reference, c: CandidateRecord): boolean | null {
  const checks: boolean[] = [];
  const doi = normDoi(ref.doi);
  const arxiv = normArxiv(ref.arxivId);
  if (doi && c.doi) checks.push(c.doi === doi);
  if (arxiv && c.arxivId) checks.push(normArxiv(c.arxivId) === arxiv);
  return checks.length === 0 ? null : checks.some(Boolean);
}

export function normDoi(doi: string | null | undefined): string | null {
  const d = doi?.trim().toLowerCase().replace(/^(https?:\/\/(dx\.)?doi\.org\/|doi:)/, "");
  return d ? d : null;
}

function normArxiv(id: string | null | undefined): string | null {
  const a = id?.trim().toLowerCase().replace(/^arxiv:/, "").replace(/v\d+$/, "");
  return a ? a : null;
}

// ---------------------------------------------------------------- venues

const PREPRINT = /\b(arxiv|corr|preprint|biorxiv|medrxiv|ssrn|cornell university|openreview)\b/;

/** Ordered: more specific names first (NAACL/TACL contain "association for computational linguistics"). */
const VENUE_ALIASES: [string, RegExp][] = [
  ["neurips", /\b(neurips|nips|neural information processing systems)\b/],
  ["iclr", /\b(iclr|learning representations)\b/],
  ["icml", /\b(icml|international conference on machine learning)\b/],
  ["cvpr", /\b(cvpr|computer vision and pattern recognition)\b/],
  ["iccv", /\b(iccv|international conference on computer vision)\b/],
  ["eccv", /\b(eccv|european conference on computer vision)\b/],
  ["naacl", /\b(naacl|north american chapter)\b/],
  ["eacl", /\b(eacl|european chapter of the association)\b/],
  ["tacl", /\b(tacl|transactions of the association for computational linguistics)\b/],
  ["emnlp", /\b(emnlp|empirical methods in natural language processing)\b/],
  ["acl", /\b(acl|association for computational linguistics)\b/],
  ["aaai", /\baaai\b/],
  ["ijcai", /\b(ijcai|international joint conference on artificial intelligence)\b/],
  ["jmlr", /\b(jmlr|journal of machine learning research)\b/],
];

const VENUE_STOPWORDS = new Set(["of", "the", "in", "on", "and", "for", "proceedings", "proc", "annual", "conference", "conf", "international", "journal", "ieee", "acm", "th", "st", "nd", "rd"]);

/** true/false when both venues are known; null if either is missing or a preprint server. */
export function venuesMatch(a: string | null, b: string | null): boolean | null {
  if (!a || !b) return null;
  const na = normalizeTitle(a).replace(/\d+/g, " ").replace(/\s+/g, " ").trim();
  const nb = normalizeTitle(b).replace(/\d+/g, " ").replace(/\s+/g, " ").trim();
  if (!na || !nb || PREPRINT.test(na) || PREPRINT.test(nb)) return null;
  const canon = (s: string) => VENUE_ALIASES.find(([, re]) => re.test(s))?.[0] ?? null;
  const ca = canon(na);
  const cb = canon(nb);
  if (ca && cb) return ca === cb;
  const ta = na.split(" ").filter((t) => !VENUE_STOPWORDS.has(t));
  const tb = nb.split(" ").filter((t) => !VENUE_STOPWORDS.has(t));
  if (ta.length === 0 || tb.length === 0) return null;
  const acronym = (ts: string[]) => ts.map((t) => t[0]).join("");
  if ((ta.length === 1 && ta[0] === acronym(tb)) || (tb.length === 1 && tb[0] === acronym(ta))) return true;
  const sa = new Set(ta);
  const shared = tb.filter((t) => sa.has(t)).length;
  return shared / Math.min(ta.length, tb.length) >= 0.6;
}

function dedupe(cs: CandidateRecord[]): CandidateRecord[] {
  const seen = new Set<string>();
  return cs.filter((c) => {
    const k = `${c.source}:${c.sourceId}`;
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}
