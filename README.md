# citecheck

Checks the reference list of a research paper. For every reference it answers two questions:

1. **Existence:** does the cited work exist with the metadata given (title, authors, year, venue, DOI/arXiv id)? This is decided by lookups in Crossref, Semantic Scholar, OpenAlex, arXiv and the DOI registry, followed by deterministic scoring. A language model never decides existence.
2. **Relevance (optional):** does the cited work plausibly support the sentence that cites it? One LLM call per citing sentence compares the sentence with the cited work's abstract. Every verdict is labelled *abstract-level, needs human review*.

It writes a JSON report and a self-contained HTML report, with one row per reference.

> This is a learning and portfolio project, not a new product. Several tools already do this, some of them better; see [Prior art](#prior-art).

## Run it

You need Node 22+, pnpm and Docker.

```sh
pnpm install
cp .env.example .env            # optional: CONTACT_EMAIL, API keys (see below)
docker compose up -d            # Postgres, Redis (queues), Redis (API cache), GROBID
pnpm citecheck run 2303.08774   # an arXiv id, or a path to a local PDF
```

The run prints a summary and the path to `reports/<paper-id>/report.html`.

| Command | What it does |
|---|---|
| `pnpm citecheck run <arxiv-id \| pdf>` | Full pipeline. `--no-relevance` skips the LLM stage and needs no key. `--llm anthropic\|openai`, `--out <dir>`, `--timeout <min>` |
| `pnpm citecheck report <paper-id>` | Re-render the reports of a finished run from the database |
| `pnpm eval:citeaudit` | Benchmark existence on CiteAudit. Run it twice: the second run is the warm-cache retry pass reported in [eval/RESULTS.md](eval/RESULTS.md) |
| `pnpm test`, `pnpm test:int`, `pnpm lint` | Unit tests, integration tests (needs the containers), strict typecheck plus a secrets scan |

Relevance needs `ANTHROPIC_API_KEY` or `OPENAI_API_KEY` in `.env`. Everything else works without keys. Setting `CONTACT_EMAIL` moves you to Crossref's faster polite pool. If a service is down, the CLI says which one within a few seconds and stops.

## Architecture

```
citecheck run <source>
      │
      ▼                         Postgres: papers, bib_entries, citation_contexts,
 ┌─────────┐  ┌─────────┐       resolution_candidates (+ score breakdown),
 │ ingest  │─▶│ extract │       existence_verdicts, relevance_verdicts,
 └─────────┘  └────┬────┘       raw TEI and raw API responses
  PDF / arXiv      │ GROBID processFulltextDocument
                   │ (references + citing sentence + previous sentence)
                   ▼  BullMQ flow, one child per reference
        ┌──────────────────────┐     ┌──────────────────────┐
        │ resolve (per ref)    │────▶│ relevance (per ref)  │──┐
        │ tier 1: DOI, arXiv id│     │ only VERIFIED or     │  │
        │ tier 2: Crossref q.  │     │ MISMATCH; abstract → │  │
        │ tier 3: S2, OpenAlex,│     │ 1 LLM call / context │  │
        │         arXiv search │     └──────────────────────┘  │
        │ deterministic scorer │                               ▼
        └──────────┬───────────┘                        ┌────────────┐
                   │                                    │  report    │ JSON + HTML
                   ▼                                    └────────────┘
   API gateway: one BullMQ queue per API host (rate limiters from docs/apis.md)
               + Redis response cache (separate instance, LRU, 30-day TTL)
```

- **One queue per stage**: `ingest`, `extract`, `resolve`, `relevance`, `report`. Jobs carry only ids; all state lives in Postgres.
- **Per-reference stages** run as a BullMQ flow (`report ← relevance ← resolve`), so one failing reference can't block the report.
- **Every external call** goes through the gateway: it checks the cache, then queues the request on that API's rate-limited queue. A 403, or a 429 from arXiv, pauses that API rather than hammering it. Credentials are added at fetch time and never appear in cache keys or stored responses.
- **Ports** (`src/core/types.ts`): `Extractor`, `Resolver`, `ExistenceScorer`, `AbstractFetcher`, `RelevanceVerifier`, `LLMProvider`, `Reporter`, plus a `CitationDomain` that bundles resolvers, scorer and abstracts. UK or Indian case-law citations would come in as a new domain plus a judgment extractor, without touching the pipeline. See [DECISIONS.md](DECISIONS.md).

## Verdicts

**Existence** (deterministic):

| Verdict | Meaning |
|---|---|
| `VERIFIED` | A record matches the title (≥ 0.9 similarity, or ≥ 0.6 with a matching DOI/arXiv id) and the authors and year agree (±1 year; print and online years both count). |
| `MISMATCH` | The work exists, but a cited field disagrees: year, authors, or an identifier that points elsewhere. This needs two agreeing sources, or direct evidence such as an unregistered DOI. |
| `NOT_FOUND` | Every lookup succeeded and none matched. Common for web pages, software and reports, which these indexes don't cover. |
| `AMBIGUOUS` | Near misses, venue-only disagreements, or *not found while some lookup failed*. A failed lookup never becomes `NOT_FOUND`. |

**Relevance** (LLM, abstract-level, needs human review): `SUPPORTS`, `PARTIAL`, `UNRELATED`, `CANNOT_TELL`.
- It runs only for references that exist.
- A citation linked to its reference only by its number (GROBID didn't link it) is never called `UNRELATED`: it becomes `CANNOT_TELL`, because the link itself may be wrong.
- No abstract, a refused or failed call, or the per-paper budget (600 calls) also give `CANNOT_TELL`, and the report says which.

## Results

Existence was checked on 400 citations from the public [CiteAudit](https://github.com/shiiiikw/CiteAudit) benchmark: 100 per cell of real and fake, real-world and LLM-generated. There were no API keys, and the run was retried once on a warm cache, which is what the pipeline does.

| Flag as fake | Fake precision | Fake recall | F1 | False-positive rate on real |
|---|---|---|---|---|
| `NOT_FOUND` or `MISMATCH` | 0.895 | 0.215 | 0.346 | 0.025 |
| … or `AMBIGUOUS` | 0.819 | 0.635 | 0.715 | 0.140 |

Throughput was 3.65 to 4.59 s per citation at concurrency 8, and a cold cache needed 1.81 API calls per citation.
- **When it flags a citation, it is usually right.** It misses most fakes, for two reasons.
- **Edited author lists pass:** 73 of 200 fakes changed the author list of a real paper, which a 50 % surname-overlap check lets through.
- **Failed lookups stay undecided:** 69 fakes came out AMBIGUOUS because keyless Semantic Scholar, OpenAlex or arXiv lookups failed.

Full numbers, method and every failure category are in [eval/RESULTS.md](eval/RESULTS.md).

## Prior art

- **GPTZero Hallucination Check:** a commercial detector for fabricated citations in documents. It checks against GPTZero's source index, with LLM reasoning as a fallback, and reports a 0.2 % false-positive rate and 99.1 % recall from its own testing ([report](https://gptzero.me/news/how-does-gptzeros-hallucination-check-detector-work-a-technical-report/)).
- **CiteAudit:** a benchmark of 9,442 human-validated citations (6,475 real, 2,967 fake) plus a multi-agent verifier ([arXiv 2602.23452](https://arxiv.org/abs/2602.23452), [code](https://github.com/shiiiikw/CiteAudit)). It is the benchmark used here.
- **CheckIfExist:** an open-source (MIT) web app that checks references against Crossref, Semantic Scholar and OpenAlex using string-similarity scoring ([arXiv 2602.15871](https://arxiv.org/abs/2602.15871)).
- **SemanticCite:** full-text citation verification with a four-class scheme (supported, partially supported, unsupported, uncertain), retrieval and fine-tuned small models ([arXiv 2511.16198](https://arxiv.org/abs/2511.16198), [code](https://github.com/sebhaan/semanticcite)).
- **scite Reference Check:** screens a manuscript's references for retractions and editorial notices, and shows how often each was supported or contrasted ([scite](https://medium.com/scite/reference-check-an-easy-way-to-check-the-reliability-of-your-references-b2afcd64abc6)).
- **MDPI Cite Lens:** MDPI's internal screening tool. It uses embedding similarity between a reference and both the citing article and the citing paragraph to flag out-of-scope or manipulative citations ([chapter](https://link.springer.com/chapter/10.1007/978-3-032-06136-2_3)).

What this project adds is not novelty but a small, inspectable implementation of the same ideas:
- a deterministic existence check with the score breakdown stored for each reference,
- failed lookups kept separate from "not found",
- relevance labelled as abstract-level,
- honest numbers on a public benchmark.

## Known limitations

- **Existence only covers what the indexes cover.** Web pages, software, standards, many books and theses, and very new preprints come out `NOT_FOUND` or `AMBIGUOUS`. They are not fakes.
- **Parsing errors propagate.** GROBID sometimes splits names wrongly (e.g. "A Filipa De Almeida"), and that weakens the author check.
- **Rate limits shape the results.** Without keys, Semantic Scholar's shared pool and arXiv search often return 429. Those references become `AMBIGUOUS`, never `NOT_FOUND`, so recall drops when the APIs are busy. A run on a cold cache takes seconds to minutes per citation.
- **Relevance is abstract-level only.** It cannot see whether the specific claim is in the body of the cited paper. It has not been evaluated against labels.
- **Citation linking.** Papers with two reference lists or unusual numbering can mislink markers. Such links are shown as "linked by number" and are never called unrelated.
- **One machine.** Rate limiters assume a single deployment against each API.

## API terms

Researched from primary sources in [docs/apis.md](docs/apis.md), covering rate limits, headers, licences and caching. None of the terms forbids automated citation verification with response caching at this volume. The caveats:
- Don't republish the cache: OpenAlex ToS, Semantic Scholar data licences.
- Don't serve arXiv PDFs to others.
- Abstracts are copyrighted: compare them internally, don't republish them in bulk.

Attribution: data from Semantic Scholar, Crossref, OpenAlex and arXiv. Thank you to arXiv for use of its open access interoperability.

## What I'd do next

- Use API keys (OpenAlex, Semantic Scholar) and `CONTACT_EMAIL`, and swap arXiv search for an OpenAlex arXiv filter. Most `AMBIGUOUS` results on fakes come from rate-limited lookups, not from scoring.
- Keep a canonical `works` table, keyed by DOI or arXiv id and shared across papers. A reference resolved once is then never looked up again, and it is the base for co-citation checks. Postgres is enough; a graph database isn't needed (see DECISIONS.md).
- Evaluate relevance properly: a labelled set of claim–citation pairs, then full text (open-access PDFs) instead of abstracts for the cases the abstract can't settle.
