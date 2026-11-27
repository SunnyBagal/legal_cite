#!/usr/bin/env node
// Runs the TypeScript CLI through tsx so `citecheck` works after `pnpm link --global`.
import { spawnSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const tsx = join(root, "node_modules", ".bin", "tsx");
const { status } = spawnSync(tsx, [join(root, "src", "cli.ts"), ...process.argv.slice(2)], { stdio: "inherit" });
process.exit(status ?? 1);
