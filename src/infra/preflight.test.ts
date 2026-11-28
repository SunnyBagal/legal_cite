import { describe, expect, it } from "vitest";
import { redact } from "./preflight.js";

describe("preflight", () => {
  it("never puts a password into an error message", () => {
    expect(redact("postgres://user:hunter2@db:5432/x")).toBe("postgres://user:***@db:5432/x");
    expect(redact("redis://localhost:6380")).toBe("redis://localhost:6380");
    expect(redact("not a url")).toBe("(unparseable URL)");
  });
});
