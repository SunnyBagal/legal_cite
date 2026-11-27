import { z } from "zod";
import type { CitationContext, CitedWorkText, LLMProvider, RelevanceResult, RelevanceVerifier } from "../core/types.js";
import { LLMRefusalError, RELEVANCE_LABELS } from "../core/types.js";
import { cosine, type Embedder } from "./embedder.js";

/**
 * Stable across every call (cacheable prefix). Asks for an abstract-level judgement only:
 * the model sees the cited work's title and abstract, never its full text.
 */
export const RELEVANCE_SYSTEM_PROMPT = `You check citations in research papers. You get a passage from a citing paper that contains a citation marker, and the title and abstract of the work that the marker cites. Judge whether the cited work, as far as its title and abstract show, plausibly supports what the citing passage uses it for.

Verdicts:
- SUPPORTS: the abstract clearly covers the claim, method, result or resource the passage attributes to the cited work.
- PARTIAL: the cited work is on the right topic and could back the claim, but the abstract only covers part of it, or the passage stretches what the abstract says.
- UNRELATED: the cited work is about something else; the abstract gives no basis for this citation.
- CANNOT_TELL: the passage doesn't say what the citation is for (e.g. a bare list of related work), or the abstract is too thin to judge.

Rules:
- Judge only from the abstract and title. The full paper may say more, so prefer PARTIAL or CANNOT_TELL to UNRELATED when the topic matches.
- A citation for background, a dataset, a model or a method counts as supported when the cited work is that thing.
- When several works are cited together, judge only the one given, against the part of the passage it plausibly backs.
- Give one sentence of reason, naming what in the abstract does or doesn't match.`;

const VerdictSchema = z.object({
  verdict: z.enum(RELEVANCE_LABELS as [string, ...string[]]),
  reason: z.string(),
});

export interface VerifierOptions {
  embedder: Embedder;
  llm: LLMProvider;
  /**
   * Cosine similarity (MiniLM) below which a pair is called UNRELATED without an LLM call.
   * Conservative on purpose: it should only skip pairs no reader would link. See eval/RESULTS.md.
   */
  prefilterThreshold?: number;
}

/**
 * 0.1 misfired on 1706.03762 b35: "label smoothing [36]" cites Inception-v3, whose abstract
 * never mentions label smoothing (similarity 0.099). A clearly unrelated pair scored 0.004.
 */
export const DEFAULT_PREFILTER_THRESHOLD = 0.05;
/** Passages shorter than this (markers excluded) never get a pre-filter verdict. */
export const MIN_PREFILTER_WORDS = 12;

export function createRelevanceVerifier(opts: VerifierOptions): RelevanceVerifier {
  const threshold = opts.prefilterThreshold ?? DEFAULT_PREFILTER_THRESHOLD;
  return {
    async verify(context: CitationContext, cited: CitedWorkText): Promise<RelevanceResult> {
      if (!cited.abstract) {
        return { verdict: "CANNOT_TELL", reason: "No abstract is available for the cited work.", method: "skipped", similarity: null, model: null };
      }
      const passage = [context.previousSentence, context.sentence].filter(Boolean).join(" ");
      const [a, b] = await opts.embedder.embed([passage, `${cited.title}. ${cited.abstract}`]);
      const similarity = Math.round(cosine(a!, b!) * 1000) / 1000;
      // A near-empty passage ("For more background, see [94].") is dissimilar to everything;
      // low similarity there means "no content", not "unrelated". Leave those to the LLM.
      const words = passage.replace(/\[[^\]]*\]/g, " ").split(/\s+/).filter((w) => /\p{L}/u.test(w)).length;
      if (similarity < threshold && words >= MIN_PREFILTER_WORDS) {
        return {
          verdict: "UNRELATED",
          reason: `The citing passage and the cited abstract share almost no content (embedding similarity ${similarity}).`,
          method: "prefilter",
          similarity,
          model: null,
        };
      }
      const user = [
        `Citing passage (section: ${context.section ?? "unknown"}; citation marker: ${context.marker}):`,
        context.previousSentence ? `${context.previousSentence}\n${context.sentence}` : context.sentence,
        "",
        `Cited work title: ${cited.title}`,
        `Cited work abstract: ${cited.abstract}`,
      ].join("\n");
      try {
        const out = await opts.llm.completeJSON({ system: RELEVANCE_SYSTEM_PROMPT, user, schema: VerdictSchema, schemaName: "relevance_verdict" });
        return { verdict: out.verdict as RelevanceResult["verdict"], reason: out.reason, method: "llm", similarity, model: opts.llm.model };
      } catch (err) {
        if (err instanceof LLMRefusalError) {
          return { verdict: "CANNOT_TELL", reason: `The model declined to judge this pair (${err.message}).`, method: "llm", similarity, model: opts.llm.model };
        }
        throw err;
      }
    },
  };
}
