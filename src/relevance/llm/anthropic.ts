import Anthropic from "@anthropic-ai/sdk";
import { betaZodOutputFormat } from "@anthropic-ai/sdk/helpers/beta/zod";
import type { z } from "zod";
import type { LLMProvider } from "../../core/types.js";
import { LLMIncompleteError, LLMRefusalError } from "../../core/types.js";

type BetaMessage = Anthropic.Beta.Messages.BetaMessage;

/**
 * Pull the structured answer out of a response. Not messages.parse(): it parses every text
 * block and throws on a refusal's prose or on the declining model's partial text before a
 * fallback hop. Here: refusal/truncation first, then only the text after the last fallback.
 */
export function extractStructured<T>(msg: BetaMessage, schema: z.ZodType<T>): T {
  if (msg.stop_reason === "refusal") throw new LLMRefusalError(`category: ${msg.stop_details?.category ?? "unspecified"}`);
  if (msg.stop_reason === "max_tokens") throw new LLMIncompleteError("hit max_tokens");
  const lastFallback = msg.content.map((b) => b.type).lastIndexOf("fallback" as never);
  const text = msg.content
    .slice(lastFallback + 1)
    .flatMap((b) => (b.type === "text" ? [b.text] : []))
    .join("");
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    throw new Error(`model output is not JSON (stop_reason ${msg.stop_reason}): ${text.slice(0, 120)}`);
  }
  return schema.parse(json);
}

/**
 * Claude via the official SDK. Structured outputs (output_config.format) constrain the JSON;
 * effort "low" suits a one-sentence classification (Opus 5.5 can't disable thinking, so
 * max_tokens leaves room for it). cache_control on the shared system prompt caches it once it
 * reaches the model's minimum cacheable prefix. Server-side refusal fallback ("default").
 */
export function anthropicProvider(opts: { apiKey: string; model?: string; client?: Anthropic }): LLMProvider {
  const client = opts.client ?? new Anthropic({ apiKey: opts.apiKey, timeout: 60_000, maxRetries: 2 });
  const model = opts.model ?? "claude-opus-5-5";
  return {
    name: "anthropic",
    model,
    async completeJSON<T>(req: { system: string; user: string; schema: z.ZodType<T>; schemaName: string }) {
      const msg = await client.beta.messages.create({
        model,
        max_tokens: 4096,
        betas: ["server-side-fallback-2026-07-01"],
        fallbacks: "default",
        system: [{ type: "text", text: req.system, cache_control: { type: "ephemeral" } }],
        messages: [{ role: "user", content: req.user }],
        output_config: { effort: "low", format: betaZodOutputFormat(req.schema) },
      });
      return { output: extractStructured(msg, req.schema), model: msg.model };
    },
  };
}
