import type { Author } from "../../../core/types.js";
import { normalizeTitle } from "../scoring.js";

/** "Kaiming He" → { name, surname: "He" }. Used for sources that only give a display name. */
export function authorFromName(name: string): Author {
  const clean = name.replace(/\s+/g, " ").trim();
  return { name: clean, surname: clean.split(" ").at(-1) ?? clean };
}

/** Search text: normalized title (punctuation would break some APIs' query syntax). */
export const searchText = (title: string) => normalizeTitle(title);

/** Strip JATS/HTML tags from an abstract and collapse whitespace. */
export function stripMarkup(s: string | null | undefined): string | null {
  const t = (s ?? "").replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
  return t || null;
}

/** arXiv's DataCite DOIs (10.48550/arXiv.1512.03385) carry the arXiv id. */
export function arxivIdFromDoi(doi: string | null | undefined): string | null {
  return /^10\.48550\/arxiv\.(.+)$/i.exec(doi ?? "")?.[1] ?? null;
}

export function arxivIdFromUrl(url: string | null | undefined): string | null {
  return /arxiv\.org\/(?:abs|pdf)\/([^?#\s]+?)(?:v\d+)?(?:\.pdf)?$/i.exec(url ?? "")?.[1] ?? null;
}
