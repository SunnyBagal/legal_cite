import type { CandidateRecord, CitationDomain, RelevanceResult, RelevanceVerifier, ScoreBreakdown } from "../core/types.js";

export interface ContextRow {
  id: number;
  sentence: string;
  previousSentence: string | null;
  section: string | null;
  marker: string;
  linkedBy: string;
}

export interface ReferenceForRelevance {
  existence: { verdict: string; record: CandidateRecord | null } | null;
  entryTitle: string | null;
  contexts: ContextRow[];
  /** Every stored candidate for the reference, with its score breakdown. */
  candidates: { record: CandidateRecord; breakdown: ScoreBreakdown }[];
  /** Contexts that already have a verdict (an earlier attempt). */
  doneContextIds: Set<number>;
}

export interface RelevanceDeps {
  domain: CitationDomain;
  verifier: RelevanceVerifier;
  save(contextId: number, result: RelevanceResult, citedText: string, abstractSource: string | null): Promise<void>;
  /** LLM calls this paper may still make (per-paper spend cap). */
  llmCallsLeft(): Promise<number>;
  /** Last BullMQ attempt: record failures instead of retrying. */
  finalAttempt: boolean;
}

const skipped = (reason: string): RelevanceResult => ({ verdict: "CANNOT_TELL", reason, method: "skipped", similarity: null, model: null });

/**
 * Judge every not-yet-judged citing context of one reference against the cited work's
 * abstract. Only existing works (VERIFIED/MISMATCH). Failures retry while attempts remain;
 * on the last attempt they are recorded as CANNOT_TELL, never left as silent gaps.
 */
export async function judgeReference(ref: ReferenceForRelevance, deps: RelevanceDeps): Promise<{ judged: number; skipped: string | null }> {
  const { existence } = ref;
  if (!existence?.record || (existence.verdict !== "VERIFIED" && existence.verdict !== "MISMATCH")) {
    return { judged: 0, skipped: `existence ${existence?.verdict ?? "missing"}` };
  }
  const todo = ref.contexts.filter((c) => !ref.doneContextIds.has(c.id));
  if (todo.length === 0) return { judged: 0, skipped: "nothing left to judge" };

  // The matched record first, then other records of the same work (title AND authors/year/id).
  const matched = existence.record;
  const records = [
    matched,
    ...ref.candidates.filter((c) => c.record.sourceId !== matched.sourceId && deps.domain.sameWork(c.breakdown)).map((c) => c.record),
  ];
  const key = (r: CandidateRecord) => `${r.source}:${r.sourceId}`;
  let abstract: string | null = null;
  let abstractSource: string | null = null;
  const inline = records.find((r) => r.abstract);
  if (inline) [abstract, abstractSource] = [inline.abstract, key(inline)];
  const fetchErrors: string[] = [];
  for (const r of inline ? [] : records) {
    try {
      abstract = await deps.domain.abstracts.fetch(r);
    } catch (err) {
      fetchErrors.push(err instanceof Error ? err.message : String(err));
      continue;
    }
    if (abstract) {
      abstractSource = key(r);
      break;
    }
  }
  if (!abstract && fetchErrors.length > 0 && !deps.finalAttempt) {
    throw new Error(`abstract fetch failed, retrying: ${fetchErrors.join("; ")}`);
  }
  const title = matched.title ?? ref.entryTitle ?? "";
  const citedText = abstract ? `${title}\n\n${abstract}` : title;

  let judged = 0;
  const errors: string[] = [];
  for (const c of todo) {
    if (!abstract && fetchErrors.length > 0) {
      await deps.save(c.id, skipped(`The abstract could not be fetched (${fetchErrors.join("; ")}).`), citedText, null);
      continue;
    }
    if ((await deps.llmCallsLeft()) <= 0) {
      await deps.save(c.id, skipped("Not checked: the per-paper LLM budget was reached."), citedText, abstractSource);
      continue;
    }
    try {
      const result = await deps.verifier.verify(
        { referenceKey: "", sentence: c.sentence, previousSentence: c.previousSentence, section: c.section, marker: c.marker, linkedBy: c.linkedBy as "grobid" | "numeric-fallback" },
        { title, abstract },
      );
      await deps.save(c.id, result, citedText, abstractSource);
      judged++;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (deps.finalAttempt) await deps.save(c.id, skipped(`The relevance check failed: ${msg.slice(0, 200)}`), citedText, abstractSource);
      else errors.push(msg);
    }
  }
  if (errors.length > 0) throw new Error(`relevance failed for ${errors.length} context(s), retrying: ${errors[0]}`);
  return { judged, skipped: null };
}
