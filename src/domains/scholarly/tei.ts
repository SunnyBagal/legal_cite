import { DOMParser, type Element } from "@xmldom/xmldom";
import type { CitationContext, ExtractedDocument, Reference } from "../../core/types.js";

/** Parse GROBID processFulltextDocument TEI into references + citation contexts. */
export function parseTei(tei: string): ExtractedDocument {
  const root = new DOMParser().parseFromString(tei, "text/xml").documentElement;
  if (!root) throw new Error("TEI: empty document");

  const titleStmt = first(root, "titleStmt");
  const title = clean(titleStmt ? text(first(titleStmt, "title")) : null);

  const listBibl = first(root, "listBibl");
  const references = listBibl ? elements(listBibl, "biblStruct").map(parseBiblStruct) : [];

  const keys = references.map((r) => r.key);
  const known = new Set(keys);
  const body = first(root, "body");
  const contexts = body ? parseContexts(body, keys).filter((c) => known.has(c.referenceKey)) : [];

  return { title, references, contexts, raw: tei };
}

interface Marker {
  text: string;
  target: string | null;
  segment: number;
  sentence: string;
  previousSentence: string | null;
  section: string | null;
}

/**
 * One context per (citation marker, reference). Requires GROBID's segmentSentences=1, so
 * the citing sentence is the enclosing <s>; the previous sentence is the preceding <s> in
 * the same section or footnote (possibly from the previous paragraph).
 *
 * GROBID links most markers itself via @target. When it doesn't, and the marker is purely
 * numeric, we map [n] to entry n of the reference list of the marker's document segment.
 * A segment boundary is a restart of top-level section numbering (e.g. an appended system
 * card); each segment owns the next list in the concatenated bibliography.
 */
function parseContexts(body: Element, keys: string[]): CitationContext[] {
  const markers = collectMarkers(body);
  const offsets = segmentOffsets(markers, keys);
  return markers.flatMap((m): CitationContext[] => {
    const base = { sentence: m.sentence, previousSentence: m.previousSentence, section: m.section, marker: m.text };
    if (m.target) return [{ ...base, referenceKey: m.target, linkedBy: "grobid" }];
    const offset = offsets[m.segment] ?? 0;
    return markerNumbers(m.text).flatMap((n) => {
      const key = keys[offset + n - 1];
      return key ? [{ ...base, referenceKey: key, linkedBy: "numeric-fallback" as const }] : [];
    });
  });
}

function collectMarkers(body: Element): Marker[] {
  const markers: Marker[] = [];
  let segment = 0;
  let maxTop = 0;
  for (const block of childElements(body)) {
    if (block.tagName !== "div" && block.tagName !== "note") continue;
    const head = childElements(block).find((c) => c.tagName === "head") ?? null;
    const top = Number.parseInt(head?.getAttribute("n") ?? "", 10);
    if (top === 1 && maxTop > 1) {
      segment++;
      maxTop = 0;
    }
    if (Number.isFinite(top)) maxTop = Math.max(maxTop, top);

    const section = block.tagName === "note" ? "Footnote" : clean(text(head));
    const sentences = childElements(block)
      .filter((c) => c.tagName === "p")
      .flatMap((p) => elements(p, "s"));
    sentences.forEach((s, i) => {
      for (const ref of elements(s, "ref")) {
        if (ref.getAttribute("type") !== "bibr") continue;
        const target = ref.getAttribute("target");
        markers.push({
          text: clean(ref.textContent) ?? "",
          target: target?.startsWith("#") ? target.slice(1) : null,
          segment,
          sentence: clean(s.textContent) ?? "",
          previousSentence: i > 0 ? clean(sentences[i - 1]?.textContent) : null,
          section,
        });
      }
    });
  }
  return markers;
}

/**
 * Index of the first reference of each segment's list. Learned from GROBID-linked numeric
 * markers in the segment (most common index − (n − 1)); otherwise the previous segment's
 * offset plus the highest marker number seen in it.
 */
function segmentOffsets(markers: Marker[], keys: string[]): number[] {
  const segments = Math.max(0, ...markers.map((m) => m.segment)) + 1;
  const offsets: number[] = [];
  for (let seg = 0; seg < segments; seg++) {
    const inSeg = markers.filter((m) => m.segment === seg);
    const votes = new Map<number, number>();
    for (const m of inSeg) {
      const nums = markerNumbers(m.text);
      const idx = m.target ? keys.indexOf(m.target) : -1;
      if (nums.length === 1 && idx >= 0) {
        const o = idx - (nums[0]! - 1);
        votes.set(o, (votes.get(o) ?? 0) + 1);
      }
    }
    const learned = [...votes.entries()].sort((a, b) => b[1] - a[1])[0]?.[0];
    if (learned !== undefined) offsets.push(learned);
    else if (seg === 0) offsets.push(0);
    else {
      const prev = markers.filter((m) => m.segment === seg - 1).flatMap((m) => markerNumbers(m.text));
      offsets.push((offsets[seg - 1] ?? 0) + Math.max(0, ...prev));
    }
  }
  return offsets;
}

/** "[12]", "[3,", "5]", "7", "[2-4]" → numbers; anything else ("85.6", "Smith 2020") → []. */
export function markerNumbers(marker: string): number[] {
  const m = /^\[?\s*(\d{1,3})(?:\s*[-–]\s*(\d{1,3}))?\s*[,;\]]?$/.exec(marker.trim());
  if (!m) return [];
  const from = Number(m[1]);
  const to = m[2] ? Number(m[2]) : from;
  if (from < 1 || to < from || to - from > 20) return [];
  return Array.from({ length: to - from + 1 }, (_, i) => from + i);
}

function parseBiblStruct(b: Element): Reference {
  const analytic = first(b, "analytic");
  const monogr = first(b, "monogr");
  const titleOf = (el: Element | null) => clean(el ? text(first(el, "title")) : null);
  const raw = clean(text(note(b, "raw_reference")));
  const idnos = elements(b, "idno");
  const doi = idnos.find((i) => i.getAttribute("type") === "DOI");

  // With an <analytic> part the work is an article/chapter and <monogr> is its venue;
  // without one, <monogr> is the work itself (book, report, preprint).
  const title = analytic ? titleOf(analytic) : (titleOf(monogr) ?? titleFromReportType(b));
  const venue = analytic && monogr ? (titleOf(monogr) ?? clean(text(first(monogr, "meeting")))) : null;

  return {
    kind: "scholarly",
    key: b.getAttribute("xml:id") ?? "",
    title,
    authors: elements(analytic ?? monogr ?? b, "persName").map(parseAuthor).filter((a) => a.surname !== ""),
    year: parseYear(b),
    venue,
    doi: clean(text(doi ?? null))?.toLowerCase() ?? null,
    arxivId: findArxivId([...idnos.map((i) => i.textContent ?? ""), raw ?? ""]),
    ids: {},
    raw,
  };
}

function parseAuthor(p: Element): { name: string; surname: string } {
  const forenames = elements(p, "forename").map((f) => clean(f.textContent)).filter(Boolean);
  const surname = clean(text(first(p, "surname"))) ?? "";
  return { name: [...forenames, surname].join(" ").trim(), surname };
}

function parseYear(b: Element): number | null {
  const date = elements(b, "date").find((d) => d.getAttribute("type") === "published");
  const m = /\d{4}/.exec(date?.getAttribute("when") ?? date?.textContent ?? "");
  return m ? Number(m[0]) : null;
}

/** New-style (1607.06450) or old-style (cs/0112017) arXiv ids, version stripped. */
export function findArxivId(texts: string[]): string | null {
  for (const t of texts) {
    const m =
      /(?:arxiv:|abs\/)\s*(\d{4}\.\d{4,5})(?:v\d+)?/i.exec(t) ??
      /(?:arxiv:|abs\/)\s*([a-z-]+(?:\.[A-Z]{2})?\/\d{7})(?:v\d+)?/i.exec(t);
    if (m?.[1]) return m[1];
  }
  return null;
}

/** GROBID sometimes leaves <title/> empty and files "Title. arXiv preprint" under report_type. */
function titleFromReportType(b: Element): string | null {
  const rt = clean(text(note(b, "report_type")));
  if (!rt) return null;
  return clean(rt.replace(/\.?\s*(arxiv preprint|technical report|preprint)\s*$/i, ""));
}

function note(b: Element, type: string): Element | null {
  return elements(b, "note").find((n) => n.getAttribute("type") === type) ?? null;
}

// ---------------------------------------------------------------- DOM helpers

function elements(el: Element, name: string): Element[] {
  return Array.from(el.getElementsByTagName(name));
}

function childElements(el: Element): Element[] {
  return Array.from(el.childNodes).filter((n): n is Element => n.nodeType === 1);
}

function first(el: Element, name: string): Element | null {
  return el.getElementsByTagName(name).item(0);
}

function text(el: Element | null): string | null {
  return el ? el.textContent : null;
}

/** Collapse whitespace; empty → null. */
function clean(s: string | null | undefined): string | null {
  const t = (s ?? "").replace(/\s+/g, " ").trim();
  return t === "" ? null : t;
}
