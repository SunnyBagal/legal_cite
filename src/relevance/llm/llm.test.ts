import { describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { LLMIncompleteError, LLMRefusalError } from "../../core/types.js";
import { extractStructured } from "./anthropic.js";
import { supportsReasoning } from "./openai.js";

const Schema = z.object({ verdict: z.enum(["SUPPORTS", "UNRELATED"]), reason: z.string() });
// Response shapes as the Messages API returns them (trimmed to the fields extractStructured reads).
const msg = (o: Record<string, unknown>) => ({ model: "claude-opus-5-5", stop_details: null, stop_reason: "end_turn", content: [], ...o }) as never;

describe("anthropic: extractStructured", () => {
  it("parses the JSON text answer", () => {
    expect(extractStructured(msg({ content: [{ type: "text", text: '{"verdict":"SUPPORTS","reason":"r"}' }] }), Schema)).toEqual({ verdict: "SUPPORTS", reason: "r" });
  });

  it("maps a refusal (even one with prose) to LLMRefusalError instead of a parse failure", () => {
    const refused = msg({ stop_reason: "refusal", stop_details: { type: "refusal", category: "cyber" }, content: [{ type: "text", text: "I can't help with that." }] });
    expect(() => extractStructured(refused, Schema)).toThrow(LLMRefusalError);
  });

  it("after a fallback hop, reads only the fallback model's text", () => {
    const hop = msg({
      content: [
        { type: "text", text: '{"verdict":"SUPP' },
        { type: "fallback", from: { model: "claude-opus-5-5" }, to: { model: "claude-opus-4-8" } },
        { type: "text", text: '{"verdict":"UNRELATED","reason":"r"}' },
      ],
    });
    expect(extractStructured(hop, Schema).verdict).toBe("UNRELATED");
  });

  it("maps max_tokens to LLMIncompleteError", () => {
    expect(() => extractStructured(msg({ stop_reason: "max_tokens", content: [{ type: "text", text: '{"verd' }] }), Schema)).toThrow(LLMIncompleteError);
  });

  it("rejects output outside the schema", () => {
    expect(() => extractStructured(msg({ content: [{ type: "text", text: '{"verdict":"MAYBE","reason":"r"}' }] }), Schema)).toThrow();
  });
});

describe("openai", () => {
  it("only sends reasoning effort to reasoning model families", () => {
    expect(supportsReasoning("gpt-5.5")).toBe(true);
    expect(supportsReasoning("o4-mini")).toBe(true);
    expect(supportsReasoning("gpt-4.1")).toBe(false);
  });
});

describe("selectLLM", () => {
  it("prefers Anthropic, honours --llm, and errors when the chosen key is missing", async () => {
    vi.resetModules();
    vi.doMock("../../config.js", () => ({ config: { anthropicApiKey: "a", openaiApiKey: "o" } }));
    const { selectLLM } = await import("./select.js");
    expect(selectLLM()?.name).toBe("anthropic");
    expect(selectLLM("openai")?.name).toBe("openai");
    vi.doMock("../../config.js", () => ({ config: { openaiApiKey: "o" } }));
    vi.resetModules();
    const fresh = await import("./select.js");
    expect(fresh.selectLLM()?.name).toBe("openai");
    expect(() => fresh.selectLLM("anthropic")).toThrow(/ANTHROPIC_API_KEY/);
    vi.doMock("../../config.js", () => ({ config: {} }));
    vi.resetModules();
    expect((await import("./select.js")).selectLLM()).toBeNull();
    vi.doUnmock("../../config.js");
  });
});
