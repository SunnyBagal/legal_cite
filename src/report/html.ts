import type { PaperReport, Reporter, ReportContext, ReportRecord, ReportReference } from "./types.js";

/**
 * Self-contained HTML report: no external assets, works offline, prints cleanly, readable
 * without JavaScript (the script only adds filtering and search). Every value comes from
 * PDFs, third-party APIs or an LLM, so all text is escaped and only http(s) links render.
 */

const EXISTENCE_LABEL: Record<string, string> = {
  VERIFIED: "Verified",
  MISMATCH: "Mismatch",
  NOT_FOUND: "Not found",
  AMBIGUOUS: "Ambiguous",
  ERROR: "Not checked",
};
const EXISTENCE_ORDER = ["NOT_FOUND", "MISMATCH", "AMBIGUOUS", "ERROR", "VERIFIED"] as const;
const RELEVANCE_LABEL: Record<string, string> = {
  SUPPORTS: "Supports",
  PARTIAL: "Partly supports",
  UNRELATED: "Unrelated",
  CANNOT_TELL: "Can’t tell",
};
/** Words for counts in running text ("2 mismatched", "56 partly supported"). */
const EXISTENCE_COUNT: Record<string, string> = { VERIFIED: "verified", MISMATCH: "mismatched", NOT_FOUND: "not found", AMBIGUOUS: "ambiguous", ERROR: "not checked" };
const RELEVANCE_COUNT: Record<string, string> = { SUPPORTS: "supported", PARTIAL: "partly supported", UNRELATED: "unrelated", CANNOT_TELL: "can’t tell" };
const FIELD_LABEL: Record<string, string> = { authors: "Authors", year: "Year", venue: "Venue", doi: "DOI", arxivId: "arXiv id" };
const SOURCE_LABEL: Record<string, string> = { crossref: "Crossref", "semantic-scholar": "Semantic Scholar", openalex: "OpenAlex", arxiv: "arXiv" };

export function esc(s: string | number | null | undefined): string {
  return String(s ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/** Only http(s) URLs become links (record URLs come from third-party APIs). */
export function safeUrl(url: string | null | undefined): string | null {
  if (!url) return null;
  try {
    const u = new URL(url);
    return u.protocol === "https:" || u.protocol === "http:" ? u.toString() : null;
  } catch {
    return null;
  }
}

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
const names = (authors: string[], max = 4) =>
  authors.length === 0 ? "" : authors.length > max ? `${authors.slice(0, max).join(", ")} and ${authors.length - max} more` : authors.join(", ");

function citedLine(r: ReportReference): string {
  const c = r.cited;
  if (!c.title && r.raw) return `<p class="cited raw">${esc(r.raw)}</p>`;
  const parts = [
    c.authors.length ? `<span class="who">${esc(names(c.authors))}</span>` : "",
    c.year ? ` (${esc(c.year)})` : "",
    c.title ? `${c.authors.length || c.year ? ". " : ""}<cite>${esc(c.title)}</cite>` : "",
    c.venue ? `. <span class="venue">${esc(c.venue)}</span>` : "",
    c.doi ? `. <span translate="no">doi:${esc(c.doi)}</span>` : "",
    c.arxivId ? `. <span translate="no">arXiv:${esc(c.arxivId)}</span>` : "",
  ];
  return `<p class="cited">${parts.join("")}</p>`;
}

function matchLine(m: ReportRecord): string {
  const href = safeUrl(m.url);
  const title = esc(m.title ?? m.sourceId);
  const link = href ? `<a href="${esc(href)}" rel="noopener noreferrer">${title}</a>` : title;
  const detail = [names(m.authors, 3), m.year, m.venue].filter(Boolean).map(esc).join(", ");
  return `<p class="match">Matched ${link}${detail ? `, ${detail}` : ""}. Source: ${esc(SOURCE_LABEL[m.source] ?? m.source)}.</p>`;
}

/** Escape the sentence, then highlight the first occurrence of the citation marker. */
function sentenceHtml(c: ReportContext): string {
  const s = esc(c.sentence);
  const marker = esc(c.marker);
  const i = marker ? s.indexOf(marker) : -1;
  return i < 0 ? s : `${s.slice(0, i)}<mark>${marker}</mark>${s.slice(i + marker.length)}`;
}

function contextItem(c: ReportContext): string {
  const rel = c.relevance;
  const relHtml = rel
    ? `<p class="rel"><span class="chip r-${esc(rel.verdict)}">${esc(RELEVANCE_LABEL[rel.verdict] ?? rel.verdict)}</span> ${esc(rel.reason)}` +
      `<span class="scope">${esc(rel.scope)}${rel.method === "prefilter" ? ", decided by embedding similarity alone" : ""}${rel.model ? `, ${esc(rel.model)}` : ""}</span></p>`
    : "";
  const inferred = c.linkedBy === "numeric-fallback" ? `<span class="inferred">marker linked to this reference by its number</span>` : "";
  return `<li><blockquote>${c.previousSentence ? `<span class="prev">${esc(c.previousSentence)}</span> ` : ""}${sentenceHtml(c)}</blockquote>` +
    `<p class="where">${esc(c.section ?? "Unknown section")}${inferred ? `; ${inferred}` : ""}</p>${relHtml}</li>`;
}

function referenceArticle(r: ReportReference): string {
  const v = r.existence.verdict;
  const mismatches = r.existence.mismatches.length
    ? `<dl class="mismatches">${r.existence.mismatches
        .map((m) => `<div><dt>${esc(FIELD_LABEL[m.field] ?? m.field)}</dt><dd>cited ${esc(m.cited ?? "nothing")}; found ${esc(m.found ?? "nothing")}</dd></div>`)
        .join("")}</dl>`
    : "";
  const relCounts = new Map<string, number>();
  for (const c of r.contexts) if (c.relevance) relCounts.set(c.relevance.verdict, (relCounts.get(c.relevance.verdict) ?? 0) + 1);
  const relSummary = [...relCounts].map(([k, n]) => `${n} ${RELEVANCE_COUNT[k] ?? k}`).join(", ");
  const contexts = r.contexts.length
    ? `<details><summary>Cited in ${plural(r.contexts.length, "place")}${relSummary ? `: ${esc(relSummary)}` : ""}</summary><ol class="contexts">${r.contexts.map(contextItem).join("")}</ol></details>`
    : `<p class="none">No in-text citation of this reference was found.</p>`;
  const searchText = [r.key, r.cited.title, r.raw, ...r.cited.authors].filter(Boolean).join(" ").toLowerCase();
  return `<article class="ref" id="ref-${esc(r.key)}" data-verdict="${esc(v)}" data-search="${esc(searchText)}">
<div class="mark"><span class="verdict v-${esc(v)}">${esc(EXISTENCE_LABEL[v] ?? v)}</span><span class="key" translate="no">${esc(r.key)}</span>${r.existence.degraded ? `<span class="degraded">some lookups failed</span>` : ""}</div>
<div class="body">${citedLine(r)}${r.existence.match ? matchLine(r.existence.match) : ""}${mismatches}${v === "VERIFIED" ? "" : `<p class="reason">${esc(r.existence.reason)}</p>`}${contexts}</div>
</article>`;
}

function summarySentences(rep: PaperReport): string {
  const s = rep.summary;
  const parts = EXISTENCE_ORDER.filter((k) => s.existence[k]).map((k) => `${s.existence[k]} ${EXISTENCE_COUNT[k]}`);
  let html = `<p class="lede">${esc(plural(s.references, "reference"))} checked: ${esc(parts.join(", "))}.</p>`;
  if (s.relevance) {
    const r = s.relevance;
    const rel = (["UNRELATED", "PARTIAL", "CANNOT_TELL", "SUPPORTS"] as const)
      .filter((k) => r.verdicts[k])
      .map((k) => `${r.verdicts[k]} ${RELEVANCE_COUNT[k]}`);
    html += `<p class="lede-sub">Across ${esc(plural(r.contexts, "citing sentence"))} of references that exist: ${esc(rel.join(", ") || "none judged")}${r.missing ? `; ${esc(r.missing)} not judged because a job did not finish` : ""}.</p>`;
  } else {
    html += `<p class="lede-sub">Relevance was not checked in this run.</p>`;
  }
  if (s.degraded) html += `<p class="lede-sub">${esc(plural(s.degraded, "reference"))} had a failed lookup; none of those is reported as not found.</p>`;
  return html;
}

const CSS = `
:root{--paper:#f3f5f7;--surface:#fff;--ink:#1d2733;--muted:#566173;--rule:#d9dee5;--pencil:#2f5fd0;
--verified:#2e7d5b;--mismatch:#8a5f0a;--notfound:#b33a3a;--ambiguous:#6b5ca5;--unchecked:#566173;
--serif:"Iowan Old Style","Charter","Sitka Text","Georgia",serif;--sans:"Avenir Next","Segoe UI Variable Text","Segoe UI","Helvetica Neue",system-ui,sans-serif}
@media (prefers-color-scheme:dark){:root{--paper:#11161d;--surface:#18202a;--ink:#e6eaf0;--muted:#a3adbb;--rule:#2c3644;--pencil:#8fb0ff;
--verified:#6cc79c;--mismatch:#e0b45a;--notfound:#f08a8a;--ambiguous:#b3a6ec;--unchecked:#a3adbb}}
*{box-sizing:border-box}
html{background:var(--paper);color:var(--ink);font:16px/1.5 var(--sans);font-variant-numeric:tabular-nums;scroll-padding-top:8rem}
.skip{position:absolute;left:-999px;top:.5rem;background:var(--surface);color:var(--pencil);padding:.4rem .8rem;border-radius:0;z-index:2}
.skip:focus{left:1rem}
.visually-hidden{position:absolute;width:1px;height:1px;overflow:hidden;clip:rect(0 0 0 0);white-space:nowrap}
body{margin:0 auto;max-width:72rem;padding:2.5rem 1.5rem 4rem}
a{color:var(--pencil);text-underline-offset:2px}
:focus-visible{outline:2px solid var(--pencil);outline-offset:2px;border-radius:0}
header h1{font:600 clamp(1.6rem,3.2vw,2.4rem)/1.15 var(--serif);margin:0 0 .4rem;max-width:40ch;text-wrap:balance}
.source{color:var(--muted);margin:0 0 1.5rem}
.lede{font:500 1.25rem/1.4 var(--sans);margin:0 0 .25rem;max-width:62ch}
.lede-sub{color:var(--muted);margin:0 0 .25rem;max-width:72ch}
.notice{border-left:3px solid var(--ambiguous);padding:.4rem .9rem;margin:1rem 0 0;max-width:72ch;color:var(--muted)}
.strip{display:flex;flex-wrap:wrap;gap:3px;margin:2rem 0 .5rem;padding:0;list-style:none}
.strip a{display:block;width:12px;height:28px;border-radius:0;background:var(--c)}
.strip a[aria-hidden-ref="true"]{opacity:.18}
.strip a:hover{transform:scaleY(1.25)}
.strip-legend{display:flex;flex-wrap:wrap;gap:1rem;color:var(--muted);font-size:.875rem;margin:0 0 1.5rem}
.strip-legend span::before{content:"";display:inline-block;width:10px;height:10px;border-radius:0;background:var(--c);margin-right:.35rem}
.controls{display:flex;flex-wrap:wrap;gap:.5rem 1.25rem;align-items:center;padding:.75rem 0;border-block:1px solid var(--rule);margin-bottom:.5rem;position:sticky;top:0;background:var(--paper);z-index:1}
.controls label{display:inline-flex;gap:.35rem;align-items:center;cursor:pointer}
.controls input[type=search]{font:inherit;padding:.3rem .6rem;border:1px solid var(--rule);border-radius:0;background:var(--surface);color:var(--ink);min-width:16rem}
.controls button{font:inherit;padding:.3rem .7rem;border:1px solid var(--rule);border-radius:0;background:var(--surface);color:var(--ink);cursor:pointer;touch-action:manipulation}
.controls button:hover{border-color:var(--pencil)}
.controls label,.controls input,.strip a,summary{touch-action:manipulation}
.strip a:focus-visible{transform:scaleY(1.25)}
.shown{color:var(--muted);margin-left:auto}
.ref{display:grid;grid-template-columns:9.5rem minmax(0,1fr);gap:1.25rem;padding:1.1rem 0;border-bottom:1px solid var(--rule);scroll-margin-top:8rem;content-visibility:auto;contain-intrinsic-size:auto 9rem}
.ref[hidden]{display:none}
.mark{display:flex;flex-direction:column;gap:.2rem}
.verdict{font-weight:650;color:var(--c)}
.key{color:var(--muted);font-size:.875rem}
.degraded{color:var(--muted);font-size:.8rem}
.v-VERIFIED,.strip .v-VERIFIED,.strip-legend .v-VERIFIED{--c:var(--verified)}
.v-MISMATCH{--c:var(--mismatch)}.v-NOT_FOUND{--c:var(--notfound)}.v-AMBIGUOUS{--c:var(--ambiguous)}.v-ERROR{--c:var(--unchecked)}
.body{min-width:0}
.body>*{margin:0 0 .45rem;max-width:72ch;overflow-wrap:anywhere}
.cited{font:1.05rem/1.55 var(--serif)}
.cited cite{font-style:italic}
.cited.raw{color:var(--muted)}
.match{color:var(--ink)}
.reason{color:var(--muted)}
.mismatches{display:grid;gap:.15rem}
.mismatches div{display:flex;gap:.6rem}
.mismatches dt{font-weight:650;color:var(--mismatch);min-width:5rem}
.mismatches dd{margin:0}
details summary{cursor:pointer;color:var(--pencil);width:fit-content}
.contexts{margin:.6rem 0 0;padding-left:1.2rem}
.contexts li{margin-bottom:.9rem}
blockquote{margin:0;font:1rem/1.6 var(--serif)}
.prev{color:var(--muted)}
mark{background:none;color:inherit;font-weight:700;box-shadow:inset 0 -.35em 0 color-mix(in srgb,var(--pencil) 22%,transparent)}
.where{color:var(--muted);font-size:.875rem;margin:.15rem 0}
.inferred{font-style:italic}
.rel{margin:.2rem 0}
.chip{display:inline-block;font-weight:650;font-size:.85rem;padding:.05rem .45rem;border-radius:0;border:1.5px solid var(--c);color:var(--c);margin-right:.35rem}
.r-SUPPORTS{--c:var(--verified)}.r-PARTIAL{--c:var(--mismatch)}.r-UNRELATED{--c:var(--notfound)}.r-CANNOT_TELL{--c:var(--unchecked)}
.scope{display:block;color:var(--muted);font-size:.8rem;margin-top:.1rem}
.none{color:var(--muted);font-style:italic}
footer{margin-top:3rem;color:var(--muted);font-size:.875rem;max-width:72ch}
.controls button[aria-pressed="true"]{border-color:var(--pencil);color:var(--pencil)}
@media (max-width:40rem){.ref{grid-template-columns:minmax(0,1fr);gap:.4rem}.lede,.lede-sub,.notice{overflow-wrap:anywhere}.mark{flex-direction:row;gap:.75rem;align-items:baseline}.controls{position:static}.controls input[type=search]{min-width:0;width:100%}}
@media (prefers-reduced-motion:reduce){*{transition:none!important}.strip a:hover{transform:none}}
@media print{html{background:#fff;color:#000;font-size:11pt}.ref{content-visibility:visible}body{max-width:none;padding:0}.controls,.strip,.strip-legend{display:none}.ref{break-inside:avoid;grid-template-columns:7.5rem 1fr}a{color:inherit}a[href]::after{content:" <" attr(href) ">";font-size:.8em;word-break:break-all}}
`;

const SCRIPT = `
(()=>{const refs=[...document.querySelectorAll('.ref')];const boxes=[...document.querySelectorAll('[data-filter]')];
const q=document.getElementById('q');const shown=document.getElementById('shown');
const ticks=new Map([...document.querySelectorAll('.strip a')].map(a=>[a.getAttribute('href').slice(1),a]));
function apply(){const on=new Set(boxes.filter(b=>b.checked).map(b=>b.dataset.filter));const t=(q.value||'').trim().toLowerCase();let n=0;
for(const r of refs){const ok=on.has(r.dataset.verdict)&&(!t||r.dataset.search.includes(t));r.hidden=!ok;if(ok)n++;
const k=ticks.get(r.id);if(k)k.setAttribute('aria-hidden-ref',String(!ok));}
shown.textContent=n+' of '+refs.length+' shown';}
boxes.forEach(b=>b.addEventListener('change',apply));q.addEventListener('input',apply);
const all=document.getElementById('expand');all.addEventListener('click',()=>{const d=[...document.querySelectorAll('.ref:not([hidden]) details')];const open=!d.every(x=>x.open);d.forEach(x=>x.open=open);all.textContent=open?'Collapse citing sentences':'Expand citing sentences';});
const focus=document.getElementById('focus');const ver=boxes.find(b=>b.dataset.filter==='VERIFIED');
focus.addEventListener('click',()=>{const on=focus.getAttribute('aria-pressed')!=='true';focus.setAttribute('aria-pressed',String(on));boxes.forEach(b=>b.checked=on?b!==ver:true);focus.textContent=on?'Show all references':'Show only references that need a look';apply();});
window.addEventListener('beforeprint',()=>document.querySelectorAll('details').forEach(d=>d.open=true));
document.querySelector('.controls').hidden=false;apply();})();
`;

export const htmlReporter: Reporter = {
  filename: "report.html",
  render(rep: PaperReport): string {
    const source = rep.paper.sourceKind === "arxiv" ? `arXiv:${rep.paper.source}` : rep.paper.source.split("/").pop() ?? rep.paper.source;
    const sourceHref = rep.paper.sourceKind === "arxiv" ? safeUrl(`https://arxiv.org/abs/${rep.paper.source}`) : null;
    const title = rep.paper.title ?? source;
    const counts = rep.summary.existence;
    const strip = rep.references
      .map((r) => {
        const label = `${r.key}: ${r.cited.title ?? r.raw ?? ""} (${EXISTENCE_LABEL[r.existence.verdict]})`;
        return `<li><a class="v-${esc(r.existence.verdict)}" href="#ref-${esc(r.key)}" title="${esc(label)}" aria-label="${esc(label)}"></a></li>`;
      })
      .join("");
    const legend = EXISTENCE_ORDER.filter((k) => counts[k]).map((k) => `<span class="v-${k}">${EXISTENCE_LABEL[k]} ${counts[k]}</span>`).join("");
    const filters = EXISTENCE_ORDER.filter((k) => counts[k])
      .map((k) => `<label><input type="checkbox" data-filter="${k}" checked> ${EXISTENCE_LABEL[k]} (${counts[k]})</label>`)
      .join("");
    const llm = rep.settings.relevance ? `relevance judged by ${esc(rep.settings.llm ?? "an LLM")} (${esc(rep.settings.verifierVersion)})` : "relevance not checked";
    return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="color-scheme" content="light dark">
<meta name="theme-color" content="#f3f5f7" media="(prefers-color-scheme: light)">
<meta name="theme-color" content="#11161d" media="(prefers-color-scheme: dark)">
<title>Citation check: ${esc(title)}</title>
<style>${CSS}</style>
</head>
<body>
<a class="skip" href="#references">Skip to references</a>
<header>
<h1>${esc(title)}</h1>
<p class="source">Citation check of ${sourceHref ? `<a href="${esc(sourceHref)}" translate="no">${esc(source)}</a>` : esc(source)}, <time datetime="${esc(rep.generatedAt)}">${esc(new Intl.DateTimeFormat("en", { dateStyle: "long", timeZone: "UTC" }).format(new Date(rep.generatedAt)))}</time></p>
${summarySentences(rep)}
${rep.settings.relevance ? `<p class="notice">${esc(rep.relevanceNotice)}</p>` : ""}
</header>
<main>
<ul class="strip" aria-label="Every reference, in bibliography order, colored by existence verdict">${strip}</ul>
<p class="strip-legend" aria-hidden="true">${legend}</p>
<div class="controls" hidden>
${filters}
<input type="search" id="q" name="q" placeholder="Search titles, authors, keys…" aria-label="Search references" autocomplete="off" spellcheck="false">
<button type="button" id="focus" aria-pressed="false">Show only references that need a look</button>
<button type="button" id="expand">Expand citing sentences</button>
<span class="shown" id="shown" aria-live="polite"></span>
</div>
<h2 id="references" class="visually-hidden" tabindex="-1">References</h2>
${rep.references.map(referenceArticle).join("\n")}
</main>
<footer>
<p>Existence verdicts come from lookups in Crossref, Semantic Scholar, OpenAlex, arXiv and the DOI registry, scored deterministically; no language model decides whether a work exists. ${llm}. A “not found” means the cited work is not in those indexes, which is common for web pages, software and reports.</p>
<p>Thank you to arXiv for use of its open access interoperability. Contains data from Semantic Scholar.</p>
</footer>
<script>${SCRIPT}</script>
</body>
</html>
`;
  },
};
