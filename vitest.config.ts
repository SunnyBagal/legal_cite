import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["src/**/*.test.ts", "eval/**/*.test.ts"],
    // *.int.test.ts need docker compose services; run them with `pnpm test:int`.
    exclude: ["**/*.int.test.ts", "**/node_modules/**"],
  },
});
