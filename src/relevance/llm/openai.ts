import OpenAI from "openai";
import { zodTextFormat } from "openai/helpers/zod";
import type { z } from "zod";
import type { LLMProvider } from "../../core/types.js";
import { LLMIncompleteError, LLMRefusalError } from "../../core/types.js";

/** Reasoning-effort is only accepted by reasoning model families; others 400 on it. */
export const supportsReasoning = (model: string) => /^(gpt-5|gpt-6|o\d)/.test(model);

/** OpenAI via the official SDK: Responses API with a strict JSON-schema text format. */
export function openaiProvider(opts: { apiKey: string; model?: string; client?: OpenAI }): LLMProvider {
  const client = opts.client ?? new OpenAI({ apiKey: opts.apiKey, timeout: 60_000, maxRetries: 2 });
  const model = opts.model ?? "gpt-5.5";
  return {
    name: "openai",
    model,
    async completeJSON<T>(req: { system: string; user: string; schema: z.ZodType<T>; schemaName: string }) {
      const response = await client.responses.parse({
        model,
        instructions: req.system,
        input: req.user,
        ...(supportsReasoning(model) ? { reasoning: { effort: "low" as const } } : {}),
        text: { format: zodTextFormat(req.schema, req.schemaName) },
      });
      const refusal = response.output
        .flatMap((item) => (item.type === "message" ? item.content : []))
        .find((c) => c.type === "refusal");
      if (refusal && "refusal" in refusal) throw new LLMRefusalError(refusal.refusal);
      if (response.status === "incomplete") throw new LLMIncompleteError(response.incomplete_details?.reason ?? "incomplete");
      if (response.output_parsed == null) throw new Error(`no parsable output (status: ${response.status})`);
      return { output: req.schema.parse(response.output_parsed), model: response.model };
    },
  };
}
