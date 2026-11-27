import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { UnrecoverableError } from "bullmq";
import { describe, expect, it } from "vitest";
import { ingest, parseSource } from "./ingest.js";

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

  it("treats anything else as a local PDF path, stored absolute so any worker can read it", () => {
    expect(parseSource("./papers/mine.pdf")).toEqual({ kind: "pdf", path: resolve("papers/mine.pdf") });
    expect(parseSource("2303.08774.pdf.bak")).toEqual({ kind: "pdf", path: resolve("2303.08774.pdf.bak") });
  });
});

describe("ingest", () => {
  const tmp = () => mkdtempSync(join(tmpdir(), "citecheck-"));

  it("rejects a file that isn't a PDF without retrying", async () => {
    const p = join(tmp(), "x.pdf");
    writeFileSync(p, "<html>not a pdf</html>");
    await expect(ingest({ kind: "pdf", path: p })).rejects.toBeInstanceOf(UnrecoverableError);
    await expect(ingest({ kind: "pdf", path: p })).rejects.toThrow(/not a PDF/);
  });

  it("rejects a missing file without retrying", async () => {
    await expect(ingest({ kind: "pdf", path: join(tmp(), "nope.pdf") })).rejects.toBeInstanceOf(UnrecoverableError);
  });
});
