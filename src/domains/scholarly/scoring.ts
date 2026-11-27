/**
 * Deterministic existence scoring for scholarly references. No I/O, no LLM.
 * See DECISIONS.md §Existence resolution (M2) for the thresholds and the evidence behind them.
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
  ScoringContext,
} from "../../core/types.js";


/** Lowercase words in any script: strips markup, diacritics, braces, punctuation and PDF line-break hyphenation. */
export function normalizeTitle(title: string): string {
  return title
    .replace(/<[^>]+>/g, " ")
    .replace(/(\p{L})- +(\p{Ll})/gu, "$1$2") // "Convolu- tional" → "Convolutional"
    .normalize("NFKD")
    .replace(/\p{M}/gu, "")
    .replace(/[{}]/g, "")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, " ")
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

/**
 * Thresholds. Set from the 1706.03762 / 2303.08774 runs (DECISIONS.md); re-check with the
 * eval harness (eval/) before changing any of them.
 */
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
  /** Shared content-token fraction for two full venue names to match. */
  venueTokenOverlap: 0.6,
} as const;

export const scholarlyScorer: ExistenceScorer = { score };

/**
 * A stored candidate is a record of the cited work itself (used to borrow its abstract):
 * the title matches AND authors, year or an identifier agree. A title alone can be a
 * different work ("Deep learning", errata, replies).
 */
export function isSameWorkRecord(b: ScoreBreakdown): boolean {
  if (b.titleSimilarity < THRESHOLDS.sameWork) return false;
  return (b.authorOverlap ?? 0) >= THRESHOLDS.authorOverlap || (b.yearDelta !== null && b.yearDelta <= THRESHOLDS.yearTolerance) || b.identifierMatch === true;
}

const NO_CONTEXT: ScoringContext = { facts: {}, failedResolvers: [] };

function score(ref: Reference, candidates: CandidateRecord[], context: ScoringContext = NO_CONTEXT): ExistenceResult {
  const scored = dedupe(candidates)
    .map((candidate) => ({ candidate, breakdown: breakdown(ref, candidate) }))
    .sort((a, b) => b.breakdown.total - a.breakdown.total);

  if (!ref.title && !ref.doi && !ref.arxivId) {
    return { verdict: "AMBIGUOUS", match: null, mismatches: [], scored, reason: "No title or identifier was extracted, so the reference can't be looked up." };
  }

  const same = scored.filter(({ candidate: c, breakdown: b }) => isSameWork(ref, c, b));

  if (same.length === 0) return notFound(ref, scored, context);

  const match = same[0]!;
  const mismatches = fieldMismatches(ref, same, scored, context);
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
  const idOnly = mismatches.every((m) => m === "doi" || m === "arxivId");
  // Identifier mismatches rest on direct lookups (registry / lookup record), not on agreement.
  if (mismatches.length > 0 && sources.size < 2 && !idOnly) {
    return {
      verdict: "AMBIGUOUS",
      match,
      mismatches,
      scored,
      reason: `Only one source (${where}) has this work, and it disagrees on: ${mismatches.join(", ")}. Needs corroboration.`,
    };
  }
  // Citation styles abbreviate venues in too many ways for a venue alone to accuse anyone.
  if (mismatches.length === 1 && mismatches[0] === "venue") {
    return { verdict: "AMBIGUOUS", match, mismatches, scored, reason: `Found in ${where}; only the venue differs ("${ref.venue}" vs "${match.candidate.venue}").` };
  }
  return mismatches.length === 0
    ? { verdict: "VERIFIED", match, mismatches, scored, reason: `Matched ${where}.` }
    : { verdict: "MISMATCH", match, mismatches, scored, reason: `Found in ${where}, but these fields disagree: ${mismatches.join(", ")}.` };
}

/**
 * Same work as the cited reference? Title similarity >= 0.9; or a looser title with a matching
 * identifier; or main title vs title + subtitle with author agreement. A record found by looking
 * up the cited identifier also counts when authors and year agree or the cited "title" is really
 * its venue (journal-style references without an article title).
 */
function isSameWork(ref: Reference, c: CandidateRecord, b: ScoreBreakdown): boolean {
  if (!ref.title) return b.identifierMatch === true;
  if (b.titleSimilarity >= THRESHOLDS.sameWork) return true;
  if (b.identifierMatch === true && b.titleSimilarity >= THRESHOLDS.sameWorkWithId) return true;
  const authorsAgree = (b.authorOverlap ?? 0) >= THRESHOLDS.authorOverlap;
  if (c.title !== null && isTitlePrefix(ref.title, c.title) && authorsAgree) return true;
  if (c.lookup) {
    const yearOk = b.yearDelta === null || b.yearDelta <= THRESHOLDS.yearTolerance;
    return (authorsAgree && yearOk) || venuesMatch(ref.title, c.venue) === true;
  }
  return false;
}

function notFound(ref: Reference, scored: ScoredCandidate[], context: ScoringContext): ExistenceResult {
  if (context.failedResolvers.length > 0) {
    return {
      verdict: "AMBIGUOUS",
      match: null,
      mismatches: [],
      scored,
      reason: `Not found, but some lookups failed (${context.failedResolvers.join(", ")}), so it can't be ruled out.`,
    };
  }
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
  const doiTarget = scored.find((s) => s.candidate.lookup === "doi");
  const reason = context.facts["doi.registered"] === false
    ? "The cited DOI is not registered with any DOI agency, and the cited title was not found."
    : doiTarget
    ? `The cited DOI resolves to a different work ("${doiTarget.candidate.title}") and the cited title was not found.`
    : isWebPage(ref)
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

/** Citation points at a web page: a URL and no DOI/arXiv id. Scholarly indexes don't cover these. */
export function isWebPage(ref: Reference): boolean {
  return !ref.doi && !ref.arxivId && /https?:\/\/|www\./i.test(ref.raw ?? "");
}

/**
 * A field fails only if NO record of the same work agrees; unknown values never fail.
 * Identifiers need direct evidence: the registry says the DOI doesn't exist, arXiv says the
 * id doesn't exist, or looking the identifier up returned a different work. A record merely
 * carrying another DOI proves nothing (works have several DOIs; DataCite vs Crossref).
 */
function fieldMismatches(ref: Reference, same: ScoredCandidate[], scored: ScoredCandidate[], ctx: ScoringContext): MismatchField[] {
  const out: MismatchField[] = [];
  const b = same.map((s) => s.breakdown);
  if (!b.some((x) => x.authorOverlap === null || x.authorOverlap >= THRESHOLDS.authorOverlap)) out.push("authors");
  if (!b.some((x) => x.yearDelta === null || x.yearDelta <= THRESHOLDS.yearTolerance)) out.push("year");
  if (!b.some((x) => x.venueMatch !== false)) out.push("venue");
  const pointsElsewhere = (kind: "doi" | "arxivId") =>
    scored.some((s) => s.candidate.lookup === kind && !same.includes(s));
  if (ref.doi && (ctx.facts["doi.registered"] === false || pointsElsewhere("doi"))) out.push("doi");
  if (ref.arxivId && (ctx.facts["arxiv.exists"] === false || pointsElsewhere("arxivId"))) out.push("arxivId");
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
const NON_SURNAMES = new Set(["al", "others", "collaboration", "team", "consortium", "group", "committee", "project", "initiative", "contributors"]);

function surnameOverlap(cited: Author[], record: Author[]): number | null {
  // Group authors ("ATLAS Collaboration", "Gemini Team") can't be matched against individuals.
  const surnames = cited.map((a) => normalizeTitle(a.surname).split(" ").at(-1) ?? "").filter((s) => s.length > 1 && !NON_SURNAMES.has(s));
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

/** Canonical DOI: lowercase, no resolver prefix, no "doi:", no %-encoding, no trailing punctuation. */
export function normDoi(doi: string | null | undefined): string | null {
  if (!doi) return null;
  let d = doi.trim().toLowerCase();
  try {
    d = decodeURIComponent(d);
  } catch {
    // keep as is
  }
  d = d
    .replace(/^(https?:\/\/)?(dx\.)?doi\.org\//, "")
    .replace(/^doi:\s*/, "")
    .replace(/\s+/g, "")
    .replace(/[.,;]+$/, "");
  return d.startsWith("10.") ? d : null;
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
const ACRONYM_SKIP = new Set(["of", "the", "in", "on", "and", "for", "a", "an"]);

/** "phys" ⊑ "physical", "natl" ⊑ "national", "j" ⊑ "journal": same first letter, letters in order. */
function abbreviates(short: string, long: string): boolean {
  if (short.length > long.length || short[0] !== long[0]) return false;
  let i = 0;
  for (const ch of long) if (ch === short[i]) i++;
  return i === short.length;
}

/** Every token of the shorter list abbreviates (or equals) a distinct token of the longer, in order. */
function abbreviatedForm(a: string[], b: string[]): boolean {
  const [few, many] = a.length <= b.length ? [a, b] : [b, a];
  let j = 0;
  for (const t of few) {
    while (j < many.length && !abbreviates(t, many[j]!) && !abbreviates(many[j]!, t)) j++;
    if (j === many.length) return false;
    j++;
  }
  return true;
}

/** true/false when both venues are known; null if either is missing or a preprint server. */
export function venuesMatch(a: string | null, b: string | null): boolean | null {
  if (!a || !b) return null;
  const words = (s: string) => normalizeTitle(s).replace(/\d+/g, " ").split(" ").filter(Boolean);
  const wa = words(a);
  const wb = words(b);
  const na = wa.join(" ");
  const nb = wb.join(" ");
  if (!na || !nb || PREPRINT.test(na) || PREPRINT.test(nb)) return null;
  const canon = (s: string) => VENUE_ALIASES.find(([, re]) => re.test(s))?.[0] ?? null;
  const ca = canon(na);
  const cb = canon(nb);
  if (ca && cb) return ca === cb;
  // Acronyms from the full name, stopwords like "International Conference" included (ICRA).
  const initials = (ws: string[]) => ws.filter((w) => !ACRONYM_SKIP.has(w)).map((w) => w[0]).join("");
  const isAcronymOf = (acr: string[], full: string[]) => acr.length === 1 && acr[0]!.length >= 3 && full.length >= 3 && abbreviates(acr[0]!, initials(full));
  if (isAcronymOf(wa, wb) || isAcronymOf(wb, wa)) return true;
  const ta = wa.filter((t) => !VENUE_STOPWORDS.has(t));
  const tb = wb.filter((t) => !VENUE_STOPWORDS.has(t));
  if (ta.length === 0 || tb.length === 0) return null;
  if (abbreviatedForm(ta, tb)) return true; // "Phys Rev Lett" vs "Physical Review Letters"
  const sa = new Set(ta);
  const shared = tb.filter((t) => sa.has(t)).length;
  return shared / Math.min(ta.length, tb.length) >= THRESHOLDS.venueTokenOverlap;
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
