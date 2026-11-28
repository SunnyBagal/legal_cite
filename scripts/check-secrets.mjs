#!/usr/bin/env node
// Fails if a tracked file looks like it holds an API key, or if .env is tracked.
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";

const files = execFileSync("git", ["ls-files", "-z"], { encoding: "utf8" }).split("\0").filter(Boolean);
const PATTERNS = [
  ["Anthropic key", /sk-ant-[A-Za-z0-9_-]{20,}/],
  ["OpenAI key", /sk-(proj-)?[A-Za-z0-9_-]{32,}/],
  ["Assignment of a non-empty secret in an env template", /^(ANTHROPIC_API_KEY|OPENAI_API_KEY|OPENALEX_API_KEY|SEMANTIC_SCHOLAR_API_KEY)=\S+/m],
];
const problems = [];
if (files.includes(".env")) problems.push(".env is tracked by git");
for (const f of files) {
  if (/\.(png|jpe?g|pdf|ico|woff2?)$/i.test(f) || f === "pnpm-lock.yaml") continue;
  let text;
  try {
    text = readFileSync(f, "utf8");
  } catch {
    continue;
  }
  for (const [what, re] of PATTERNS) if (re.test(text)) problems.push(`${f}: ${what}`);
}
if (problems.length) {
  console.error(`possible secrets in tracked files:\n  ${problems.join("\n  ")}`);
  process.exit(1);
}
console.log(`no secrets found in ${files.length} tracked files`);
