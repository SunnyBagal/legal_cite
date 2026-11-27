import { describe, expect, it } from "vitest";
import type { CitationContext, LLMProvider } from "../core/types.js";
import { LLMRefusalError } from "../core/types.js";
import type { Embedder } from "./embedder.js";
import { createRelevanceVerifier, RELEVANCE_SYSTEM_PROMPT } from "./verifier.js";

const CTX: CitationContext = {
  referenceKey: "b12",
  sentence: "Recurrent neural networks, long short-term memory [13] and gated recurrent [7] neural networks in particular, have been firmly established as state of the art approaches in sequence modeling.",
  previousSentence: null,
  section: "Introduction",
  marker: "[13]",
  linkedBy: "grobid",
};
const CITED = { title: "Long short-term memory", abstract: "We introduce a novel recurrent network architecture with gated memory cells." };

/** Embeds to fixed vectors so cosine similarity is chosen by the test. */
function fakeEmbedder(similarity: number): Embedder {
  return {
    async embed(texts) {
      return texts.map((_, i) => (i === 0 ? [1, 0] : [similarity, Math.sqrt(1 - similarity ** 2)]));
    },
  };
}

function fakeLLM(answer: unknown | Error) {
  const calls: { system: string; user: string }[] = [];
  const llm: LLMProvider = {
    name: "fake",
    model: "fake-model-1",
    async completeJSON(req) {
      calls.push({ system: req.system, user: req.user });
      if (answer instanceof Error) throw answer;
      return req.schema.parse(answer);
    },
  };
  return { llm, calls };
}

describe("relevance verifier", () => {
  it("returns the LLM's verdict with method, model and similarity", async () => {
    const { llm, calls } = fakeLLM({ verdict: "SUPPORTS", reason: "The paper introduces LSTM." });
    const res = await createRelevanceVerifier({ embedder: fakeEmbedder(0.6), llm }).verify(CTX, CITED);
    expect(res).toEqual({ verdict: "SUPPORTS", reason: "The paper introduces LSTM.", method: "llm", similarity: 0.6, model: "fake-model-1" });
    expect(calls).toHaveLength(1);
  });

  it("puts the citing sentence, its marker, the previous sentence, title and abstract in the prompt", async () => {
    const { llm, calls } = fakeLLM({ verdict: "PARTIAL", reason: "x" });
    await createRelevanceVerifier({ embedder: fakeEmbedder(0.6), llm }).verify({ ...CTX, previousSentence: "Earlier sentence." }, CITED);
    expect(calls[0]?.system).toBe(RELEVANCE_SYSTEM_PROMPT);
    for (const part of [CTX.sentence, "[13]", "Earlier sentence.", CITED.title, CITED.abstract]) expect(calls[0]?.user).toContain(part);
  });

  it("calls a clearly unrelated pair UNRELATED from the embedding pre-filter, without an LLM call", async () => {
    const { llm, calls } = fakeLLM({ verdict: "SUPPORTS", reason: "x" });
    const res = await createRelevanceVerifier({ embedder: fakeEmbedder(0.02), llm, prefilterThreshold: 0.1 }).verify(CTX, CITED);
    expect(res.verdict).toBe("UNRELATED");
    expect(res.method).toBe("prefilter");
    expect(calls).toHaveLength(0);
  });

  it("says CANNOT_TELL without calling anything when there is no abstract", async () => {
    const { llm, calls } = fakeLLM({ verdict: "SUPPORTS", reason: "x" });
    const res = await createRelevanceVerifier({ embedder: fakeEmbedder(0.9), llm }).verify(CTX, { title: CITED.title, abstract: null });
    expect(res).toMatchObject({ verdict: "CANNOT_TELL", method: "skipped" });
    expect(calls).toHaveLength(0);
  });

  it("says CANNOT_TELL when the model declines", async () => {
    const { llm } = fakeLLM(new LLMRefusalError("declined (category: null)"));
    const res = await createRelevanceVerifier({ embedder: fakeEmbedder(0.6), llm }).verify(CTX, CITED);
    expect(res).toMatchObject({ verdict: "CANNOT_TELL", method: "llm" });
    expect(res.reason).toMatch(/declined/);
  });

  it("rejects model output outside the schema (the job retries)", async () => {
    const { llm } = fakeLLM({ verdict: "PROBABLY", reason: "x" });
    await expect(createRelevanceVerifier({ embedder: fakeEmbedder(0.6), llm }).verify(CTX, CITED)).rejects.toThrow();
  });
});

describe("relevance verifier: pre-filter needs a substantive passage", () => {
  it("sends short, content-free passages ('For more background, see [94].') to the LLM", async () => {
    const { llm, calls } = fakeLLM({ verdict: "CANNOT_TELL", reason: "The passage gives no claim." });
    const res = await createRelevanceVerifier({ embedder: fakeEmbedder(-0.03), llm }).verify({ ...CTX, sentence: "For more background, see [94]." }, CITED);
    expect(res.method).toBe("llm");
    expect(calls).toHaveLength(1);
  });
});
