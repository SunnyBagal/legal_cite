/** Text → unit vectors, for the cheap relevance pre-filter. */
export interface Embedder {
  embed(texts: string[]): Promise<number[][]>;
}

/** Cosine similarity (inputs need not be normalized). */
export function cosine(a: number[], b: number[]): number {
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i]! * b[i]!;
    na += a[i]! ** 2;
    nb += b[i]! ** 2;
  }
  return na === 0 || nb === 0 ? 0 : dot / Math.sqrt(na * nb);
}

/**
 * Local sentence embeddings (all-MiniLM-L6-v2 via transformers.js, ONNX on CPU): no API key,
 * no per-call cost. Weights (~23 MB) download from the Hugging Face hub on first use.
 */
export function localEmbedder(model = "Xenova/all-MiniLM-L6-v2"): Embedder {
  let extractor: Promise<(texts: string[], opts: object) => Promise<{ tolist(): number[][] }>> | undefined;
  return {
    async embed(texts) {
      extractor ??= import("@huggingface/transformers").then(
        async (t) => (await t.pipeline("feature-extraction", model, { dtype: "fp32" })) as never,
      );
      const out = await (await extractor)(texts, { pooling: "mean", normalize: true });
      return out.tolist();
    },
  };
}
