import { describe, expect, it, vi } from "vitest";

describe("preflight (unreachable services)", () => {
  it("fails fast, names every down service and hides credentials", async () => {
    vi.stubEnv("REDIS_URL", "redis://localhost:9");
    vi.stubEnv("DATABASE_URL", "postgres://u:secret@localhost:9/x");
    vi.resetModules();
    const { preflight } = await import("./preflight.js");
    const t0 = Date.now();
    const err = await preflight(["postgres", "redis"], 2_000).catch((e: Error) => e);
    expect(Date.now() - t0).toBeLessThan(5_000);
    expect(String(err)).toMatch(/postgres is not reachable/);
    expect(String(err)).toMatch(/redis is not reachable/);
    expect(String(err)).not.toContain("secret");
    expect(String(err)).toMatch(/docker compose up/);
  });
});
