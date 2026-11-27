/**
 * Domain-agnostic types and ports for the citation-verification engine.
 *
 * The pipeline only ever talks to these interfaces. A "citation domain"
 * (scholarly papers today; UK/Indian case law later) supplies adapters for
 * them via a `CitationDomain` bundle. See DECISIONS.md §Architecture.
 */

// ---------------------------------------------------------------- references

export interface Author {
  /** Full name as printed, e.g. "Ashish Vaswani". */
  name: string;
  /** Family name used for overlap scoring, e.g. "Vaswani". */
  surname: string;
}

/**
 * One entry in a document's reference list, as extracted.
 * `kind` selects the CitationDomain that knows how to resolve it.
 * Domain-specific identifiers that don't fit the common fields go in `ids`
 * (e.g. a neutral citation "[2023] UKSC 42" for legal references).
 */
export interface Reference {
  kind: string;
  /** Stable key within the document, e.g. GROBID's "b12". */
  key: string;
  title: string | null;
  authors: Author[];
  year: number | null;
  venue: string | null;
  doi: string | null;
  arxivId: string | null;
  ids: Record<string, string>;
  /** Raw reference string as printed, for display and debugging. */
  raw: string | null;
}

/** A place in the citing document where a reference is cited. */
export interface CitationContext {
  /** Key of the Reference this context cites. */
  referenceKey: string;
  /** The full sentence containing the citation marker. */
  sentence: string;
  /** The sentence before it (same paragraph or previous), or null. */
  previousSentence: string | null;
  section: string | null;
  /** The citation marker as printed, e.g. "[13]" or "Vaswani et al., 2017". */
  marker: string;
  /**
   * How the marker was tied to its reference: by the extractor itself ("grobid"), or by
   * our fallback that maps an unlinked numeric marker [n] to entry n of its list.
   */
  linkedBy: "grobid" | "numeric-fallback";
}

export interface ExtractedDocument {
  title: string | null;
  references: Reference[];
  contexts: CitationContext[];
  /** Raw extractor output (GROBID TEI) kept for debugging. */
  raw: string;
}

// ---------------------------------------------------------------- ports

/** Turns a source document (PDF bytes) into references + citation contexts. */
export interface Extractor {
  extract(pdf: Uint8Array): Promise<ExtractedDocument>;
}

/** A record returned by an external source that might be the cited work. */
export interface CandidateRecord {
  source: string;
  sourceId: string;
  title: string | null;
  authors: Author[];
  year: number | null;
  /** Other years the source gives for the same record (e.g. Crossref online vs. print). */
  altYears?: number[];
  venue: string | null;
  doi: string | null;
  arxivId: string | null;
  url: string | null;
  abstract: string | null;
}

/**
 * Looks a reference up in ONE external source. Must never decide existence:
 * it only returns candidate records (possibly none). Errors propagate; the
 * pipeline records them and continues with the other resolvers.
 */
export interface Resolver {
  readonly name: string;
  /**
   * Lower tiers run first. The pipeline stops after a tier once the scorer says VERIFIED,
   * so cheap identifier lookups (tier 1) spare rate-limited searches (tier 3).
   */
  readonly tier: number;
  /** Whether this resolver has anything to query for this reference. */
  applies(ref: Reference): boolean;
  resolve(ref: Reference): Promise<ResolverResult>;
}

export interface ResolverResult {
  candidates: CandidateRecord[];
  /** The raw API response(s), stored for debugging. */
  raw: unknown;
}

export type ExistenceVerdict = "VERIFIED" | "MISMATCH" | "NOT_FOUND" | "AMBIGUOUS";
export const EXISTENCE_VERDICTS: readonly ExistenceVerdict[] = [
  "VERIFIED",
  "MISMATCH",
  "NOT_FOUND",
  "AMBIGUOUS",
];

/** Field-level disagreement between the cited reference and the matched record. */
export type MismatchField = "authors" | "year" | "venue" | "doi" | "arxivId";

export interface ScoreBreakdown {
  titleSimilarity: number;
  /** Fraction of cited surnames found in the candidate (null: no cited authors). */
  authorOverlap: number | null;
  /** |cited year − candidate year| (null if either missing). */
  yearDelta: number | null;
  /** true/false if both venues known, null otherwise. */
  venueMatch: boolean | null;
  /** Cited DOI/arXiv id equals candidate's (null if cited has none). */
  identifierMatch: boolean | null;
  total: number;
}

export interface ScoredCandidate {
  candidate: CandidateRecord;
  breakdown: ScoreBreakdown;
}

export interface ExistenceResult {
  verdict: ExistenceVerdict;
  /** Best candidate (null for NOT_FOUND). */
  match: ScoredCandidate | null;
  mismatches: MismatchField[];
  /** All candidates, scored, best first. */
  scored: ScoredCandidate[];
  /** Short human-readable explanation. */
  reason: string;
}

/** Deterministic, pure. No I/O, no LLM. */
export interface ExistenceScorer {
  score(ref: Reference, candidates: CandidateRecord[]): ExistenceResult;
}

export type RelevanceLabel = "SUPPORTS" | "PARTIAL" | "UNRELATED" | "CANNOT_TELL";
export const RELEVANCE_LABELS: readonly RelevanceLabel[] = [
  "SUPPORTS",
  "PARTIAL",
  "UNRELATED",
  "CANNOT_TELL",
];

/** Text of the cited work that a verifier may compare a context against. */
export interface CitedWorkText {
  title: string;
  abstract: string | null;
}

export interface RelevanceResult {
  verdict: RelevanceLabel;
  reason: string;
  /** "prefilter" (embedding only), "llm", or "skipped" (no abstract). */
  method: "prefilter" | "llm" | "skipped";
  similarity: number | null;
  model: string | null;
}

export interface RelevanceVerifier {
  verify(context: CitationContext, cited: CitedWorkText): Promise<RelevanceResult>;
}

/** Minimal LLM port: one prompt in, one JSON object out. */
export interface LLMProvider {
  readonly model: string;
  completeJSON(req: { system: string; user: string; schema: JsonSchema }): Promise<unknown>;
}

export type JsonSchema = Record<string, unknown>;

/** Fetches a cited work's abstract/summary text, given its matched record. */
export interface AbstractFetcher {
  fetch(record: CandidateRecord): Promise<string | null>;
}

/**
 * Everything the pipeline needs to verify references of one `kind`.
 * Adding legal citations = registering another CitationDomain (plus an Extractor for
 * judgments). Extractors are deliberately NOT part of a domain: one document type can
 * cite several kinds (a judgment cites cases, statutes and articles), so the extractor
 * is chosen per input and each emitted Reference's `kind` picks its domain.
 */
export interface CitationDomain {
  kind: string;
  resolvers: Resolver[];
  scorer: ExistenceScorer;
  abstracts: AbstractFetcher;
}
