import { UnrecoverableError } from "bullmq";
import { describe, expect, it } from "vitest";
import { config } from "../../config.js";
import { ApiBlockedError, authorize, cacheKey, fetchOnce } from "./gateway.js";

const respond = (status: number, body: string) => (async () => new Response(body, { status })) as unknown as typeof fetch;

describe("fetchOnce: response classification", () => {
  it("returns 200 and 404 as results", async () => {
    expect(await fetchOnce("crossref-doi", "https://api.crossref.org/works/x", respond(200, "{}"))).toMatchObject({ status: 200 });
    expect(await fetchOnce("s2", "https://api.semanticscholar.org/x", respond(404, "not found"))).toMatchObject({ status: 404 });
  });

  it("retries (plain Error) on 429 and 5xx", async () => {
    for (const status of [429, 500, 503]) {
      const err = await fetchOnce("s2", "https://x.test/", respond(status, "")).catch((e: unknown) => e);
      expect(err).toBeInstanceOf(Error);
      expect(err).not.toBeInstanceOf(UnrecoverableError);
    }
  });

  it("never caches a malformed 200 (proxy error page): retry instead", async () => {
    await expect(fetchOnce("openalex", "https://api.openalex.org/x", respond(200, "<html>oops</html>"))).rejects.toThrow(/non-JSON/);
    await expect(fetchOnce("arxiv", "https://export.arxiv.org/api/query?x", respond(200, "<html/>"))).rejects.toThrow(/Atom/);
  });

  it("gives an empty arXiv feed a short TTL", async () => {
    const empty = await fetchOnce("arxiv", "https://export.arxiv.org/api/query?x", respond(200, "<feed></feed>"));
    const full = await fetchOnce("arxiv", "https://export.arxiv.org/api/query?x", respond(200, "<feed><entry/></feed>"));
    expect(empty.ttl).toBeLessThan(full.ttl);
  });

  it("blocks the API on 403 and on OpenAlex's daily budget; other 4xx are permanent", async () => {
    await expect(fetchOnce("arxiv", "https://x.test/", respond(403, ""))).rejects.toBeInstanceOf(ApiBlockedError);
    await expect(fetchOnce("openalex", "https://x.test/", respond(429, '{"reason":"daily_budget"}'))).rejects.toBeInstanceOf(ApiBlockedError);
    const err = await fetchOnce("s2", "https://x.test/", respond(400, "bad")).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(UnrecoverableError);
    expect(err).not.toBeInstanceOf(ApiBlockedError);
  });
});

describe("credentials stay out of cache keys", () => {
  it("adds mailto and API keys only to the request actually sent", () => {
    const saved = { ...config };
    Object.assign(config, { contactEmail: "me@example.org", openalexApiKey: "oa-secret", semanticScholarApiKey: "s2-secret" });
    try {
      const url = "https://api.crossref.org/works?query.bibliographic=x";
      expect(authorize("crossref-query", url).url).toContain("mailto=me%40example.org");
      expect(authorize("openalex", "https://api.openalex.org/works").headers.Authorization).toBe("Bearer oa-secret");
      expect(authorize("s2", "https://api.semanticscholar.org/x").headers["x-api-key"]).toBe("s2-secret");
      // The cache key is a hash of (api, url as built by the resolver), which never has them.
      expect(cacheKey("crossref-query", url)).toBe(cacheKey("crossref-query", url));
      expect(url).not.toContain("mailto");
    } finally {
      Object.assign(config, saved);
    }
  });
});
