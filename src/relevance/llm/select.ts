import { config } from "../../config.js";
import type { LLMProvider } from "../../core/types.js";
import { anthropicProvider } from "./anthropic.js";
import { openaiProvider } from "./openai.js";

export type LLMChoice = "anthropic" | "openai";

/** Pick the provider from env: the requested one, else Anthropic, else OpenAI; null if no key. */
export function selectLLM(choice?: LLMChoice): LLMProvider | null {
  const anthropic = () => anthropicProvider({ apiKey: config.anthropicApiKey!, ...(config.anthropicModel ? { model: config.anthropicModel } : {}) });
  const openai = () => openaiProvider({ apiKey: config.openaiApiKey!, ...(config.openaiModel ? { model: config.openaiModel } : {}) });
  if (choice === "anthropic") {
    if (!config.anthropicApiKey) throw new Error("--llm anthropic needs ANTHROPIC_API_KEY in .env");
    return anthropic();
  }
  if (choice === "openai") {
    if (!config.openaiApiKey) throw new Error("--llm openai needs OPENAI_API_KEY in .env");
    return openai();
  }
  if (config.anthropicApiKey) return anthropic();
  if (config.openaiApiKey) return openai();
  return null;
}
