import type { ExistenceVerdict, MismatchField, RelevanceLabel } from "../core/types.js";

/** Everything a reporter needs, assembled from Postgres once per paper. Serialized as report.json. */
export interface PaperReport {
  schemaVersion: 1;
  generatedAt: string;
  paper: { id: number; sourceKind: string; source: string; title: string | null; pdfSha256: string | null };
  settings: { relevance: boolean; llm: string | null; verifierVersion: string };
  summary: {
    references: number;
    existence: Partial<Record<ExistenceVerdict | "ERROR", number>>;
    /** References where some lookup failed (their verdict can't be NOT_FOUND). */
    degraded: number;
    relevance: null | {
      /** Citing contexts of references that exist (VERIFIED or MISMATCH). */
      contexts: number;
      verdicts: Partial<Record<RelevanceLabel, number>>;
      /** CANNOT_TELL without a model judgement: no abstract, failure or budget. */
      notJudged: number;
      /** Eligible contexts with no verdict at all (a job that never finished). */
      missing: number;
    };
  };
  /** Shown wherever relevance verdicts appear. */
  relevanceNotice: string;
  references: ReportReference[];
}

export interface ReportRecord {
  source: string;
  sourceId: string;
  title: string | null;
  authors: string[];
  year: number | null;
  venue: string | null;
  doi: string | null;
  arxivId: string | null;
  url: string | null;
}

export interface ReportReference {
  key: string;
  raw: string | null;
  cited: { title: string | null; authors: string[]; year: number | null; venue: string | null; doi: string | null; arxivId: string | null };
  existence: {
    verdict: ExistenceVerdict | "ERROR";
    reason: string;
    degraded: boolean;
    mismatches: { field: MismatchField; cited: string | null; found: string | null }[];
    match: ReportRecord | null;
  };
  contexts: ReportContext[];
}

export interface ReportContext {
  section: string | null;
  marker: string;
  sentence: string;
  previousSentence: string | null;
  linkedBy: string;
  relevance: null | {
    verdict: RelevanceLabel;
    reason: string;
    method: string;
    similarity: number | null;
    model: string | null;
    scope: string;
  };
}

/** A report format. JSON and HTML today; the port lets legal reports reuse the same data. */
export interface Reporter {
  readonly filename: string;
  render(report: PaperReport): string;
}

export const RELEVANCE_NOTICE =
  "Relevance verdicts compare each citing sentence with the cited work's title and abstract only. They are abstract-level, need human review, and are leads for a reviewer, not findings.";
