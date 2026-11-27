import { describe, expect, it } from "vitest";
import { parseSource } from "./ingest.js";

describe("parseSource", () => {
  it.each([
    ["2303.08774", "2303.08774"],
    ["arXiv:2303.08774v3", "2303.08774v3"],
    ["https://arxiv.org/abs/1706.03762", "1706.03762"],
    ["https://arxiv.org/pdf/1706.03762v7.pdf", "1706.03762v7"],
    ["hep-th/9711200", "hep-th/9711200"],
  ])("treats %s as arXiv id %s", (input, id) => {
    expect(parseSource(input)).toEqual({ kind: "arxiv", id });
  });

  it("treats anything else as a local PDF path", () => {
    expect(parseSource("./papers/mine.pdf")).toEqual({ kind: "pdf", path: "./papers/mine.pdf" });
    expect(parseSource("2303.08774.pdf.bak")).toEqual({ kind: "pdf", path: "2303.08774.pdf.bak" });
  });
});
