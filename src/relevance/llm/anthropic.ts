import Anthropic from "@anthropic-ai/sdk";
import { betaZodOutputFormat } from "@anthropic-ai/sdk/helpers/beta/zod";
import type { z } from "zod";
import type { LLMProvider } from "../../core/types.js";
import { LLMRefusalError } from "../../core/types.js";

/**
 * Claude via the official SDK. Structured outputs (output_config.format) guarantee schema-valid
 * JSON; effort "low" suits a one-sentence classification (Opus 5.5 can't disable thinking, so
 * max_tokens leaves room for it). The shared system prompt carries cache_control: it caches
 * once it reaches the model's minimum cacheable prefix. Server-side refusal fallback is on by
 * default ("default" routes by refusal category).
 */
export function anthropicProvider(opts: { apiKey: string; model?: string }): LLMProvider {
  const client = new Anthropic({ apiKey: opts.apiKey });
  const model = opts.model ?? "claude-opus-5-5";
  return {
    name: "anthropic",
    model,
    async completeJSON<T>(req: { system: string; user: string; schema: z.ZodType<T>; schemaName: string }): Promise<T> {
      const response = await client.beta.messages.parse({
        model,
        max_tokens: 4096,
        betas: ["server-side-fallback-2026-07-01"],
        fallbacks: "default",
        system: [{ type: "text", text: req.system, cache_control: { type: "ephemeral" } }],
        messages: [{ role: "user", content: req.user }],
        output_config: { effort: "low", format: betaZodOutputFormat(req.schema) },
      });
      if (response.stop_reason === "refusal") {
        throw new LLMRefusalError(`declined, category: ${response.stop_details?.category ?? "unspecified"}`);
      }
      if (response.parsed_output == null) throw new Error(`no parsable output (stop_reason: ${response.stop_reason})`);
      return response.parsed_output as T;
    },
  };
}
