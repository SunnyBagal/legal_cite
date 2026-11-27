import { DOMParser, type Element } from "@xmldom/xmldom";
import type { CitationContext, ExtractedDocument, Reference } from "../../core/types.js";

/** Parse GROBID processFulltextDocument TEI into references + citation contexts. */
export function parseTei(tei: string): ExtractedDocument {
  const root = new DOMParser().parseFromString(tei, "text/xml").documentElement;
  if (!root) throw new Error("TEI: empty document");

  const titleStmt = first(root, "titleStmt");
  const title = clean(titleStmt ? text(first(titleStmt, "title")) : null);

  const listBibl = first(root, "listBibl");
  const references = uniqueKeys(listBibl ? elements(listBibl, "biblStruct").map(parseBiblStruct) : []);
  const keys = references.map((r) => r.key);

  return { title, references, contexts: parseContexts(root, keys), raw: tei };
}

/** GROBID normally assigns xml:id="bN"; synthesise and de-duplicate keys when it doesn't. */
function uniqueKeys(refs: Reference[]): Reference[] {
  const seen = new Set<string>();
  return refs.map((r, i) => {
    let key = r.key || `idx${i}`;
    while (seen.has(key)) key = `${key}_${i}`;
    seen.add(key);
    return { ...r, key };
  });
}

interface Marker {
  text: string;
  target: string | null;
  /** Document segment (one per reference list); null when it can't be determined. */
  segment: number | null;
  /** Part of a bracketed run like "[3,", "4]"; bare numbers are often mis-tagged figure numbers. */
  bracketed: boolean;
  sentence: string;
  previousSentence: string | null;
  section: string | null;
}

/**
 * One context per (citation marker, reference). Requires GROBID's segmentSentences=1, so
 * the citing sentence is the enclosing <s>; the previous sentence is the preceding <s> in
 * the same section or footnote. Scans the abstract, body divs, footnotes and back-matter
 * annexes (figure captions and tables are not scanned).
 *
 * GROBID links most markers itself via @target. When it doesn't (or the target is unknown),
 * and the marker is a bracketed number, we map [n] to entry n of the reference list of the
 * marker's document segment. A segment boundary is a restart of top-level section numbering
 * (e.g. an appended system card); each segment owns the next list in the bibliography.
 * See DECISIONS.md §Extraction.
 */
function parseContexts(root: Element, keys: string[]): CitationContext[] {
  const index = new Map(keys.map((k, i) => [k, i]));
  const markers = collectMarkers(root);
  const offsets = segmentOffsets(markers, index);

  return markers.flatMap((m): CitationContext[] => {
    const base = { sentence: m.sentence, previousSentence: m.previousSentence, section: m.section, marker: m.text };
    const nums = markerNumbers(m.text);
    const targetIdx = m.target === null ? undefined : index.get(m.target);

    if (targetIdx !== undefined) {
      // GROBID link. A linked range ("[2-4]" → #b1) links only its first number; expand the rest.
      const localOffset = targetIdx - ((nums[0] ?? 1) - 1);
      const extra = nums
        .map((n) => keys[localOffset + n - 1])
        .filter((k): k is string => k !== undefined && k !== m.target);
      return [
        { ...base, referenceKey: m.target!, linkedBy: "grobid" },
        ...extra.map((k) => ({ ...base, referenceKey: k, linkedBy: "numeric-fallback" as const })),
      ];
    }

    if (!m.bracketed || m.segment === null) return [];
    const offset = offsets[m.segment] ?? 0;
    const end = Math.min(offsets[m.segment + 1] ?? keys.length, keys.length);
    return nums.flatMap((n) => {
      const i = offset + n - 1;
      const key = i >= offset && i < end ? keys[i] : undefined;
      return key ? [{ ...base, referenceKey: key, linkedBy: "numeric-fallback" as const }] : [];
    });
  });
}

function collectMarkers(root: Element): Marker[] {
  const markers: Marker[] = [];
  const footSegment = new Map<string, number>();
  let segment = 0;
  let maxTop = 0;

  const scan = (block: Element, section: string | null, seg: number | null) => {
    const sentences = childElements(block)
      .filter((c) => c.tagName === "p")
      .flatMap((p) => elements(p, "s"));
    sentences.forEach((s, i) => {
      for (const r of elements(s, "ref")) {
        const t = r.getAttribute("target");
        if (r.getAttribute("type") === "foot" && t?.startsWith("#") && seg !== null) footSegment.set(t.slice(1), seg);
      }
      for (const run of bibrRuns(s)) {
        // A run that opens the sentence was printed after the previous sentence's full stop
        // ("...impacts.[1-7] This system card..."), so it cites the previous sentence.
        const shift = run.atStart && i > 0 ? 1 : 0;
        const sentence = clean(sentences[i - shift]?.textContent) ?? "";
        const previousSentence = i - shift > 0 ? clean(sentences[i - shift - 1]?.textContent) : null;
        for (const r of run.refs) {
          const target = r.getAttribute("target");
          markers.push({
            text: clean(r.textContent) ?? "",
            target: target?.startsWith("#") ? target.slice(1) : null,
            segment: seg,
            bracketed: run.bracketed,
            sentence,
            previousSentence,
            section,
          });
        }
      }
    });
  };

  const abstract = first(root, "abstract");
  if (abstract) for (const div of elements(abstract, "div")) scan(div, "Abstract", 0);

  const body = first(root, "body");
  const notes: Element[] = [];
  for (const block of body ? childElements(body) : []) {
    if (block.tagName === "note") {
      notes.push(block); // GROBID emits every footnote at the end of <body>; place them by anchor below.
      continue;
    }
    if (block.tagName !== "div") continue;
    const head = childElements(block).find((c) => c.tagName === "head") ?? null;
    const n = head?.getAttribute("n") ?? "";
    if (/^\d+$/.test(n)) {
      const top = Number(n);
      if (top === 1 && maxTop > 1) {
        segment++;
        maxTop = 0;
      }
      maxTop = Math.max(maxTop, top);
    }
    scan(block, clean(text(head)), segment);
  }

  const back = first(root, "back");
  const annexes = back ? childElements(back).filter((d) => d.tagName === "div" && d.getAttribute("type") === "annex") : [];
  for (const annex of annexes) {
    for (const div of [annex, ...childElements(annex).filter((c) => c.tagName === "div")]) {
      const head = childElements(div).find((c) => c.tagName === "head") ?? null;
      scan(div, clean(text(head)), segment);
    }
  }

  for (const note of notes) {
    const anchored = footSegment.get(note.getAttribute("xml:id") ?? "");
    scan(note, "Footnote", anchored ?? (segment === 0 ? 0 : null));
  }
  return markers;
}

/** Adjacent bibr refs in a sentence, separated only by spaces/punctuation, form one run. */
function bibrRuns(s: Element): { refs: Element[]; bracketed: boolean; atStart: boolean }[] {
  const runs: { refs: Element[]; text: string; atStart: boolean }[] = [];
  let current: { refs: Element[]; text: string; atStart: boolean } | null = null;
  let seenContent = false;
  for (const node of Array.from(s.childNodes)) {
    const isBibr = node.nodeType === 1 && (node as Element).tagName === "ref" && (node as Element).getAttribute("type") === "bibr";
    if (isBibr) {
      const el = node as Element;
      if (!current) {
        current = { refs: [], text: "", atStart: !seenContent };
        runs.push(current);
      }
      current.refs.push(el);
      current.text += el.textContent ?? "";
      seenContent = true;
      continue;
    }
    const t = node.textContent ?? "";
    if (current && /^[\s,;]*$/.test(t)) {
      current.text += t;
      continue;
    }
    current = null;
    if (t.trim() !== "") seenContent = true;
  }
  // bibr refs nested deeper than direct children (rare) become single, unbracketed runs.
  const direct = new Set(runs.flatMap((r) => r.refs));
  const nested = elements(s, "ref").filter((r) => r.getAttribute("type") === "bibr" && !direct.has(r));
  return [
    ...runs.map((r) => ({ refs: r.refs, atStart: r.atStart, bracketed: /^\[.*\]$/.test(r.text.trim().replace(/[.,;]+$/, "")) })),
    ...nested.map((r) => ({ refs: [r], atStart: false, bracketed: /^\[.*\]$/.test((r.textContent ?? "").trim()) })),
  ];
}

/**
 * Index of the first reference of each segment's list. Learned from GROBID-linked single-number
 * markers in the segment (most common index − (n − 1)); otherwise the previous segment's offset
 * plus the highest bracketed marker number seen in it.
 */
function segmentOffsets(markers: Marker[], index: Map<string, number>): number[] {
  const segments = Math.max(0, ...markers.map((m) => m.segment ?? 0)) + 1;
  const offsets: number[] = [];
  for (let seg = 0; seg < segments; seg++) {
    const inSeg = markers.filter((m) => m.segment === seg);
    const votes = new Map<number, number>();
    for (const m of inSeg) {
      const nums = markerNumbers(m.text);
      const idx = m.target === null ? undefined : index.get(m.target);
      if (nums.length === 1 && idx !== undefined) {
        const o = idx - (nums[0]! - 1);
        votes.set(o, (votes.get(o) ?? 0) + 1);
      }
    }
    const learned = [...votes.entries()].sort((a, b) => b[1] - a[1])[0]?.[0];
    if (learned !== undefined) offsets.push(learned);
    else if (seg === 0) offsets.push(0);
    else {
      const prev = markers.filter((m) => m.segment === seg - 1 && m.bracketed).flatMap((m) => markerNumbers(m.text));
      offsets.push((offsets[seg - 1] ?? 0) + Math.max(0, ...prev));
    }
  }
  return offsets;
}

/**
 * Citation numbers in a marker: "[12]", "[3,", "5]", "7", "[2-4]", "[77] [78]" → numbers.
 * Anything with other characters ("85.6", "3%", "Smith 2020") → []. Ranges capped at 20.
 */
export function markerNumbers(marker: string): number[] {
  const t = marker.trim();
  if (!/^[\[\]\d\s,;–-]+$/.test(t)) return [];
  return [...t.matchAll(/(\d{1,3})(?:\s*[-–]\s*(\d{1,3}))?/g)].flatMap((m) => {
    const from = Number(m[1]);
    const to = m[2] ? Number(m[2]) : from;
    if (from < 1 || to < from || to - from > 20) return [];
    return Array.from({ length: to - from + 1 }, (_, i) => from + i);
  });
}

function parseBiblStruct(b: Element): Reference {
  const analytic = first(b, "analytic");
  const monogr = first(b, "monogr");
  const titleOf = (el: Element | null) => clean(el ? text(first(el, "title")) : null);
  const raw = clean(text(note(b, "raw_reference")));
  const idnos = elements(b, "idno");
  const doi = idnos.find((i) => i.getAttribute("type") === "DOI");

  // With a titled <analytic> part the work is an article/chapter and <monogr> is its venue.
  // Otherwise <monogr> is the work itself (book, report, preprint) -- including when GROBID
  // emits an empty <analytic><title/> and files the real title under <monogr>.
  const analyticTitle = titleOf(analytic);
  const title = stripPublisher(analyticTitle ?? titleOf(monogr) ?? titleFromReportType(b));
  const venue = analyticTitle && monogr ? (titleOf(monogr) ?? clean(text(first(monogr, "meeting")))) : null;

  return {
    kind: "scholarly",
    key: b.getAttribute("xml:id") || "",
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

/** GROBID sometimes glues the publisher onto a book title: "What We Owe The Future. Basic Books". */
function stripPublisher(title: string | null): string | null {
  if (!title) return null;
  const m = /^(.{8,}?)\.\s+((?:[A-Z][\w&'-]*\s*){1,4})$/.exec(title);
  const tail = m?.[2] ?? "";
  return m && /\b(press|books|publishing|publishers|gutenberg|university|wiley|springer|elsevier)\b/i.test(tail) ? m[1]!.trim() : title;
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
