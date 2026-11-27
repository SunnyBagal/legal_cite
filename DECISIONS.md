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

## Existence resolution (M2)

**An LLM never decides existence.** Verdicts come from lookups plus the deterministic
scorer in `src/domains/scholarly/scoring.ts`, whose thresholds are named in `THRESHOLDS`.

- **Gateway.** Every API call goes through `ApiGateway`
  (`src/infra/http/gateway.ts`):
  - **Cache:** Redis, 30-day TTL, keyed by sha256(api + URL). 404s are cached as
    negative results.
  - **Rate limits:** one BullMQ queue per API, with `{max, duration, concurrency}` taken
    from docs/apis.md. Crossref's single-record and list pools get separate queues.
  - **In-flight dedupe:** a job ID equal to the request hash means identical concurrent
    requests share one HTTP call. Unlike paper IDs, request hashes survive DB resets.
  - **Credentials:** `mailto` and API keys are added at fetch time, so they never appear
    in cache keys, in `resolver_calls.raw` or in logs.
  - **Errors:** 429 and 5xx retry 5 times with exponential backoff. Other 4xx, and
    OpenAlex's `daily_budget` 429, fail permanently.
- **Tiers.** `Resolver.tier` lets the pipeline run lookups cheapest first and stop as soon
  as the scorer says VERIFIED:
  1. Crossref DOI and arXiv `id_list`.
  2. Crossref `query.bibliographic` and S2 `search/match`.
  3. OpenAlex `search.title` (charged against the keyless budget of 100 searches/day) and
     arXiv `ti:` search (one request every 3 s).

  On 1706.03762, 22 of 40 references were settled in tier 1 and only 1 reached tier 3.
  Search text is the normalized title, because punctuation broke OpenAlex's filter
  syntax.
- **Degraded lookups.** If every applicable lookup errored, the verdict is AMBIGUOUS
  with `degraded = true`, never NOT_FOUND. An outage must not look like a fabricated
  citation.
- **Same work.** A candidate counts as the same work when any of these holds:
  - Title similarity is at least 0.90 (the better of edit similarity and sorted-token
    edit similarity, after normalization).
  - Title similarity is at least 0.60 and the DOI or arXiv ID matches.
  - The record's title is the cited title plus a subtitle (4+ words) and the authors
    agree. On 1706.03762, a word-count rule alone broke b26 or let 2303.08774 b176
    through.
- **Field checks** (`authors` ≥ 50% surname overlap, `year` ±1, `venue`). A field
  fails only if no record of the same work agrees, and unknown values never fail. `doi`
  and `arxivId` follow the identifier rule below, revised in the M2 review.
  - **Different sources record different years:** Crossref publishes print, online and
    issued years, and all are accepted. arXiv's latest-revision year is accepted too,
    since citing vN is legitimate.
  - **Venues** compare through canonical acronyms (NeurIPS = NIPS = "Neural Information
    Processing Systems") or content-token overlap. Preprint servers count as unknown.
  - **Surname matching** checks every name token of the record's authors, which absorbs
    GROBID's name splitting ("Jimmy Lei Ba" becomes surname "Lei Ba").
- **A MISMATCH needs two independent sources.** On 2303.08774, five of six first-run
  MISMATCHes were single-record artefacts: an S2 record dated 2026, a book review sharing
  the book's title, and online-first versus print years. With one source the verdict is
  AMBIGUOUS, and the disputed field is still listed.
- **Book reviews.** When a record is titled "<cited title> by <cited author>", the
  other same-title records are probably reviews, so the verdict is AMBIGUOUS, not
  MISMATCH(authors).
- **Generic short titles** (3 words or fewer) with no author agreement are AMBIGUOUS.
- **Web pages.** A NOT_FOUND whose citation is just a URL (no DOI or arXiv ID) says the
  scholarly indexes don't cover web pages. On 2303.08774 that's 30 of 48 NOT_FOUND:
  OpenAI blog posts, SAT and AP score pages, NATO pages.
- **Contact email.** `CONTACT_EMAIL` is empty by default. I didn't put your address
  into requests to external APIs without your approval, so Crossref runs on its public
  pool (5 and 1 requests/s). Set the email in `.env` to get the polite pool.

## M2 review (gstack `review`) outcomes

The run included 5 specialists (testing, maintainability, security, performance,
simplification), the Claude adversarial pass and a red team. Codex was skipped for the
same reason as in M1. The fixes are separate commits after the M2 feature commits.

- **Identifier mismatches need direct evidence.** The old rule flagged `doi` when any
  record of the work carried a different DOI. That accuses correct citations in two
  common cases: works with several DOIs, and DataCite DOIs (arXiv `10.48550`, Zenodo),
  which Crossref answers with 404. `doi` (or `arxivId`) now fails only in one of these
  cases:
  - doi.org's handle API says the DOI isn't registered with any agency. This adds a new
    API, cited in docs/apis.md §6, which documents no rate limits, so we limit it to
    2 requests/s.
  - arXiv says the ID doesn't exist.
  - Looking up the cited identifier returns a different work.

  A failed lookup is no evidence either way. Identifier mismatches don't need the
  two-source rule, because they rest on authoritative lookups.
- **Venue-only disagreement gives AMBIGUOUS, never MISMATCH.** Citation styles
  abbreviate venues in too many ways ("Phys. Rev. Lett.", ISO4, IEEE). The matcher now
  handles abbreviations (an abbreviation's letters form a subsequence of the full word,
  in order) and acronyms built before stopwords are removed (ICRA, KDD). A remaining
  disagreement is still listed in `mismatches`.
- **Outages never produce NOT_FOUND.** If any lookup failed and nothing matched, the
  verdict is AMBIGUOUS, the reason names the failed resolvers, and `degraded` is set. The
  resolve job first retries while attempts remain; successful calls are cached, so a
  retry costs almost nothing.
- **Journal-style references without an article title** (Nature, PRL) keep the journal
  as venue. The record found by the cited DOI counts as the same work when authors and
  year agree, or when the cited "title" is its venue.
- **Crossref `query.bibliographic` gets the raw reference string.** That is what the
  query is designed for, and it covers references whose title GROBID lost.
- **Any-script titles.** Normalization keeps `\p{L}\p{N}`, so CJK, Cyrillic and Greek
  letters such as β survive. **Group authors** ("ATLAS Collaboration") are skipped in the
  author check.
- **Gateway:**
  - The `waitUntilFinished` race falls back to the cache.
  - Malformed 200 responses are never cached, and empty arXiv feeds get a 1-day TTL.
  - A 403, or OpenAlex's daily budget, pauses that API (the arXiv terms treat continued
    requests after a 403 as an attack).
  - Bodies are stored once, in the cache.
  - **The cache moved to its own Redis** (`redis-cache`, port 6381, `allkeys-lru`,
    512 MB). BullMQ needs `noeviction`, and one shared instance can't have both policies.
    The 655 existing cache entries were moved over with their TTLs intact.
- **Performance:**
  - Resolve concurrency went from 8 to 64; the per-API queues still enforce the rate
    limits.
  - arXiv IDs are batched: one `id_list` request per 50 IDs, primed per ID through the
    `CitationDomain.prefetch` hook.
  - On 1706.03762 the run went from 72 s to 27 s. 2303.08774 took 2m58s with every
    Crossref query re-fetched, against 9m52s cold before.
- **Pipeline:**
  - The report job ID is scoped to the paper row (paper ID plus creation time). A
    retried extract skips the work when the flow already exists.
  - `resolving` is set before the flow is created, and `reported`/`failed` are terminal.
  - NUL bytes are stripped before saving.
  - An interrupted run force-closes its workers.
- **ReDoS:** `stripPublisher` now does linear string work and runs only on book titles.
- **Tests:**
  - The gateway's classification and credential handling are tested with an injected
    `fetch`.
  - Postgres integration tests run separately as `pnpm test:int`, so unit tests need no
    services.
  - Two scorer tests that encoded the old unsafe DOI rule were updated to the
    evidence-based rule, deliberately and in the same commit as the rule change.
- **Deferred, with reasons:**
  - **Fields are checked independently across records**, which could let a chimera
    citation pass (authors from one record, year from another). It's rare, and checking
    per record would reintroduce the cross-source year false positives.
  - **Same-title different works** with titles of 4–6 words can still give
    MISMATCH(authors) when two sources hold the other work. That's indistinguishable
    from swapped authors without more signal; the eval measures it.
  - **Concurrent runs** still share queues. Documented as "run one at a time".
- gstack telemetry prompt (M2 review): declined, telemetry set to off.

## Relevance (M3)

**Every relevance verdict is labelled "abstract-level, needs human review"** in the CLI
output, and the label will appear in the reports too. The model sees only the cited work's
title and abstract, never the full text.

- **Scope.** Relevance runs only for VERIFIED or MISMATCH references, and only when the run
  has it on (`papers.options.relevance`). `--no-relevance` makes the tool work with no LLM
  key. Asking for relevance with no key fails at startup and names both fixes.
- **Flow.** `report ← relevance(ref) ← resolve(ref)`, which is still one BullMQ queue per
  stage. Verdicts are upserted per citing context, so retries are idempotent.
- **Pre-filter (revised in the M3 review).** Local `all-MiniLM-L6-v2` embeddings
  (transformers.js on CPU, pinned to hub commit `751bff3`) compute the cosine similarity
  between the citing sentence and the cited title plus abstract. The similarity is stored
  with every verdict. **By default it never decides a verdict on its own.** On real papers,
  every embedding-only UNRELATED it produced was wrong: 4 out of 4.
  - 1706.03762's "label smoothing [36]" cites Inception-v3 (similarity 0.099).
  - "For more background, see [94]." has no content to compare.
  - A mislinked marker.
  - A performance comparison with GROBID junk in the sentence (-0.006).

  `PREFILTER_THRESHOLD=<x>` opts back in. Even then it only answers for GROBID-linked
  sentences with 12 or more content words, excluding numeric and author-year markers. The
  M5 eval measures pre-filter precision offline from the recorded similarities before
  anyone should turn it on.
- **LLM call.** One call per (context, cited title + abstract) pair, with strict JSON
  `{verdict: SUPPORTS|PARTIAL|UNRELATED|CANNOT_TELL, reason}` via native structured outputs.
  The system prompt tells the model to prefer PARTIAL or CANNOT_TELL over UNRELATED when the
  topic matches, because the full paper may say more than its abstract.
  - **Anthropic** (the default when its key is set): `claude-opus-5-5`, per the Claude API
    skill's default, overridable with `ANTHROPIC_MODEL`.
    - Uses `beta.messages.parse` with `betaZodOutputFormat`.
    - `effort: "low"` suits a one-sentence classification. Opus 5.5 can't disable thinking,
      so `max_tokens` is 4096 to leave room for it.
    - `cache_control` is set on the shared system prompt. It only takes effect once the
      prompt reaches the model's minimum cacheable prefix, which this short prompt may not.
    - **Server-side refusal fallback is on** (`fallbacks: "default"`, beta
      `server-side-fallback-2026-07-01`). A refusal from the whole chain becomes CANNOT_TELL.
  - **OpenAI** (`--llm openai`): `gpt-5.5`, chosen from this account's live model list and
    overridable with `OPENAI_MODEL`. It uses the Responses API `parse` with `zodTextFormat`
    and `reasoning.effort: low`.
  - Smoke test on the LSTM pair and a deliberately unrelated pair: both providers answered
    SUPPORTS and UNRELATED correctly, in 2.4–5 s per call.
- **Abstracts** come from the matched record. If it has none, the stage tries the other
  same-title records of the work (arXiv and S2 records usually have one), going through the
  domain's AbstractFetcher. On 1706.03762 this cut CANNOT_TELL ("no abstract") from 5 to 2.
- **Keys.** Your keys were in `.env.example`, which git tracks and the repo is public. They
  were never committed. I moved them to `.env` (gitignored, mode 600) and restored the
  template.
- **Results so far, Claude (relevance labels are abstract-level, needs human review):**

  | Paper | Contexts | SUPPORTS | PARTIAL | CANNOT_TELL | UNRELATED | Time |
  |---|---|---|---|---|---|---|
  | 1706.03762 | 58 | 42 | 14 | 2 | 0 | 22 s |
  | 2303.08774 | 145 | 79 | 50 | 14 | 2 | 58 s |

  - **1706.03762 on OpenAI:** 41 SUPPORTS, 15 PARTIAL, 2 CANNOT_TELL.
  - **2303.08774's two UNRELATED** are the remaining *linking* error: "[84,85]" sits in
    appendix "H System Card", which GROBID emits after the system card starts. The relevance
    stage rightly flags that the linked work doesn't fit.
- **Relevance found linking errors upstream.** On 2303.08774, the first relevance run's
  UNRELATED verdicts were all wrong *links*, not wrong citations:
  - The system card's Abstract came before its numbering restart, so it linked to the
    report's list.
  - GROBID linked ambiguous numbers into the other document's list.

  Both are fixed in `parseTei`, with regression tests.

## M3 review (gstack `review`) outcomes

The run included 5 specialists, the adversarial pass and a red team. Codex was skipped as
before. Fixes landed as separate commits after the M3 feature commits.

- **Never accuse on uncertain evidence.**
  - An LLM UNRELATED on an inferred (`numeric-fallback`) link becomes CANNOT_TELL, with the
    reason "the link itself may be wrong". On 2303.08774, "[84,85]" sits in appendix "H
    System Card", which GROBID emits after the system card starts, and the old output blamed
    the author for that parser error.
  - The embedding pre-filter is opt-in (see above).
- **Claude responses are parsed safely.** `messages.parse()` parses every text block. It
  throws on a refusal's prose and on the declining model's partial text before a fallback
  hop, so refusals and successful fallbacks became job errors. The provider now calls
  `beta.messages.create` and:
  1. checks `stop_reason` (`refusal` becomes LLMRefusalError, `max_tokens` becomes
     LLMIncompleteError);
  2. reads only the text after the last `fallback` block;
  3. validates it with zod.

  These paths are pinned by tests with recorded response shapes.
- **Prompt injection.** The citing passage comes from the paper under review and the
  abstract from third-party APIs. Both are fenced in `<citing_passage>`/`<cited_work>`, with
  any such tags inside them stripped, and the system prompt declares them data. The output
  schema limits an injection to choosing a label. The reason is capped at 500 characters with
  control characters stripped, and M4 must HTML-escape everything it renders.
- **Spend is capped.**
  - A retried job skips contexts that already have a verdict.
  - The per-paper LLM call budget is `MAX_LLM_CALLS_PER_PAPER`, default 600.
  - Both SDK clients get a 60 s timeout and 2 retries.
  - The OpenAI `reasoning` parameter goes only to reasoning-model families.
- **Coverage is visible.**
  - Failures after the last attempt become CANNOT_TELL rows ("the relevance check
    failed: …", "the abstract could not be fetched").
  - Non-fatal job failures are logged.
  - The CLI summary counts **per citing context**, left-joined, and breaks it into eligible,
    pre-filter, not judged by the model, and missing.
- **Abstracts.** An abstract already stored on any record of the same work is used first.
  Borrowing an abstract needs the title **and** the authors, year or an identifier to agree
  (`CitationDomain.sameWork`), because a title alone can be a different work. On 1706.03762
  this raised "no abstract" from 2 to 4, which is the intended trade.
- **The label lives in the data.** `relevance_verdicts.scope` defaults to "abstract-level,
  needs human review". `abstract_source` and `verifier_version` (`relevance-v2`) are stored
  with each verdict.
- **Per-run provider.** `papers.options.llm` records the provider. Leftover jobs from a run
  with another provider are refused instead of being judged by the wrong model.
- **Embedder.** A failed load is retried instead of cached, each text is embedded once, and
  the model warms up at startup so its first load overlaps ingest and resolve.
- **Segment guard regression (red-team repro).** An appendix numbered from 1 that shares the
  paper's single bibliography produced offsets `[0, 0]`. That emptied segment 0's window and
  dropped every main-body context. The guard and per-segment windows now apply only when
  offsets strictly increase, meaning genuinely distinct lists. Bare markers are mapped by
  number only when the guard rejected their target.
- **Results after the fixes (Claude; relevance labels are abstract-level, needs human
  review):**

  | Paper | Contexts | SUPPORTS | PARTIAL | CANNOT_TELL | UNRELATED | Missing |
  |---|---|---|---|---|---|---|
  | 1706.03762 | 58 | 44 | 10 | 4 | 0 | 0 |
  | 2303.08774 | 145 | 76 | 54 | 14 | 1 | 0 |

  2303.08774's one UNRELATED was the embedding pre-filter. It no longer decides by default,
  and this was confirmed by unit test, not by a fresh paid rerun.
- **Deferred:**
  - **Relevance on MISMATCH references stays on.** Those are mostly year disagreements on the
    right work, and the "inferred link" rule already covers the risky case.
  - **No startup probe of the model or its parameters.** A misconfigured model now shows up
    as logged failures and as not-judged counts in the summary rather than as a clean result.
