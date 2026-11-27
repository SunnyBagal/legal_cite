import { existsSync } from "node:fs";

if (existsSync(".env")) process.loadEnvFile(".env");

const env = (name: string): string | undefined => {
  const v = process.env[name]?.trim();
  return v ? v : undefined;
};

export const config = {
  databaseUrl: env("DATABASE_URL") ?? "postgres://citecheck:citecheck@localhost:5433/citecheck",
  redisUrl: env("REDIS_URL") ?? "redis://localhost:6380",
  grobidUrl: env("GROBID_URL") ?? "http://localhost:8070",
  contactEmail: env("CONTACT_EMAIL"),
  openalexApiKey: env("OPENALEX_API_KEY"),
  semanticScholarApiKey: env("SEMANTIC_SCHOLAR_API_KEY"),
  anthropicApiKey: env("ANTHROPIC_API_KEY"),
  anthropicModel: env("ANTHROPIC_MODEL"),
  openaiApiKey: env("OPENAI_API_KEY"),
  openaiModel: env("OPENAI_MODEL"),
};

/** User-Agent sent to every external API (Crossref asks for contact info in it). */
export const userAgent = `citecheck/0.1 (citation verification research tool${
  config.contactEmail ? `; mailto:${config.contactEmail}` : ""
})`;
