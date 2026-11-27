import OpenAI from "openai";
import { zodTextFormat } from "openai/helpers/zod";
import type { z } from "zod";
import type { LLMProvider } from "../../core/types.js";
import { LLMRefusalError } from "../../core/types.js";

/** OpenAI via the official SDK: Responses API with a strict JSON-schema text format. */
export function openaiProvider(opts: { apiKey: string; model?: string }): LLMProvider {
  const client = new OpenAI({ apiKey: opts.apiKey });
  const model = opts.model ?? "gpt-5.5";
  return {
    name: "openai",
    model,
    async completeJSON<T>(req: { system: string; user: string; schema: z.ZodType<T>; schemaName: string }): Promise<T> {
      const response = await client.responses.parse({
        model,
        instructions: req.system,
        input: req.user,
        reasoning: { effort: "low" },
        text: { format: zodTextFormat(req.schema, req.schemaName) },
      });
      const refusal = response.output
        .flatMap((item) => (item.type === "message" ? item.content : []))
        .find((c) => c.type === "refusal");
      if (refusal && "refusal" in refusal) throw new LLMRefusalError(refusal.refusal);
      if (response.output_parsed == null) throw new Error(`no parsable output (status: ${response.status})`);
      return response.output_parsed as T;
    },
  };
}
