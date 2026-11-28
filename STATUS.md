# Status

Checked on 2026-11-28 by running each piece, not by reading the code. Services came from `docker compose up -d` (Postgres, two Redis instances, GROBID 0.9.1 CRF).

## Works

| Milestone | What I ran | Result |
|---|---|---|
| M1 ingest + extract | `citecheck run 1706.03762 --no-relevance`, `citecheck run test/fixtures/attention.pdf --no-relevance` | PDF fetched or read, GROBID parsed 40 references and their citing sentences |
| M2 existence | the same two runs | 40/40 VERIFIED, about 4 s on a warm cache |
| M3 relevance | `citecheck run 1706.03762` (Anthropic key in `.env`) | 58 citing contexts: 44 SUPPORTS, 10 PARTIAL, 4 CANNOT_TELL; 36 s |
| M4 reports | every run above, plus `citecheck report 46` | `reports/<id>/report.html` and `report.json`; `report` refuses failed or unfinished runs |
| Tests | `pnpm test`, `pnpm test:int`, `pnpm typecheck` | 196 unit tests, 5 integration tests, typecheck clean |
| Failure handling | runs with Redis, Postgres or GROBID pointed at a dead port | fails in about 1 s, names the service and says to run `docker compose up -d` (before this fix, a dead Redis hung forever) |

## Partial

- **M5 eval.** It is rebuilt around the public CiteAudit benchmark (`pnpm eval:citeaudit`), not the synthetic set first planned, and covers existence only. It ran on 400 citations; see `eval/RESULTS.md`. Strict fake-detection precision is 0.895, recall 0.215, FPR 0.025; flagging AMBIGUOUS too gives precision 0.819, recall 0.635, FPR 0.140. No relevance eval was run: CiteAudit has no claim/context labels, and I cut the synthetic swap set to finish.
- **arXiv search.** On 2026-11-28 the arXiv search endpoint answered 429 after 15 to 40 s, even at the documented 1 request every 3 s. The gateway now pauses arXiv for 10 minutes on a 429. References that needed arXiv search then come out AMBIGUOUS ("some lookups failed"), never NOT_FOUND. Lookups by arXiv ID are unaffected.
- **Relevance.** Every verdict is abstract-level and needs human review, by design. It is not evaluated against labels.

## Missing or cut

- The optional Next.js page: cut.
- The CSV importer for known hallucinated references and the synthetic perturbation/swap sets: cut, because CiteAudit replaced them.
- CheckIfExist comparison: skipped. The paper (arXiv 2602.15871) describes a browser-only React app under MIT, and I found no public repository or CLI to run on a batch, so it does not fit the 30-minute setup limit.
- UK/Indian legal citation domains: out of scope. The `CitationDomain` port is where they would plug in.
