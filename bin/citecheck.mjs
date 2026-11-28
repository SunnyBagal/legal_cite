#!/usr/bin/env node
// Runs the TypeScript CLI through tsx so `citecheck` works after `pnpm link --global`.
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const tsx = join(root, "node_modules", ".bin", "tsx");
if (!existsSync(tsx)) {
  console.error(`error: ${tsx} not found. Run \`pnpm install\` in ${root} first.`);
  process.exit(1);
}
const { status, signal, error } = spawnSync(tsx, [join(root, "src", "cli.ts"), ...process.argv.slice(2)], { stdio: "inherit" });
if (error) {
  console.error(`error: could not start the CLI: ${error.message}`);
  process.exit(1);
}
// 128 + signal number, the shell convention (130 for Ctrl-C).
process.exit(status ?? (signal === "SIGINT" ? 130 : signal === "SIGTERM" ? 143 : 1));
