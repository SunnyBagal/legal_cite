# Scholarly APIs: limits, headers, terms (researched 2026-11-27)

Scope: Crossref REST API, OpenAlex API, Semantic Scholar Academic Graph API, the arXiv API, and arXiv PDF download etiquette. Everything here comes from the providers' own docs, terms, blogs, forums and swagger specs, read on 2026-11-27. Sources are footnoted. Where a point is **observed** (from live response headers fetched today) rather than documented, it says so.

---

## 1. Crossref REST API

**Base URL:** `https://api.crossref.org/` [^cr-rest]. No sign-up required [^cr-rest].

### Endpoints we use
| Purpose | Request | Notes |
|---|---|---|
| DOI lookup | `GET /works/{doi}` | Returns a singleton. The swagger example URL-encodes the slash: `/works/10.5555%2F12345678` [^cr-swagger]. `HEAD` gives 200 or 404 without a body [^cr-swagger]. |
| Bibliographic query | `GET /works?query.bibliographic=...&rows=N` | "query bibliographic information, useful for citation look up, includes titles, authors, ISSNs and publication years" [^cr-swagger]. Use `select=` to cut down the fields (the list includes `abstract`) [^cr-swagger]. |

### Pools and rate limits (current docs, last updated 2025-10-16)
| Pool | How you get in | DOI lookup (single record) | Queries/filters (lists) |
|---|---|---|---|
| Public | No identification | 5 req/s, concurrency 1 | 1 req/s, concurrency 1 |
| Polite | Email in the `mailto` param "or `agent` header" | 10 req/s, concurrency 3 | 3 req/s, concurrency 3 |
| Plus (paid) | `crossref-api-key: Bearer <key>` header | 150 req/s | 150 req/s |

Source: [^cr-auth]. The split by request type took effect on 21 July 2026 [^cr-forum-2026]. Limits are applied **per email address**. Crossref does not validate emails, but "repeated use of invalid addresses could lead to API access being blocked" [^cr-forum-2026].

- **Discrepancy:** Crossref's 2 Dec 2025 forum post gave polite concurrency as **5** [^cr-forum-2025]. The current docs table says **3** [^cr-auth]. Use 3.
- Limits are reported in the response headers `x-rate-limit-limit`, `x-rate-limit-interval` and `x-concurrency-limit` [^cr-auth], plus `x-rate-limit-type` [^cr-forum-2026]. *Observed today without mailto:* `/works/{doi}` returned `x-rate-limit-limit: 5`, `x-concurrency-limit: 1`, `x-api-pool: public-single`. `/works?query.bibliographic=` returned `1`, `1`, `public-array`.

### Headers and params
- `mailto=<email>` on every request ("strongly recommend[ed]"). Also send a `User-Agent` "that identifies you and your script" [^cr-auth]. `mailto` is a documented query param on `/works` [^cr-swagger].
- No API key is needed. Plus is a paid option [^cr-auth].

### Licence and terms
- "Almost all of the metadata we hold is reusable without restriction, with the exception of abstracts which are subject to publisher or author copyright." Bibliographic metadata counts as "facts, not subject to copyright", and Crossref-generated data is CC0 [^cr-retrieve].
- The docs encourage caching: "Cache responses and be considerate about how often you refresh them" [^cr-auth], and "cache your results. Try to avoid making the same requests repeatedly" [^cr-tips].
- No separate REST API terms of use were found. The documentation pages above are the operative guidance. No attribution requirement is stated.

### Abstracts
- `abstract` is a plain `string` in the swagger schema [^cr-swagger]. Deposited abstracts are JATS XML, and the `jats:` prefix "must be used for the `abstract` and all child elements" [^cr-abstracts]. So expect `<jats:p>`-style markup inside the string and strip it. Abstracts are present only when a member deposited one, and their copyright stays with the publisher or author [^cr-retrieve].

### Errors and backoff
- **429** means rate limited: "Wait a short while, then retry at a lower rate or with fewer simultaneous requests". **403** means blocked, so contact support [^cr-auth]. "If you see a 429 or 403 response ... check the response text for details" [^cr-swagger]. "Back off if response times increase" [^cr-auth].
- **Retry-After:** not documented [^cr-auth].

---

## 2. OpenAlex API

**Base URL:** `https://api.openalex.org` [^oa-overview]. The old docs.openalex.org pages now 301 to help.openalex.org.

### Endpoints we use
| Purpose | Request | Notes |
|---|---|---|
| Get by DOI | `GET /works/doi:10.7717/peerj.4375` or `/works/https://doi.org/10.7717/peerj.4375` | Single-entity lookups are "Free, for every entity type" [^oa-single]. |
| Full search | `GET /works?search=...` | Searches title, abstract, full text and keywords [^oa-search]. |
| Title search | `GET /works?search.title=...` (also `.exact`) | This scoped search parameter is the current form [^oa-search]. |
| Title filter (legacy) | `GET /works?filter=title.search:...` | "`filter=field.search:` syntax is deprecated". It still works and is billed as a search [^oa-search]. |

Useful params: `select=`, `per_page=` (up to 100) [^oa-auth].

### API key, budgets and pricing
- **The key is optional but effectively needed.** "Basic use is free and generous, and a free key gives you 10× the keyless budget" [^oa-auth]. The 2026-02-25 blog says "you'll need an API key for all requests" and that unkeyed calls are for demos, "not suitable for production" [^oa-blog].
- **Getting a key:** sign up at openalex.org/signup, then Settings → API key. A key is inactive until its email is verified (403 `key_not_activated`) [^oa-auth].
- **Sending it:** the `api_key=` query param or the `Authorization: Bearer <key>` header. "Both work identically" [^oa-auth].
- **Daily budget:** $0.10/day without a key and $1/day with a free key. It resets at midnight UTC [^oa-costs] [^oa-pricing].
- **Cost per call:** get single entity free. List+filter $0.10 per 1,000. Search (including `.search` filters) $1 per 1,000 [^oa-costs] [^oa-search].

| Budget | List + filter / day | Search / day | Get by ID/DOI |
|---|---|---|---|
| Keyless ($0.10) | 1,000 | 100 | unlimited |
| Free key ($1) | 10,000 | 1,000 | unlimited |

Source: [^oa-costs].

- **New-account pacing:** accounts created on or after 3 Nov 2026 spend their first $1 at "up to $0.10 every 5 minutes" (429 `first_dollar`) [^oa-auth] [^oa-errors].

### Per-second limits (as of the page updated 2026-11-23)
| | No key (per IP) | Free key |
|---|---|---|
| All requests | 10 req/s | 30 req/s |
| Searches with >5 AND/OR/NOT | 1 req/s | 2 req/s |
| Semantic search | 1 req/s | 1 req/s |

Source: [^oa-auth]. Until 27 June 2026 the limit was 100 req/s for everyone, so older docs that say 100 are out of date [^oa-auth].

- **mailto/polite pool:** the current authentication page does not mention `mailto` or a polite pool [^oa-auth]. Treat the key as the only identification mechanism.
- *Observed today without a key:* `/works/doi:...` returned `x-ratelimit-limit-usd: 0.1`, `x-ratelimit-cost-usd: 0`, `x-ratelimit-remaining-usd: 0.1`.

### Licence and terms
- Data: "all data is CC0" [^oa-overview]. The pricing page says there is "no 'personal use only' carve-out" [^oa-pricing].
- The **Terms of Service (last revised 2 Oct 2026)** [^oa-tos] grant "a non-exclusive, non-transferable, freely revocable, limited license to access and use the free features of the Service, including the Database, Data". They also say: "Any unauthorized use, reproduction, modification, distribution or republication of the Data or Database without Impactstory's prior written consent is strictly prohibited." The ToS do not mention CC0, which creates a tension with the help pages (see Terms check).
- No attribution requirement. Don't use OpenAlex marks to "imply any relationship with OpenAlex" [^oa-tos].

### Abstracts
- `abstract_inverted_index` maps each word to its positions. "OpenAlex does not ship plaintext abstracts for legal reasons; reconstruct the abstract from the index." Coverage is over 60% of 2022 works and about 45% of pre-2000 works. Some abstracts may carry trailing headings or keywords [^oa-work].

### Errors and backoff
- **429** body `reason` values: `requests_per_second`, `broad_boolean_query`, `wide_or_filter`, `semantic_search`, `first_dollar`, `daily_budget`. For per-second limits, "Wait `Retry-After` (usually 1 second) and retry". A per-second 429 "costs nothing". `daily_budget` means wait until midnight UTC [^oa-errors].
- **500** means retry with backoff. **503** means honour `Retry-After` if present, otherwise back off. **403** (plan required) means "Retrying won't help". The docs show exponential backoff (`2 ** attempt`) [^oa-errors].
- Headers: `X-RateLimit-Remaining`, `X-RateLimit-Credits-Used`, `X-RateLimit-Reset`. `GET /rate-limit` is free [^oa-auth].

---

## 3. Semantic Scholar Academic Graph API

**Base URL:** `https://api.semanticscholar.org/graph/v1` [^s2-swagger].

### Endpoints we use
| Purpose | Request | Notes |
|---|---|---|
| Title match | `GET /paper/search/match?query=<title>&fields=...` | Returns "a single paper that is the closest title match" with `matchScore`. **404 "Title match not found"** when nothing matches [^s2-swagger]. |
| By DOI | `GET /paper/DOI:{doi}?fields=...` | [^s2-swagger] |
| By arXiv ID | `GET /paper/ARXIV:{id}?fields=...` | The documented prefix is `ARXIV:` [^s2-swagger]. |
| `fields` | comma-separated, e.g. `title,authors,year,venue,externalIds,abstract` | Without it, "only the `paperId` and `title` will be returned" [^s2-swagger]. "Avoid including more fields than you need" [^s2-tutorial]. |

### Rate limits and key
- **No key:** "rate-limited to 1000 requests per second shared among all unauthenticated users. Requests may also be further throttled during periods of heavy use" [^s2-product]. "Users without API keys are affected by the traffic from all other unauthenticated users" [^s2-tutorial].
- **With a key:** "The introductory rate limit for an API key is 1 RPS on all endpoints" [^s2-product], i.e. "1 request per second rate across all endpoints". Some users get "slightly higher rate following a review" [^s2-tutorial].
- **The key is optional** for these endpoints but "we recommend including your API key with every request" [^s2-product]. Request one via the form on the product page. "You will receive your private API key via email. Do not share your key with anyone" [^s2-product].
- **Header:** `x-api-key` (case-sensitive) [^s2-swagger].

### Licence and terms (API License Agreement, last updated 17 May 2023) [^s2-license]
- The licence lets you "use the API solely in operation with compatible third-party platforms and software ... to access and display ... S2 Data".
- "Licensee's use of S2 Data accessed via the API are separately governed by the licenses that accompany such S2 Data, such as CC BY-NC or ODC-BY". Third Party Content "may be subject to separate license terms".
- **Attribution (mandatory):** "Licensee will include an attribution to 'Semantic Scholar' on its website or in any published materials for contributions from S2 ... For scientific publications prepared by Licensee using the API to produce results, Licensee will cite to The Semantic Scholar Open Data Platform."
- **Prohibited:** "repackage, sell, rent, lease, lend, distribute, or sublicense the API"; "use the API in a way that exceeds reasonable request volume"; "copy, adapt, reformat, ... or otherwise modify the API or S2"; and you "will not attempt to exceed or circumvent" Rate Limits.
- **No clause addresses caching or retention of API responses.**
- Which licence applies to each field (CC BY-NC vs ODC-BY) is stated in the per-dataset READMEs. Reading those needs an API key, so they were **not checked** [^s2-release].

### Abstracts
- `abstract`: "The paper's abstract. Note that due to legal reasons, this may be missing even if we display an abstract on the website" [^s2-swagger].

### Errors and backoff
- **429** means "You've hit the rate limit, slow down your requests" [^s2-tutorial]. Handle 5xx "gracefully, incorporating some exponential backoff retry algorithm" [^s2-faq].
- **Retry-After:** not documented.

---

## 4. arXiv API

**Base URL:** `http://export.arxiv.org/api/query` (GET or POST). Params: `search_query`, `id_list`, `start`, `max_results` [^ax-manual]. The manual's examples use http. *Observed:* https also returns 200.

| Purpose | Request |
|---|---|
| By ID | `?id_list=2106.15928` (or a versioned ID such as `cs/9901002v1`) [^ax-manual] |
| Title/author | `?search_query=ti:"..."+AND+au:surname&max_results=5` (prefixes `ti`, `au`, `abs`, `all`, ...; `AND`/`OR`/`ANDNOT`) [^ax-manual] |

The response is Atom 1.0. Errors come back as an Atom entry [^ax-manual].

### Rate limits
- "When using the legacy APIs (including OAI-PMH, RSS, and the arXiv API), make no more than one request every three seconds, and limit requests to a single connection at a time." These limits "apply to all of the machines under your control as a whole". You must not "Attempt to circumvent rate limits" [^ax-tou]. **This is still current.**
- The manual adds: "incorporate a 3 second delay". On caching: "there is no need to call the API more than once in a day for the same query. Please cache your results" [^ax-manual].
- **No key or registration.** No User-Agent requirement is documented on the ToU, manual, API index or bulk-data pages [^ax-tou] [^ax-manual] [^ax-api-index] [^ax-bulk].

### Terms and acknowledgement
- Metadata (title, abstract, authors, identifiers, ...) is CC0. You may "Retrieve, store, transform, and share descriptive metadata" [^ax-tou].
- Required acknowledgement: "Acknowledge arXiv data usage with this statement on your product: 'Thank you to arXiv for use of its open access interoperability.'" Also: don't brand the project with arXiv names or logos in a way that implies endorsement [^ax-api-index].
- "Commercial projects that utilize arXiv's APIs should review relevant documentation first ... and consider becoming an arXiv affiliate" [^ax-api-index].

### Errors
- 429/Retry-After are not covered in the formal docs. In arXiv's API discussion group, an arXiv reply (Nov 2025) said 429 "Rate exceeded" relates to "server capacity, and the total number of users". It said "you'd see a 503 for excessive use" and "the only fix is try again later" [^ax-group-429]. Users have reported 429s since about Feb 2026 even at 1 req/3 s. arXiv replied "we have made changes recently" and pointed to the ToU [^ax-group-2026].
- After a **403**: "Continued rapid-fire requests from any site after access has been denied ... will be interpreted as an attack" [^ax-robots].

## 5. arXiv PDF download etiquette

- You **may** "Retrieve, store, and use the content of arXiv e-prints for your own personal use, or for research purposes". You **must not** "Store and serve arXiv e-prints (PDFs, source files, or other content) from your servers" without permission or a permitting licence [^ax-tou].
- "Indiscriminate automated downloads from this site are not permitted" [^ax-robots].
- Harvesters should "use the dedicated site export.arxiv.org", at "a reasonable rate ... bursts at 4 requests per second with a 1 second sleep, per burst". "Please do not attempt to download the complete corpus programmatically". Use S3 for that [^ax-bulk].
- **robots.txt (observed today):** `arxiv.org/robots.txt` has `Crawl-delay: 15` and `Allow: /pdf` [^ax-robotstxt]. `export.arxiv.org/robots.txt` has `Disallow: /` for all agents [^ax-export-robotstxt]. This conflicts with the bulk-data page's advice to harvest from export. We are fetching individual IDs, not crawling, but the conservative choice is `https://arxiv.org/pdf/{id}` at ≥15 s spacing.

## 6. DOI handle API (doi.org), added 2026-11-28 in the M2 review

Used for one thing: checking whether a cited DOI is registered with **any** registration agency (Crossref, DataCite, mEDRA, ...). A Crossref 404 alone doesn't mean a DOI is fake, because arXiv (`10.48550/...`) and Zenodo DOIs are DataCite DOIs.

- `GET https://doi.org/api/handles/<doi>` returns JSON `{responseCode, handle, values}`. **responseCode 1 = success (HTTP 200)**, **100 = "Handle Not Found" (HTTP 404)**, 2 = error (HTTP 500), 200 = "Values Not Found" (HTTP 200) [^doi-res].
- `GET https://doi.org/doiRA/<doi>` returns the registration agency, or "DOI does not exist" [^doi-res]. We don't use it: the handle API alone answers "registered?".
- **Rate limits, required headers, terms for automated use:** none documented on these pages [^doi-res]. We run it conservatively at `{max: 2, duration: 1000}`, concurrency 1, and cache the responses (the proxy itself caches handle values with a 24 h TTL [^doi-res]). Site content is CC BY 4.0.
- Nothing on the documentation pages discourages programmatic use. The REST API is described as CORS-compliant with JSONP support [^doi-res].

---

## Implications for our implementation

### Limiter settings (BullMQ `Worker` `limiter: { max, duration }` plus `concurrency`)
| Queue | Condition | `limiter` | `concurrency` | Basis |
|---|---|---|---|---|
| `crossref-doi` (`/works/{doi}`) | with `mailto` | `{ max: 8, duration: 1000 }` | 3 | 10/s, concurrency 3 [^cr-auth] |
| `crossref-doi` | no `mailto` | `{ max: 4, duration: 1000 }` | 1 | 5/s, concurrency 1 [^cr-auth] |
| `crossref-query` (`query.bibliographic`) | with `mailto` | `{ max: 2, duration: 1000 }` | 2 | 3/s, concurrency 3 [^cr-auth] |
| `crossref-query` | no `mailto` | `{ max: 1, duration: 1200 }` | 1 | 1/s, concurrency 1 [^cr-auth] |
| `openalex` | with key | `{ max: 10, duration: 1000 }` | 4 | 30/s limit [^oa-auth], plus daily $ budget |
| `openalex` | no key | `{ max: 5, duration: 1000 }` | 2 | 10/s per IP; only 100 searches/day [^oa-costs] |
| `s2` | with key | `{ max: 1, duration: 1100 }` | 1 | 1 RPS across all endpoints [^s2-product] |
| `s2` | no key | `{ max: 1, duration: 1000 }` | 1 | shared pool, throttled [^s2-product]. Expect 429s |
| `arxiv-api` | always | `{ max: 1, duration: 3000 }` | 1 | 1 req / 3 s, single connection [^ax-tou] |
| `arxiv-pdf` | always | `{ max: 1, duration: 15000 }` | 1 | `Crawl-delay: 15` [^ax-robotstxt] |

Notes:
- BullMQ's limiter is per queue across all workers. Keep **one** queue per API host, and never run two processes with separate limiters against the same API. Crossref limits per email and arXiv limits per operator, regardless of IPs [^cr-forum-2026] [^ax-tou].
- **OpenAlex budget:** a paper with ~200 references done by search would need ~200 searches. That is over the keyless 100/day but well within the free key's 1,000/day [^oa-costs]. Prefer get-by-DOI (free) when a DOI is known. Avoid >5 boolean operators (1–2/s limit) [^oa-auth]. Stop the queue when a 429 carries `reason: daily_budget` [^oa-errors].
- **Retries:** on 429, honour `Retry-After` when present (OpenAlex documents it [^oa-errors]). Otherwise use exponential backoff, e.g. BullMQ `attempts: 5, backoff: { type: 'exponential', delay: 2000 }`, which follows OpenAlex's `2 ** attempt` example [^oa-errors]. Do **not** retry Crossref or arXiv 403s, OpenAlex 403s, or S2 403 (bad key [^s2-faq]). On arXiv 503 or 429, back off and retry later [^ax-group-429].
- **Caching:** cache S2 `/paper/search/match` 404 as a negative result [^s2-swagger]. Leave `api_key` and `mailto` out of Redis cache keys and logs. Prefer the OpenAlex `Authorization: Bearer` header over the query param so the key never appears in URLs [^oa-auth]. Long TTLs are fine. arXiv results change at most daily [^ax-manual].

### Headers and params per request
| API | Send |
|---|---|
| Crossref | `?mailto=$CONTACT_EMAIL`, plus `User-Agent: legal_cite/<version> (mailto:$CONTACT_EMAIL)` [^cr-auth] |
| OpenAlex | `Authorization: Bearer $OPENALEX_API_KEY` (or `?api_key=`) [^oa-auth] |
| Semantic Scholar | `x-api-key: $S2_API_KEY` (omit if unset) [^s2-swagger] |
| arXiv API and PDFs | No documented requirement. Send the same descriptive `User-Agent` as a courtesy. |

### Env vars
| Var | Required? | What the user must do |
|---|---|---|
| `CONTACT_EMAIL` | Strongly recommended. Without it Crossref falls back to public-pool limits | A **real, reachable** email. Crossref may block repeated invalid addresses [^cr-forum-2026]. |
| `OPENALEX_API_KEY` | Effectively required (keyless gives 100 searches/day) | Free signup plus email verification. New accounts are paced to $0.10 per 5 min for the first $1 [^oa-auth]. |
| `S2_API_KEY` | Optional | Request via the form at semanticscholar.org/product/api. Delivered by email, so allow lead time [^s2-product]. |

### Attribution the tool or README must carry
- "Semantic Scholar" attribution in any website or published materials. Cite *The Semantic Scholar Open Data Platform* in any scientific publication using S2 results, e.g. a write-up of the evaluation [^s2-license].
- "Thank you to arXiv for use of its open access interoperability." [^ax-api-index]

---

## Terms check

**Conclusion: none of the five sources' terms forbids automated citation verification with response caching at our volume.** The caveats below are about scope, not prohibitions on this use.

| API | Automated querying | Caching responses | Relevant clauses |
|---|---|---|---|
| Crossref | Allowed; no sign-up | **Encouraged** | "you may use it for any purpose" [^cr-rest]; "Cache responses and be considerate about how often you refresh them" [^cr-auth]; abstracts are "subject to publisher or author copyright" [^cr-retrieve] |
| OpenAlex | Allowed (API is a licensed component of the Service) | Not addressed explicitly; private use is within the licence | Licence "to access and use the free features of the Service, including the Database, Data" [^oa-tos] |
| Semantic Scholar | Allowed within rate limits | Not addressed | "use the API ... to access and display ... S2 Data" [^s2-license] |
| arXiv API | Allowed at 1 req/3 s | **Encouraged** | "Retrieve, store, transform, and share descriptive metadata" [^ax-tou]; "Please cache your results" [^ax-manual] |
| arXiv PDFs | Allowed for personal or research use | Storing for own use allowed; **serving is not** | "Retrieve, store, and use the content of arXiv e-prints for your own personal use, or for research purposes" vs. must not "Store and serve arXiv e-prints ... from your servers" [^ax-tou] |

Caveats, stated precisely:
1. **OpenAlex ToS vs CC0.** The ToS say: "Any unauthorized use, reproduction, modification, distribution or republication of the Data or Database without Impactstory's prior written consent is strictly prohibited". They also bar "Use any manual or technical process to monitor or copy any of the Data for any other unauthorized purpose without our prior written consent" [^oa-tos]. The help pages meanwhile say "all data is CC0" [^oa-overview] [^oa-pricing]. A private Redis cache used to serve our own lookups is within "access and use". **Republishing** the cache, e.g. shipping it as a dataset, is where the ToS wording bites. Don't do that without checking.
2. **Semantic Scholar data licences.** S2 Data is governed by licences "such as CC BY-NC or ODC-BY" [^s2-license]. We could not read which applies to which field: the dataset READMEs need a key [^s2-release]. Non-commercial use is fine either way. **If the tool goes commercial, re-check this first.** The agreement also bars redistributing "the API" (§ Use Restrictions) and requires Semantic Scholar attribution [^s2-license].
3. **arXiv PDFs.** Downloading for verification is fine. Don't expose cached PDFs to other users, e.g. through a hosted service, unless the e-print's licence permits it [^ax-tou]. Commercial projects are asked to review the docs and consider affiliation [^ax-api-index].
4. **Abstracts** from Crossref (publisher or author copyright [^cr-retrieve]), OpenAlex ("legal reasons" [^oa-work]) and S2 ("legal reasons" [^s2-swagger]) are fine to fetch and compare internally. Don't republish them in bulk.
5. **Rate-limit compliance is itself a term** for S2 ("will not attempt to exceed or circumvent" [^s2-license]) and arXiv ("Attempt to circumvent rate limits" is prohibited [^ax-tou]). Use the limiter settings above. Don't spread requests across IPs or machines to get more throughput.

---

## Sources

[^cr-rest]: Crossref, REST API (last updated 2020-04-08). https://www.crossref.org/documentation/retrieve-metadata/rest-api/
[^cr-auth]: Crossref, Access and authentication (last updated 2025-10-16). https://www.crossref.org/documentation/retrieve-metadata/rest-api/access-and-authentication/
[^cr-tips]: Crossref, Tips for using the Crossref REST API (last updated 2025-10-24). https://www.crossref.org/documentation/retrieve-metadata/rest-api/tips-for-using-the-crossref-rest-api/
[^cr-retrieve]: Crossref, Metadata Retrieval, licence table (last updated 2025-10-16). https://www.crossref.org/documentation/retrieve-metadata/
[^cr-swagger]: Crossref REST API swagger spec v4.11.3 (rendered at https://api.crossref.org/swagger-ui/index.html). Raw spec: https://api.crossref.org/swagger-docs
[^cr-abstracts]: Crossref, Markup guide: Abstracts (last updated 2025-03-02). https://www.crossref.org/documentation/schema-library/markup-guide-metadata-segments/abstracts/
[^cr-forum-2025]: Crossref community forum, "Updates to REST API rate limits" (2 Dec 2025, Crossref post). https://community.crossref.org/t/updates-to-rest-api-rate-limits/14872
[^cr-forum-2026]: Crossref community forum, "Refining REST API limits for improved stability and reliability" (21 Jul 2026, Crossref post). https://community.crossref.org/t/refining-rest-api-limits-for-improved-stability-and-reliability/16137
[^oa-overview]: OpenAlex, API overview. https://help.openalex.org/how-to-use-the-api/api-overview
[^oa-auth]: OpenAlex, Authentication / rate limits (last updated 2026-11-23). https://help.openalex.org/how-to-use-the-api/rate-limits-and-authentication (markdown: https://help.openalex.org/api/authentication.md)
[^oa-errors]: OpenAlex, Error Handling. https://help.openalex.org/api/errors/ (markdown: https://help.openalex.org/api/errors.md)
[^oa-search]: OpenAlex, Searching (last updated 2026-11-17). https://help.openalex.org/api/searching/
[^oa-single]: OpenAlex, Get single entities (last updated 2026-11-16). https://help.openalex.org/api/get-single-entities/
[^oa-costs]: OpenAlex, Example costs (last updated 2026-11-15). https://help.openalex.org/access/example-costs/
[^oa-pricing]: OpenAlex, Pricing overview (last updated 2026-11-03). https://help.openalex.org/access/pricing/
[^oa-work]: OpenAlex, Work object, `abstract_inverted_index` (last updated 2026-11-27). https://help.openalex.org/api-entities/works/work-object
[^oa-blog]: OpenAlex blog, "New Features and Usage-Based Pricing" (2026-02-25). https://blog.openalex.org/openalex-api-new-features-and-usage-based-pricing/
[^oa-tos]: OpenAlex Terms of Service (last revised 2026-10-02). https://openalex.org/OpenAlex_termsofservice.pdf (linked from https://openalex.org/terms)
[^s2-product]: Semantic Scholar API product page and FAQ. https://www.semanticscholar.org/product/api
[^s2-tutorial]: Semantic Scholar API tutorial. https://www.semanticscholar.org/product/api/tutorial
[^s2-license]: Semantic Scholar API License Agreement (last updated 2023-05-17). https://www.semanticscholar.org/product/api/license
[^s2-swagger]: Semantic Scholar Graph API spec. https://api.semanticscholar.org/graph/v1/swagger.json (rendered at https://api.semanticscholar.org/api-docs/graph)
[^s2-faq]: allenai/s2-folks FAQ (official S2 repo, archived Jan 2025). https://github.com/allenai/s2-folks/blob/main/FAQ.md
[^s2-release]: S2 Datasets API, latest release README (release 2026-11-24). https://api.semanticscholar.org/datasets/v1/release/latest. Per-dataset READMEs returned 401 without a key.
[^ax-tou]: arXiv, Terms of Use for arXiv APIs. https://info.arxiv.org/help/api/tou.html
[^ax-manual]: arXiv API User's Manual. https://info.arxiv.org/help/api/user-manual.html
[^ax-api-index]: arXiv API Access (acknowledgement statement). https://info.arxiv.org/help/api/index.html
[^ax-bulk]: arXiv, Bulk Data Access. https://info.arxiv.org/help/bulk_data.html
[^ax-robots]: arXiv, Robots Beware. https://info.arxiv.org/help/robots.html
[^ax-robotstxt]: https://arxiv.org/robots.txt (fetched 2026-11-27)
[^ax-export-robotstxt]: https://export.arxiv.org/robots.txt (fetched 2026-11-27)
[^doi-res]: DOI Foundation, "DOI Resolution Documentation" (updated 2020-07-04), sections 1, 4 and 5. https://www.doi.org/the-identifier/resources/factsheets/doi-resolution-documentation
[^ax-group-429]: arXiv API discussion group (groups.google.com/a/arxiv.org), "Rate exceeded?", arXiv reply 17 Nov 2025. https://groups.google.com/a/arxiv.org/g/api/c/pNB3lnxf4mQ
[^ax-group-2026]: arXiv API discussion group, "Request for guidance on arXiv API rate limits / higher-throughput access", Feb–Jun 2026. https://groups.google.com/a/arxiv.org/g/api/c/ycq8giRdZsQ

**Pages that could not be fully read:** the Crossref swagger UI is JS-rendered, so the raw spec was used instead. openalex.org/terms is JS-rendered, so its linked PDF was read instead. The S2 per-dataset licence READMEs need a key (401). help.openalex.org/pricing returns 404; /access/pricing/ was used instead.
