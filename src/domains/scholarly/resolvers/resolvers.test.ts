import { describe, expect, it } from "vitest";
import type { Reference } from "../../../core/types.js";
import type { ApiGateway, ApiName, ApiResponse } from "../../../infra/http/gateway.js";
import { arxivIdResolver, parseArxivFeed } from "./arxiv.js";
import { crossrefDoiResolver, crossrefQueryResolver, crossrefToCandidate } from "./crossref.js";
import { abstractFromInvertedIndex, openalexToCandidate } from "./openalex.js";
import { s2MatchResolver, s2ToCandidate } from "./semanticScholar.js";

// Payload shapes trimmed from real responses (2026-11-27); abstracts replaced with placeholders.

/** Records requested URLs; answers from a table (default 404). */
function fakeGateway(table: Record<string, ApiResponse> = {}) {
  const calls: [ApiName, string][] = [];
  const gw: ApiGateway = {
    async fetch(api, url) {
      calls.push([api, url]);
      return table[url] ?? { status: 404, body: "", cached: false };
    },
  };
  return { gw, calls };
}

const REF: Reference = {
  kind: "scholarly",
  key: "b0",
  title: "Deep residual learning for im- age recognition",
  authors: [{ name: "Kaiming He", surname: "He" }],
  year: 2016,
  venue: null,
  doi: "https://doi.org/10.1109/CVPR.2016.90",
  arxivId: "1512.03385",
  ids: {},
  raw: null,
};

describe("crossref", () => {
  it("maps a work, normalizing the DOI and stripping JATS from the abstract", () => {
    const c = crossrefToCandidate({
      DOI: "10.1109/CVPR.2016.90",
      title: ["Deep Residual Learning for Image Recognition"],
      author: [{ given: "Kaiming", family: "He" }, { name: "CVPR Committee" }],
      issued: { "date-parts": [[2016, 6]] },
      "container-title": ["2016 IEEE Conference on Computer Vision and Pattern Recognition (CVPR)"],
      abstract: "<jats:p>Placeholder abstract.</jats:p>",
    });
    expect(c).toMatchObject({
      source: "crossref",
      doi: "10.1109/cvpr.2016.90",
      year: 2016,
      authors: [{ name: "Kaiming He", surname: "He" }, { name: "CVPR Committee", surname: "CVPR Committee" }],
      abstract: "Placeholder abstract.",
      url: "https://doi.org/10.1109/cvpr.2016.90",
    });
  });

  it("reads the arXiv id out of arXiv DataCite DOIs", () => {
    expect(crossrefToCandidate({ DOI: "10.48550/arXiv.1512.03385" }).arxivId).toBe("1512.03385");
  });

  it("looks up the normalized, URL-encoded DOI and treats 404 as no candidates", async () => {
    const { gw, calls } = fakeGateway();
    const res = await crossrefDoiResolver(gw).resolve(REF);
    expect(calls).toEqual([["crossref-doi", "https://api.crossref.org/works/10.1109%2Fcvpr.2016.90"]]);
    expect(res.candidates).toEqual([]);
  });

  it("queries with the normalized title, first surname and year", async () => {
    const { gw, calls } = fakeGateway();
    await crossrefQueryResolver(gw).resolve(REF);
    expect(decodeURIComponent(calls[0]![1])).toContain("query.bibliographic=deep residual learning for image recognition He 2016");
  });
});

describe("semantic scholar", () => {
  it("maps a match result", () => {
    const c = s2ToCandidate({
      paperId: "2c03df8b48bf3fa39054345bafabfeff15bfd11d",
      externalIds: { ArXiv: "1512.03385", DOI: "10.1109/cvpr.2016.90" },
      url: "https://www.semanticscholar.org/paper/2c03df8b",
      title: "Deep Residual Learning for Image Recognition",
      venue: "Computer Vision and Pattern Recognition",
      year: 2015,
      authors: [{ name: "Kaiming He" }, { name: "X. Zhang" }],
    });
    expect(c).toMatchObject({ source: "semantic-scholar", arxivId: "1512.03385", doi: "10.1109/cvpr.2016.90", year: 2015 });
    expect(c.authors[1]).toEqual({ name: "X. Zhang", surname: "Zhang" });
  });

  it("returns candidates from data[] and none on 404", async () => {
    const { gw, calls } = fakeGateway();
    expect((await s2MatchResolver(gw).resolve(REF)).candidates).toEqual([]);
    expect(calls[0]![1]).toMatch(/^https:\/\/api\.semanticscholar\.org\/graph\/v1\/paper\/search\/match\?query=deep%20residual/);
  });
});

describe("openalex", () => {
  it("rebuilds abstracts from the inverted index", () => {
    expect(abstractFromInvertedIndex({ residual: [1], Deep: [0], nets: [2], "nets.": [3] })).toBe("Deep residual nets nets.");
    expect(abstractFromInvertedIndex(null)).toBeNull();
  });

  it("maps a work, taking the arXiv id from an arxiv.org location", () => {
    const c = openalexToCandidate({
      id: "https://openalex.org/W2194775991",
      doi: "https://doi.org/10.1109/cvpr.2016.90",
      title: "Deep Residual Learning for Image Recognition",
      publication_year: 2016,
      authorships: [{ author: { display_name: "Kaiming He" } }],
      primary_location: { source: { display_name: "IEEE CVPR" } },
      locations: [{ landing_page_url: "https://doi.org/10.1109/cvpr.2016.90" }, { landing_page_url: "https://arxiv.org/abs/1512.03385v1" }],
    });
    expect(c).toMatchObject({ source: "openalex", sourceId: "W2194775991", doi: "10.1109/cvpr.2016.90", arxivId: "1512.03385", venue: "IEEE CVPR" });
  });
});

describe("arxiv", () => {
  const feed = (entry: string) =>
    `<?xml version="1.0"?><feed xmlns="http://www.w3.org/2005/Atom" xmlns:arxiv="http://arxiv.org/schemas/atom">${entry}</feed>`;

  it("parses an entry, stripping the version from the id", () => {
    const [c] = parseArxivFeed(
      feed(`<entry><id>http://arxiv.org/abs/1512.03385v1</id><published>2015-12-10T19:51:55Z</published>
        <title>Deep Residual Learning for
          Image Recognition</title><summary>Placeholder.</summary>
        <author><name>Kaiming He</name></author><author><name>Jian Sun</name></author></entry>`),
    );
    expect(c).toMatchObject({ arxivId: "1512.03385", year: 2015, title: "Deep Residual Learning for Image Recognition", venue: "arXiv", url: "https://arxiv.org/abs/1512.03385" });
    expect(c?.authors.map((a) => a.surname)).toEqual(["He", "Sun"]);
  });

  it("ignores arXiv's error entries for unknown ids", () => {
    expect(parseArxivFeed(feed(`<entry><id>http://arxiv.org/api/errors#incorrect_id_format</id><title>Error</title></entry>`))).toEqual([]);
  });

  it("queries by id_list", async () => {
    const { gw, calls } = fakeGateway();
    await arxivIdResolver(gw).resolve(REF);
    expect(calls).toEqual([["arxiv", "https://export.arxiv.org/api/query?id_list=1512.03385"]]);
  });
});
