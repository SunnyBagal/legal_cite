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

type Extractor = (texts: string[], opts: object) => Promise<{ tolist(): number[][] }>;
type Loader = () => Promise<Extractor>;

/** all-MiniLM-L6-v2 pinned to a hub commit: changed weights would silently move the pre-filter. */
export const EMBEDDING_MODEL = { id: "Xenova/all-MiniLM-L6-v2", revision: "751bff37182d3f1213fa05d7196b954e230abad9" };

const defaultLoader: Loader = async () => {
  const t = await import("@huggingface/transformers");
  return (await t.pipeline("feature-extraction", EMBEDDING_MODEL.id, { dtype: "fp32", revision: EMBEDDING_MODEL.revision })) as never;
};

/**
 * Local sentence embeddings via transformers.js (ONNX on CPU): no API key, no per-call cost.
 * Weights (~23 MB) download once from the Hugging Face hub. A failed load is retried on the
 * next call (not cached), and embeddings are memoized per text (a cited abstract is shared by
 * all of a reference's contexts).
 */
export function localEmbedder(load: Loader = defaultLoader): Embedder & { warmup(): void } {
  let extractor: Promise<Extractor> | undefined;
  const memo = new Map<string, number[]>();
  const getExtractor = () => {
    extractor ??= load().catch((err: unknown) => {
      extractor = undefined;
      throw err;
    });
    return extractor;
  };
  return {
    warmup() {
      getExtractor().catch((err: unknown) => console.error(`[embedder] warmup failed: ${String(err)}`));
    },
    async embed(texts) {
      const missing = [...new Set(texts.filter((t) => !memo.has(t)))];
      if (missing.length > 0) {
        const out = (await (await getExtractor())(missing, { pooling: "mean", normalize: true })).tolist();
        missing.forEach((t, i) => memo.set(t, out[i]!));
        if (memo.size > 5000) memo.clear();
      }
      return texts.map((t) => memo.get(t)!);
    },
  };
}
