# DECISIONS

A log of design choices and the reasons for them, including places where the spec left
room and the simplest reasonable option was chosen. Newest sections are appended at the end.

## Architecture: modules and interfaces

All ports live in `src/core/types.ts`. The pipeline (`src/pipeline/`) depends only on them.

| Port | Shape | Why it is a seam |
|---|---|---|
| `Extractor` | `extract(pdf) → { title, references[], contexts[], raw }` | GROBID today; a judgment parser for UK/Indian case law later. Chosen **per input document**, not per domain (see below). |
| `Resolver` | `name`, `applies(ref)`, `resolve(ref) → { candidates[], raw }` | One adapter per external source (Crossref DOI, Crossref bibliographic, OpenAlex, Semantic Scholar, arXiv). Legal adds e.g. National Archives Find Case Law / Indian Kanoon adapters. Resolvers **return candidates only and never decide existence**. |
| `ExistenceScorer` | `score(ref, candidates) → { verdict, match, mismatches, scored[], reason }` | Pure and deterministic, with no I/O and no LLM. Legal scoring compares different fields (neutral citation, court, parties) and plugs in here. |
| `AbstractFetcher` | `fetch(record) → string \| null` | The cited text used for relevance: an abstract for papers, a headnote or summary for judgments. |
| `RelevanceVerifier` | `verify(context, citedText) → { verdict, reason, method, similarity, model }` | Embedding pre-filter plus an LLM judgment. Domain-agnostic. |
| `LLMProvider` | `completeJSON({ system, user, schema }) → unknown` | Anthropic or OpenAI, selected by env. The only place an LLM SDK is imported. |
| `Reporter` | `render(report) → { filename, content }` | JSON and HTML adapters (a real seam: two adapters). |

**`CitationDomain`** bundles `{ kind, resolvers, scorer, abstracts }`. Each extracted
`Reference` carries a `kind` (`"scholarly"` today), and the resolve stage picks the
domain registered for that kind. Adding legal citations means registering a new domain
(plus a judgment `Extractor`) with no edits to the pipeline, queues, store or reporters.

**Why extractors aren't part of a domain:** one document can cite several kinds. A
judgment cites cases, statutes and journal articles, so one extractor may emit
references of several `kind`s, each resolved by its own domain.

**Domain-specific identifiers** that don't fit the common `Reference` fields go in
`Reference.ids` (e.g. `{ neutralCitation: "[2023] UKSC 42" }`) and are stored in
`bib_entries.ids` (jsonb). That avoids a schema change per domain.

**Depth.** The deep modules are `parseTei` (one function hiding GROBID's TEI quirks)
and the scorer (one `score()` call hiding normalization, similarity, the grouping of
candidates into one work, and the thresholds). Resolvers are deliberately thin: they map
a request to a response to `CandidateRecord`s. Rate limiting and caching live behind
them in one HTTP gateway rather than being repeated in each resolver.

## Pipeline and queues

- **One BullMQ queue per stage**: `ingest`, `extract`, `resolve`, `relevance`, `report`.
- Jobs carry IDs only (`paperId`, `bibEntryId`). All state lives in Postgres, so any
  stage can be retried or inspected.
- **No custom BullMQ job IDs.** An early version used `ingest-${paperId}`. After a DB
  reset, paper IDs restart at 1 while Redis still holds the old completed job, and BullMQ
  silently treats the re-add as a no-op, so the run hung at `queued`. Since database IDs
  aren't unique across resets, BullMQ now generates the job IDs.
- `citecheck run` starts the workers in-process, enqueues the ingest job and polls
  `papers.status`. A worker that hits its final failed attempt on a paper-level stage
  marks the paper `failed`.

## Extraction (GROBID)

- **Image `lfoppiano/grobid:0.9.1-crf`**, pinned. It is about 0.5 GB with native arm64
  and amd64 builds. The deep-learning "full" images are 10–15 GB with no stable arm64
  build. The CRF models are GROBID's default for references and citation contexts.
- **`consolidateCitations=0`, `consolidateHeader=0`.** Consolidation replaces the
  metadata the paper actually printed with Crossref's, which would hide exactly the
  errors we're checking for.
- **`segmentSentences=1`** makes GROBID wrap sentences in `<s>`, so "the sentence
  containing the citation" and "the previous sentence" come straight from the TEI.
  The previous sentence is the preceding `<s>` in the same section or footnote (possibly
  in the previous paragraph). It is null at the start of a section.
- Only `listBibl` entries are references. The header `biblStruct` is the paper itself.
- GROBID quirks handled by `parseTei`, each pinned by a test on real TEI:
  - An empty `<title/>` with the title misfiled in `note[type=report_type]`
    (`"Layer normalization. arXiv preprint"`).
  - arXiv IDs given as untyped `CoRR, abs/1409.0473` idnos.
  - Citation markers inside footnotes (`note > p > s`).
  - **Unlinked numeric markers.** The GPT-4 report (2303.08774) has two numbered
    reference lists, the report's and the appended System Card's, which GROBID
    concatenates into one `listBibl`. GROBID leaves every marker whose number appears in
    both lists unlinked: 181 of 202 markers. Fallback: a restart of top-level section
    numbering starts a new segment, and each segment owns the next list. An unlinked,
    purely numeric marker `[n]` maps to entry `n` of its segment's list. Each list's
    offset is learned from GROBID's own linked markers in that segment. If a segment has
    none, the offset is 0 for the first segment, or the previous offset plus the previous
    segment's highest marker number. Every context records `linked_by`
    (`grobid` | `numeric-fallback`), so the report can show which links are inferred.
    On 2303.08774 the contexts went from 16 to 196.
- Known gap: GROBID's header model read 2303.08774's title as an author-list fragment.
  The paper title is display-only and doesn't affect verification.

## Data model

Plain Postgres via Drizzle and drizzle-kit migrations (`drizzle/`). Following the
Postgres best-practices skill:

- `bigint generated always as identity` primary keys, `text` (not varchar),
  `timestamptz`, and enums as `text` plus a `CHECK` constraint. A CHECK is easier to
  change in a migration than `ALTER TYPE`.
- Every foreign key is indexed, and there is `ON DELETE CASCADE` from `papers` down.
- Natural-key uniqueness is enforced: `(paper_id, key)` on bib entries, and one
  existence verdict per bib entry and one relevance verdict per context.
- Raw data kept for debugging: `papers.tei` (the full GROBID TEI) and
  `resolver_calls.raw` (each resolver's raw API response, or its error).
  `resolution_candidates.breakdown` stores the full score breakdown.
- `papers` holds one row per run, so the same paper can be run again and compared.
- Re-running the extract stage replaces the previous extraction in one transaction, so
  retries are idempotent.

## Local environment

- Compose maps Postgres to host port **5433** and Redis to **6380**. Homebrew Postgres
  and Redis are installed on this machine, so the default ports may be taken.
- Redis runs with AOF so the API response cache survives restarts.
- pnpm 12 blocks dependency build scripts by default. Approved: `esbuild` (needed by
  tsx), `onnxruntime-node` (local embeddings), and `msgpackr-extract` (BullMQ speed-up).
  Denied: `protobufjs`, whose postinstall is only a version check.

## Skills and process

- **The TDD skill asks me to confirm test seams with you first.** You asked me not to
  stop, so I chose the seams myself:
  - `parseTei(tei)`: tested against real GROBID TEI for 1706.03762 and 2303.08774.
  - `parseSource(input)`.
  - The scorer's `score(ref, candidates)`, plus title normalization and similarity.
  - The metrics functions in eval.
- The research skill ran as a background agent. Its output is `docs/apis.md`, with a
  primary-source URL for each fact.
- **Test fixtures stay out of git.** The real-paper TEI fixtures contain the full text of
  arXiv 1706.03762 and 2303.08774, and neither paper has an open licence (checked via
  arXiv OAI-PMH: no `<license>` element, so arXiv's default non-exclusive licence
  applies). Once the repo became public on GitHub, committing them would have meant
  redistributing the papers. `pnpm fixtures` regenerates them, pinning each PDF by arXiv
  version and sha256 and running the pinned GROBID image. Its output matches the
  originals byte for byte except for GROBID's run timestamp. Tests name that command when
  a fixture is missing. PDFs are also gitignored: arXiv allows storing them for research
  use but not serving them.
- **Pushing:** the original spec said to commit locally and not push. You later asked me
  to push to https://github.com/SunnyBagal/legal_cite with granular commits, which
  supersedes that rule. Every commit is one self-contained logical change. Still no PRs
  and no gstack-ship.

## M1 review (gstack `review`) outcomes

The run included 6 specialists (testing, maintainability, security, performance, data
migration, simplification), the Claude adversarial pass and a red team.

- **Codex outside review: skipped.** It would send this repo's code to OpenAI, which you
  haven't approved. Declined as an opt-in.
- **Gate-integrity scan: unavailable.** The helper needs a base commit, and this was the
  first commit. Every test file was new, so there was nothing relaxed to inspect.
- **Fixed:**
  - All TEI linking quirks the red team found: figure numbers taken as citations,
    `[77] [78]`, citations pushed to the next sentence, footnote segments, list bounds,
    linked ranges, the empty analytic title (b102), and missing `xml:id`s.
  - Compose bound to loopback.
  - Final-failure detection by job state, error listeners, `UnrecoverableError` for
    permanent errors.
  - The CLI deadline and SIGINT handling.
  - Absolute paths and paths relative to the repo root, atomic PDF writes, the migration
    advisory lock, Redis URL parsing, the single source for statuses, and a light status
    poll.
- **arXiv PDF crawl delay (15 s)** is enforced inside the download function, per process.
  A BullMQ limiter on the ingest queue made local PDFs wait behind it.
- **Deferred, with reasons:**
  - Citations inside figure captions and tables are not scanned. GROBID often mis-tags
    numbers there, and the precision risk outweighs recall.
  - Inserts aren't chunked for more than ~5,900 references (Postgres's 65,535-parameter
    limit). That's far beyond any paper here.
  - Concurrent `citecheck run`s share queues and can process each other's papers.
    Documented as "run one at a time". An interrupted run marks its paper failed, so its
    leftover jobs are skipped.
  - No Postgres or BullMQ integration tests yet. The failure paths (missing file, non-PDF,
    SIGINT, a local PDF from another directory) are covered by recorded CLI probes. The
    end-to-end QA after M4 revisits this.
  - Skipped simplification advice: FlowProducer, the store helpers and the verdict arrays
    are used from M2 to M5. The hand-rolled Redis URL parse is kept and now handles
    `rediss://` and usernames.
