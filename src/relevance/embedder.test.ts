import { describe, expect, it } from "vitest";
import { localEmbedder } from "./embedder.js";

describe("localEmbedder", () => {
  it("retries a failed model load instead of caching the failure", async () => {
    let calls = 0;
    const emb = localEmbedder(async () => {
      calls++;
      if (calls === 1) throw new Error("network down");
      return async (texts: string[]) => ({ tolist: () => texts.map(() => [1, 0]) });
    });
    await expect(emb.embed(["a"])).rejects.toThrow("network down");
    expect(await emb.embed(["a"])).toEqual([[1, 0]]);
    expect(calls).toBe(2);
  });

  it("embeds each distinct text once", async () => {
    let seen: string[] = [];
    const emb = localEmbedder(async () => async (texts: string[]) => {
      seen = seen.concat(texts);
      return { tolist: () => texts.map(() => [0, 1]) };
    });
    await emb.embed(["abstract", "s1"]);
    await emb.embed(["abstract", "s2"]);
    expect(seen).toEqual(["abstract", "s1", "s2"]);
  });
});
