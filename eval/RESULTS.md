# Evaluation results

Run on 2026-11-28. To reproduce: `docker compose up -d && pnpm eval:citeaudit && pnpm eval:citeaudit`. The first run is pass 1, the second pass 2. External API state such as rate limits and daily budgets will move the numbers somewhat. Every number below comes from `eval/results/citeaudit-summary.pass{1,2}.json`. Scores are rounded down and error rates rounded up, so no rounding favours this tool.

## What was measured

- **Benchmark.** [CiteAudit](https://github.com/shiiiikw/CiteAudit) at commit `99744f0`, `data/benchmark.json` (sha256 `0bf0a7b2…`): 9,442 citation strings, each labelled real or fake.
  - It contains 14 exact duplicates, which I removed, leaving 9,428.
  - **The dataset has no license**, so it is not in this repo. The eval downloads it from the pinned commit and checks it.
- **Sample.** 100 citations from each of four cells (real-world real, real-world fake, generated real, generated fake), drawn with seed 42: **400 citations**.
  - Recall and false-positive rate don't depend on that 50/50 balance. Precision does, so it is also shown re-weighted to the dataset's own share of fakes: 31.4 % overall, 13.9 % for real-world, 41.0 % for generated.
- **Pipeline.** Each raw string is parsed by GROBID `processCitationList`, then resolved by the production resolvers and the deterministic scorer, exactly as `citecheck run` would. Only the relevance stage is skipped.
- **"Flagged as fake".** Strict: a verdict of `NOT_FOUND` or `MISMATCH` (no string failed to parse). Second policy: `AMBIGUOUS` as well.
- **Conditions.**
  - No API keys and no `CONTACT_EMAIL`, so Crossref's public pool, keyless OpenAlex and keyless Semantic Scholar.
  - Pass 1 ran on a cold cache. Partway through it, OpenAlex's keyless budget of 100 searches a day ran out and the API stayed paused until UTC midnight. Semantic Scholar's shared keyless pool and arXiv search often returned 429.
  - Pass 2 re-ran the same 400 citations with the cache from pass 1. It retried only the lookups that had failed, which is what the pipeline's own job retry does. **Pass 2 is the headline**; pass 1 is shown for honesty.
- **Not measured.** The relevance stage: CiteAudit labels existence only.

## Headline (pass 2, 400 citations)

| Policy | Group | n | Fake precision | Fake recall | Fake F1 | FPR on real | Precision at dataset prevalence |
|---|---|---|---|---|---|---|---|
| Strict (`NOT_FOUND`, `MISMATCH`) | all | 400 | 0.895 | **0.215** | 0.346 | **0.025** | 0.797 |
| | real-world | 200 | 0.928 | 0.130 | 0.228 | 0.010 | 0.678 |
| | generated | 200 | 0.882 | 0.300 | 0.447 | 0.040 | 0.839 |
| + `AMBIGUOUS` | all | 400 | 0.819 | **0.635** | 0.715 | **0.140** | 0.675 |
| | real-world | 200 | 0.810 | 0.810 | 0.810 | 0.190 | 0.409 |
| | generated | 200 | 0.836 | 0.460 | 0.593 | 0.090 | 0.780 |

F1 for the real class: 0.706 strict, 0.773 with `AMBIGUOUS`.

Verdicts per cell (pass 2):

| Cell | VERIFIED | MISMATCH | NOT_FOUND | AMBIGUOUS |
|---|---|---|---|---|
| real-world, real (100) | 81 | 1 | 0 | 18 |
| real-world, fake (100) | 19 | 11 | 2 | 68 |
| generated, real (100) | 91 | 0 | 4 | 5 |
| generated, fake (100) | 54 | 2 | 28 | 16 |

**In plain words:**
- When the tool says a citation is fake, it is usually right: about 9 times in 10 on this sample, and about 8 in 10 at the dataset's real share of fakes.
- It misses most fakes. **73 of 200 fakes were VERIFIED**, mostly fakes that edit the author list.
- Another 69 fakes came out AMBIGUOUS only because a lookup failed.
- Read as "flag anything uncertain", recall rises to 0.635, at the cost of flagging 14 % of real citations.

**Lookups that all succeeded (pass 2, 177 of 400 citations).** Strict policy: fake precision 0.888, recall 0.299, F1 0.447, FPR 0.058. This subset is not random: references verified early need fewer lookups, so they are less likely to hit a failure. Treat it as an indication only.

**Pass 1 (cold cache, single attempt).**
- Strict: fake precision 0.950, recall 0.095, F1 0.172, FPR 0.005.
- With `AMBIGUOUS`: precision 0.804, recall 0.660, F1 0.725, FPR 0.160.
- 319 of 400 citations had a failed lookup in pass 1, against 223 in pass 2.

**Context, not a like-for-like comparison.** CiteAudit's paper reports, on its own full test sets at natural prevalence, these baselines:
- Generated set (paper Table 3): their model F1 0.959, GPTZero F1 0.734.
- Real-world set (paper Table 4): their model F1 0.838, GPTZero F1 0.313. I read Table 4 only through a summary and did not check these two numbers against the table.

On the generated cell, this tool's strict F1 (0.447) is clearly below both baselines. The sampling and the definition of "fake" also differ; see failure category 2.

## Cost

| | Pass 1 (cold) | Pass 2 (warm, retries) |
|---|---|---|
| Wall time, 400 citations at concurrency 8 | 1,835 s (**4.59 s per citation**) | 1,461 s (3.65 s per citation) |
| Latency per citation, p50 / p90 | 43.8 s / 47.7 s | 42.5 s / 46.3 s |
| Lookups attempted per citation | 3.01 | 2.83 |
| … answered by the API | **1.81** | 0.28 |
| … failed after the gateway's 5 retries | 1.10 | 0.73 |
| … served from cache | 0.10 | 1.83 |
| API calls answered, by API | Crossref query 358, arXiv 149, OpenAlex 140, S2 67, Crossref DOI 5, DOI registry 5 | S2 62, arXiv 48 |

Latency is dominated by queueing, not by work. All citations share one rate-limited queue per API, Semantic Scholar's at about 1 request per second, and failed calls wait through exponential backoff (2 + 4 + 8 + 16 s). A single `citecheck run` on an ordinary paper verifies most references in seconds, because DOI and Crossref lookups usually settle them in tier 1 or 2.

## Failure categories

Counts are from pass 2. Examples are quoted from the benchmark, trimmed.

### 1. Rate-limit and budget misses: 92 citations AMBIGUOUS (69 fakes, 23 real)
A lookup failed: a Semantic Scholar 429, OpenAlex's daily budget, or an arXiv 429. With nothing found and a source unchecked, the scorer says AMBIGUOUS, never NOT_FOUND. That is by design, but it is the largest single loss of recall.
- *fake:* "Hithem Lamri and Michail Maniatakos. Partially Centralized Verified Unlearning. 2025." → AMBIGUOUS, "some lookups failed (semantic-scholar)".
- *fake:* "Nils Margenberg and Carolin Mehlmann. A Hybrid Neural Network-Elastic Element Method for the Viscous-Rigid Ocean-Current Model. 2025." → AMBIGUOUS, same reason.
- *real:* "Nearchos Potamitis, Lars Klein, and Akhil Arora. ReasonBENCH: Benchmarking the (In)Stability of LLM Reasoning. 2025." → AMBIGUOUS, "semantic-scholar, arxiv-search" failed. This one is a false positive under the AMBIGUOUS policy.

### 2. Author-list perturbations accepted: 73 fakes VERIFIED (54 generated, 19 real-world)
CiteAudit counts a real title with a changed author list as fake: authors added, removed, renamed, or given and family names swapped. This tool's author check needs only 50 % surname overlap, and GROBID's name splitting makes it lenient on purpose. So the title matches, the overlap passes, and the reference is VERIFIED. The tool was built to catch works that don't exist, not edited author lists. That is a definitional gap, and it is the main reason recall on generated fakes is low.
- "Arun James Thirunavukarasu, Darren Shu Jeng Ting, Kavya Elangovan, Laura Gutierrez, Tze-Fang Tan, and Zsolt Hodi. Large language models in medicine. Nature Medicine, 2023." → VERIFIED (Crossref 10.1038/s41591-023-02448-8). An invented co-author.
- "Aygün Ozan, Ezgi Ozyilkan, Elza Erkipp, and John Doe. Neural Compress-and-Forward for the Primitive Diamond Relay Channel. 2025." → VERIFIED. "John Doe" added and a name misspelled.
- "Besse Marc and Raphaël Votuiriez. Emergent memory in cell-like active systems. 2025." → VERIFIED (pass 1). Given and family name swapped.

### 3. Parsing and formatting variants
GROBID's parse of a bare citation string is the first point of failure. Strings that list authors as "Family Given", long author lists, and LaTeX in titles all go wrong.
- *real → NOT_FOUND:* "Matthias Bartolo, Dylan Seychell, … Saviour Formosa, and Konstantinos Makantasis. Enhancing Object Detection with Privileged Information…". The parsed title began "Saviour Formosa, and Konstantinos Makantasis. Enhancing…", because authors leaked into the title.
- *real → NOT_FOUND:* "Manh Hung Nguyen and Adish Singla. Divergent-Convergent Thinking in Large Language Models for Creative Problem Generation. 2025." The authors were parsed as "Hung Manh", "Adish Nguyen", "Singla", and the title lookup also failed.
- *real → NOT_FOUND:* "Han Zhu, … AM$^3$Safety: Towards Data Efficient Alignment of Multi-modal Multi-turn Safety…". The LaTeX in the title (`$^3$`) defeats title matching.

### 4. Preprint vs published, and online vs issue year
- *real → MISMATCH (a false positive):* "Jeff Johnson, Matthijs Douze, and Hervé Jégou. Billion-scale similarity search with gpus. IEEE Transactions on Big Data, 7(3):535-547, 2019." Crossref dates the issue 2021, two sources agreed on that, and no online-first year was available to accept 2019.
- *fake → VERIFIED:* "Jie Zhou et al. Uni-mol: A universal 3d molecular representation learning framework. Nature Machine Intelligence, 5(5):440-450, 2023." It matched the ChemRxiv preprint (10.26434/chemrxiv-2022-jjm0j-v4) by title. The cited first author and venue don't fit that record, but a single "et al." author and a venue disagreement are not enough for MISMATCH under the two-source rule.

### 5. Works too new for the indexes
- *real → NOT_FOUND:* "Dennis Holzmann and Sven Wachsmuth. TRec: Egocentric Action Recognition using 2D Point Tracks. 2026." Some 2025–2026 preprints in the generated set aren't yet in Crossref or OpenAlex. This is one of the four false positives in the generated cell; the other three are parsing failures (category 3).

### 6. Books and classic works
- *labelled fake → VERIFIED:* "George Polya. How to solve it: A new aspect of mathematical method. Princeton university press, 1945." It matched a JSTOR record (10.2307/2306109) of the right title and year, which may be a review of the book rather than the book itself.
- *labelled fake → VERIFIED:* "Immanuel Kant. Critique of Pure Reason. Cambridge University Press, 1998." Title, author and year match an OpenAlex record. I couldn't tell which field CiteAudit perturbed, possibly the publisher or the edition, which this tool doesn't check.
- Theses: none in the sample, so untested.

### 7. Non-English titles
None in the 400-citation sample; CiteAudit's strings are English. Untested.

### 8. Venue and year-only fakes
By design, a venue disagreement alone gives AMBIGUOUS, and a year off by one is accepted. Fakes made only by "venue replacement" or "year shifting by 1" therefore can't be MISMATCH. Category 4's Uni-Mol case is one such fake.

## What would move the numbers

- **API keys and `CONTACT_EMAIL`.** These target category 1 directly: up to 69 more fakes reach a decided verdict. Some would become NOT_FOUND. All 23 real citations in that category would need to resolve to VERIFIED for the false-positive rate to drop.
- **A stricter author check.** Flagging any invented co-author when the record's author list is complete would target category 2. It also raises false positives on real citations whose names GROBID mis-parses (category 3), so it needs the parsing fixed first.
- **Light cleaning before lookup.** Stripping LaTeX and preferring arXiv ids when present would help category 3.

## Synthetic set, CheckIfExist

The original plan had a synthetic perturbation set and a relevance swap set. Once a public, human-validated benchmark was available, I cut both. CheckIfExist was not run: its paper describes a browser-only app and I found no repository or CLI to run on a batch. See `STATUS.md`.
