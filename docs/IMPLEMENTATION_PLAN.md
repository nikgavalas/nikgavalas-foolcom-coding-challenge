# Implementation plan (working doc)

> **Scaffolding, not a deliverable.** This is the build checklist for the caching work, one step
> per PR. Each step carries a prompt that can be pasted into Claude Code as-is. Delete or trim this
> file before submitting; the durable docs are `ARCHITECTURE.md`, `DESIGN_OPTIONS.md` and
> `PRODUCTION.md`.

## Why these steps are ordered this way

Steps 2–6 build pure modules with **no app wiring**. Each is independently unit-testable and
reviewable in isolation, and nothing touches the article page until step 7. That keeps every PR
small, and it means the cache policy is proven correct before it is load-bearing.

Step 1 comes first so there is a failing acceptance test to build against.

## Status

| # | Step | Ships | Status |
|---|---|---|---|
| 0 | Docs scaffold | `docs/` | ☑ |
| 1 | Test harness | `playwright.config.ts`, `vitest.config.ts`, `tests/` | ☑ |
| 2 | Cache store | `lib/cache/store.ts` | ☑ |
| 3 | Article validator | `lib/cms/validateArticle.ts` | ☑ |
| 4 | Upstream client | `lib/cms/cmsClient.ts` | ☑ |
| 5 | Cache policy engine | `lib/cache/articleCache.ts` | ☑ |
| 6 | Circuit breaker | `lib/cache/circuitBreaker.ts` | ☑ |
| 7 | Wire into the app | `services/articleService.ts`, `app/articles/` | ☑ |
| 8 | Prewarm + refresher | `instrumentation.ts` | ☑ |
| 8a | CDN response headers | `proxy.ts` | ☑ |
| 9 | Push invalidation | `app/api/internal/revalidate/` | ☑ |
| 10 | Observability | `lib/observability/` | ☑ |
| 11 | Correction e2e | `tests/e2e/` | ☑ |
| 12 | Final docs | `docs/` | ☐ |

## Parallelization

Dependencies between steps, for running concurrent sessions in git worktrees:

```
0 ──▶ 1 ──┬──▶ 2   ─────────────┐
          ├──▶ 3 ──▶ 4 ─────────┼──▶ 5 ──▶ 7 ──┬──▶ 8  ──┐
          ├──▶ 6a  ─────────────┘  (+6b)       ├──▶ 8a ──┼──▶ 10b ──▶ 11 ──▶ 12
          └──▶ 10a ─────────────────────────────└──▶ 9  ──┘
```

| Wave | Steps | Width | Notes |
|---|---|---|---|
| 1 | **1** | 1 | Must land alone — every later step needs the runners and the deps |
| 2 | **2, 3, 6a, 10a** | **4** | Pure modules, all-new files, zero overlap |
| 3 | **4** | 1 | Blocked on 3 (needs the validator) |
| 4 | **5 + 6b** | 1 | Integrates 2, 4 and 6a; breaker wiring belongs here |
| 5 | **7** | 1 | The wiring PR — touches shared app files, keep it alone |
| 6 | **8, 8a, 9** | **3** | Mostly disjoint; see conflicts below |
| 7 | **10b** | 1 | Instruments every call site, conflicts with everything |
| 8 | **11**, then **12** | 1 | 12 can start while 11 runs |

Two steps split for parallelism:

- **6a** = the `circuitBreaker.ts` module (standalone, parallel-safe). **6b** = wiring it into
  `articleCache.ts`, which has to follow step 5.
- **10a** = the `logger.ts` / `metrics.ts` facade — no dependencies, buildable on day one.
  **10b** = instrumenting the call sites, which must come last.

Critical path is 1 → 3 → 4 → 5 → 7 → 9 → 10b → 11 → 12: nine sequential steps instead of fourteen.

### Worktree conflicts to avoid

- **`package.json` / `package-lock.json` is the main hazard.** Install every dependency the project
  will need in step 1, so no wave-2 branch has to touch the lockfile. Lockfile merge conflicts are
  miserable and entirely avoidable here.
- **Port collisions.** Playwright's `webServer` binds `:3000` and so does `CMS_BASE_URL`. Two
  worktrees running e2e concurrently will fight over it, so step 1 makes the port configurable.
- **Shared spec files.** Steps 8, 8a and 9 run concurrently — have each add its *own* spec file
  rather than appending to `failure-modes.spec.ts`, or wave 6 merges will conflict on it.
- The mocked CMS store is per-process, so worktrees are otherwise fully isolated from each other.

## Shared context

Paste this above any step prompt when starting a fresh session:

```
This repo is the Fool.com coding challenge (see README.md). I am adding a from-scratch
app-level cache so article pages stay fast and accurate when the upstream CMS is slow,
down, hanging, or returning corrupt content. Do not use Next's built-in caching
(`use cache`, `unstable_cache`, fetch cache, ISR) — the cache is ours.

The design is a data cache (validated ArticleData, not HTML) sitting in the service
layer, with two independent dials: a short *fresh* window (1s) that sheds load, and an
*unbounded stale* window, because a slightly old article beats a 500. An entry is only
ever overwritten by a successful, validated response — nothing else evicts it.

Config constants:
  FRESH_TTL_MS 1000, REVALIDATE_DEADLINE_MS 400, UPSTREAM_TIMEOUT_MS 2000,
  BREAKER_FAIL_THRESHOLD 3, BREAKER_COOLDOWN_MS 5000, REFRESH_INTERVAL_MS 2000,
  CACHE_MAX_ENTRIES 500

Cache key is the article `path` only. `?source=` is test tooling — forward it to the
upstream call, never put it in the key. Read docs/IMPLEMENTATION_PLAN.md for the full
step list.
```

---

## Step 1 — Test harness

```
Add the test harness for this repo. Two runners, different jobs:

1. Vitest for cache internals (needs fake timers for TTL and circuit-breaker cooldown
   tests). Configure it to resolve the `@/*` path alias from tsconfig.json.
2. Playwright for end-to-end acceptance.

For Playwright:
- `webServer` should run `npm run build && npm run start`, not dev — dev-mode timing is
  not representative.
- Set `fullyParallel: false` and `workers: 1`. Publishing a correction permanently mutates
  in-memory CMS state shared by every test, so parallel tests would corrupt each other.
- Most assertions are on server-rendered HTML, so use the `request` fixture (no browser)
  for the failure-mode matrix. Reserve a real browser test for the MockSourcesToolbar.

Write tests/e2e/failure-modes.spec.ts covering healthy, slow, down, hang and corrupt for
one seeded article. For each mode assert: HTTP 200, response under 1s, the correct
headline, and the version badge (`[data-testid="article-version"]`, which already exists
in app/articles/[...slug]/page.tsx). Mark every mode except `healthy` as `test.fixme` —
they document the target and get flipped green as later steps land.

Add `npm run test` (vitest) and `npm run test:e2e` (playwright) scripts.

Two things that matter because later steps get built concurrently in git worktrees:

1. Make the port configurable. Read `process.env.PORT` (default 3000) in playwright.config.ts
   for both `webServer` and `baseURL`, and make CMS_BASE_URL in services/articleService.ts
   derive from it. Otherwise two worktrees running e2e at once fight over :3000.
2. Install every dependency the project will eventually need in this PR, even if unused
   yet. Later branches then never touch package-lock.json, which avoids lockfile merge
   conflicts across parallel worktrees.
```

**Done when:** `npm run test:e2e` passes with `healthy` green and four fixmes reported, and
`PORT=3100 npm run test:e2e` also works.

---

## Step 2 — Cache store

```
Create lib/cache/store.ts.

Define a `CacheStore<T>` interface — get, set, delete, keys — and an `InMemoryCacheStore<T>`
implementing it with max-entries LRU eviction (CACHE_MAX_ENTRIES = 500) using Map insertion
order: on read, delete and re-set the key to move it to the end; on overflow, evict the
first key.

The interface exists so the "we'd use Redis in production" conversation points at real code
rather than a paragraph — keep it small enough that a Redis adapter is an obvious drop-in.

Important: export the shared instance through a `globalThis` singleton, not a plain module
const. Next's dev-mode HMR re-evaluates modules on every edit, which would silently reset
the cache and make local behaviour differ from production.

Unit-test eviction order, LRU promotion on read, delete, and the singleton surviving a
simulated module re-import. No app wiring in this step.
```

**Done when:** `npm run test` passes; nothing else in the app imports this yet.

---

## Step 3 — Article validator

```
Create lib/cms/validateArticle.ts.

Export a function that takes an unknown payload plus the requested path and returns
`{ ok: true, article: ArticleData } | { ok: false, reason: string }`. The reason string
feeds a metric tag, so keep it a short bounded set (e.g. "missing_field", "bad_version",
"placeholder", "path_mismatch"), not free text.

Rules:
- every required string field present and non-empty
- `version` is a positive integer
- `publishedAt` / `updatedAt` parse as dates
- `body` is a non-empty array of strings
- the returned `path` matches the requested path
- no unresolved `{{...}}` template placeholders in any string

The last rule is the realistic one: the corrupt payload is structurally plausible JSON, so
schema shape alone is not enough to call it a real article.

Test against the real fixture — import CORRUPT_ARTICLE_PAYLOAD from lib/cmsMock.ts rather
than hand-rolling a fake, and assert it is rejected. Also test that every seeded article
passes. No app wiring in this step.
```

**Done when:** the real corrupt payload is rejected and all four seed articles pass.

---

## Step 4 — Upstream client

```
Create lib/cms/cmsClient.ts — the single choke point for all CMS I/O.

It wraps the fetch currently in services/articleService.ts and adds:
- an AbortController with a UPSTREAM_TIMEOUT_MS (2000) hard timeout. The current code has
  no abort at all, so `?source=hang` leaks one open socket per request. This fixes that.
- validation via step 3
- a classified result: { outcome, article?, durationMs } where outcome is one of
  ok | timeout | http_error | invalid | not_found

Note `not_found` is distinct from `http_error`: a genuine 404 is a real answer about a
non-existent article, not an upstream failure, and later steps treat them differently.

Give it a `caller` argument typed as 'read' | 'refresher' | 'push' | 'prewarm'. Without it
the background refresher's calls get mixed into the "is upstream healthy" signal alongside
real user traffic, and in APM the refresher would skew request latency percentiles.

Keep forwarding the optional `source` param to the upstream URL — the README requires the
failure modes keep working.

Unit-test each outcome with a stubbed fetch, including that a timeout actually aborts the
request rather than just resolving late.
```

**Done when:** all five outcomes are covered and the timeout path is proven to abort.

---

## Step 5 — Cache policy engine

```
Create lib/cache/articleCache.ts. This is the heart of the design.

Read path for a key:
- fresh (age < FRESH_TTL_MS): serve HIT immediately
- stale: join or start a single-flight refresh, then wait up to REVALIDATE_DEADLINE_MS
  (400). If it lands in time serve REVALIDATED; otherwise serve STALE
- cold miss: await the fetch up to UPSTREAM_TIMEOUT_MS
- cold miss + failure: return null so the caller can render a degraded page

Return { article: ArticleData | null, status, ageMs, upstreamOutcome } with status in
HIT | REVALIDATED | STALE | MISS | UNAVAILABLE.

Non-negotiable invariants:
- an entry is overwritten ONLY by an `ok` outcome. timeout, http_error and invalid all
  leave the existing entry untouched and serve it stale. This is what makes `down`,
  `hang` and `corrupt` survivable.
- the stale window is unbounded. Never expire an entry out of existence.
- single-flight must be keyed per path, and the in-flight entry MUST be cleared in a
  finally block. If an aborted `hang` fetch leaves a rejected promise cached, every later
  healthy read for that path joins the dead promise.

Unit tests with fake timers and a stub client: fresh hit; stale serve; refresh landing
inside the deadline; deadline expiry falling back to stale; error leaving the entry intact;
invalid payload leaving the entry intact; N concurrent readers producing exactly 1 upstream
call; cold miss + failure returning null; and an aborted fetch not poisoning the next read.
```

**Done when:** all nine scenarios pass. Still no app wiring.

---

## Step 6 — Circuit breaker

> Split for parallelism: **6a** (the module) can be built alongside steps 2, 3 and 10a. **6b** (the
> wiring) has to wait for step 5.

```
Create lib/cache/circuitBreaker.ts: a standard closed → open → half-open breaker.

BREAKER_FAIL_THRESHOLD (3) consecutive failures opens it for BREAKER_COOLDOWN_MS (5000).
After the cooldown it goes half-open and allows exactly one probe; success closes it,
failure re-opens it.

Wire it into step 5 so that while the circuit is open a stale read skips the bounded wait
entirely and serves from cache in ~1ms instead of burning 400ms per request on an upstream
we already know is broken. This is what turns `down` and `hang` from "slow but working"
into "instant".

Scope it globally (one upstream CMS), not per-article.

Known interaction to leave a comment about: hitting `?source=down` trips the global breaker,
so a following healthy request may serve STALE for up to the 5s cooldown. Content is still
correct, and the background refresher in step 8 never sends `source`, so it probes healthy
and closes the circuit on its own.

Unit-test all state transitions with fake timers, including that half-open admits exactly
one probe under concurrency.
```

**Done when:** transitions are covered and an open circuit demonstrably skips the wait.

---

## Step 7 — Wire into the app

```
Now connect the cache. Change getArticle in services/articleService.ts to read through
lib/cache/articleCache.ts. Keep forwarding `source` to the upstream call; it must never
reach the cache key.

Give getArticleIndex the same treatment so the home page also survives a broken upstream.

app/articles/[...slug]/page.tsx calls getArticle twice — once in generateMetadata and once
in the component. React's fetch memoization was deduping that; the cache's single-flight
now needs to. Verify only one upstream call happens per page render.

Handle a null article in both places:
- `not_found` outcome → notFound(). Add short negative caching (~30s) so a missing article
  neither gets stale-served nor hammers the upstream on crawler traffic.
- anything else → a degraded "temporarily unavailable" render. generateMetadata must not
  throw in this case either; give it a generic title.

Then flip the down, corrupt and hang tests in tests/e2e/failure-modes.spec.ts from
test.fixme to active. They should pass. `slow` should too, once warm.
```

**Done when:** the full failure matrix is green and each page render makes ≤1 upstream call.

---

## Step 8 — Prewarm and background refresher

```
Add instrumentation.ts at the repo root with a `register()` export. This is a Next
lifecycle hook, not Next caching — it is fine under the challenge's ground rules.

Two jobs, both node-runtime only (guard on NEXT_RUNTIME === 'nodejs'):

1. Prewarm: fetch the CMS index and populate the cache for each article. Run it in the
   background — never block server startup — and tolerate total failure. This is what makes
   a freshly restarted server survive someone hitting ?source=down as their first request.

2. Background refresher: every REFRESH_INTERVAL_MS (2000), revalidate the warm keys through
   the same single-flight path the request path uses. It must never send `source`. Call
   .unref() on the interval so it cannot hold the process open.

Both use caller tags 'prewarm' and 'refresher' from step 4.

Add an e2e test: restart the server, immediately request ?source=down, and assert real
article content comes back.
```

**Done when:** a cold server serves content under `?source=down` on the very first request.

---

## Step 8a — CDN-ready response headers

```
Emit real HTTP caching headers on the article route. The origin cache and a CDN implement
the same policy at different layers, so express ours as standard directives:

  Cache-Control: public, s-maxage=60, stale-while-revalidate=300, stale-if-error=86400
  Surrogate-Key: article-<id>

s-maxage (60s) is deliberately much longer than our internal 1s fresh TTL, because edge
invalidation is push-based (step 9) and the TTL is only a backstop. Surrogate-Key enables
purge-by-tag rather than purge-by-URL, which matters because one article is reachable at
several URLs.

Set these in next.config.ts headers() or middleware.ts — a server component cannot set
response headers.

Two corrections to the naive version:

1. Change the degraded render from step 7 to return 503 with `Cache-Control: no-store`. As
   a 200 it would be cached at the edge and the outage served to every reader for the full
   TTL. Setting a status code needs middleware or a route handler, since a page component
   cannot.

2. The public s-maxage is only correct for anonymous traffic. There is no auth in this repo
   so build nothing conditional — but write it as an explicitly anonymous-traffic policy
   with a comment naming the authenticated branch (private, no-store; personalization
   injected client-side or at the edge). An unconditional `public` becomes a
   personalization leak the day a session cookie appears.

Verify with `curl -I`.
```

**Done when:** `curl -I` shows the directives, and the degraded path returns 503 + no-store.

---

## Step 9 — Push invalidation

```
Add POST /api/internal/revalidate?path=... , authenticated with a shared secret from env
(compare in constant time). Unauthenticated this is a request-amplification vector, since
each call triggers an upstream fetch.

Behaviour: mark the entry stale and immediately attempt a refresh through the existing
single-flight path. It MUST NOT delete the entry. If a correction is published while the
upstream is down, eviction would destroy the only good copy we have and turn a merely stale
page into an unavailable one. Mark-stale-and-try preserves stale-if-error.

Then add a fire-and-forget call to this endpoint from app/api/cms/admin/route.ts after
publishCorrection, gated on a CMS_WEBHOOK_URL env var and wrapped so a slow or failing
webhook can never affect the admin response.

On the mock modification: README.md forbids changing the *failure mode* logic. The admin
route is correction publishing, not failure-mode logic, so this is in bounds — but keep the
change to a few lines and call it out in ARCHITECTURE.md so a reviewer doesn't have to
discover it.

Leave a no-op `purgeEdge(surrogateKey)` seam, called only AFTER the origin refresh
succeeds. Purging the edge first makes the CDN re-fetch and re-cache the old version, so
the correction would need a second purge to land.

Tests: a push during a simulated outage leaves the old entry intact and servable; the
purge-after-refresh ordering holds; and e2e, publishing with the webhook enabled yields the
new version on the very next request.
```

**Done when:** propagation with the webhook on is sub-100ms and an outage-time push is safe.

---

## Step 10 — Observability

> Split for parallelism: **10a** is the `logger.ts` / `metrics.ts` facade plus its unit tests — no
> dependencies, buildable in wave 2. **10b** is instrumenting the call sites and the stats
> endpoint, which touches every module and must come last.

```
Add lib/observability/logger.ts (structured JSON lines) and lib/observability/metrics.ts
(counters plus an upstream latency histogram). Emit through this facade everywhere, never
a vendor SDK directly — in production the same call sites point at dogstatsd, and tests
don't need an agent running.

Instrument the seams already built: cmsClient (every upstream call), articleCache (every
read), circuitBreaker (state transitions), the refresher and the revalidate endpoint.

Fields: cacheStatus, entry age, upstreamMs, upstreamOutcome, circuitState, articleVersion,
caller.

Cardinality discipline, designed in now because it is painful to retrofit: tag metrics by
outcome / status / caller only — all bounded sets. The article path goes in logs and traces,
never in a metric tag. At hundreds of thousands of articles, a path tag is a custom-metric
cardinality bomb that costs more than the infrastructure it monitors.

Also add:
- data-cache-status and data-cache-age attributes on the article element, so e2e tests can
  assert cache behaviour directly (a server component can't set X-Cache headers)
- GET /api/_internal/cache-stats exposing upstream health, circuit state, per-key age and
  version, max entry age, and the counters
- an `article.version_changed` event carrying old → new version and the delta between the
  article's updatedAt and when we observed it. That delta is the correction-propagation lag
  metric. Tag it with the trigger that caught the change (push | refresher | read) so the
  lag is attributable — a silently broken webhook then shows up as traffic shifting from
  `push` to `refresher`.
```

**Done when:** the stats endpoint answers all four README observability questions.

---

## Step 11 — Correction propagation e2e

```
Write tests/e2e/corrections.spec.ts.

Main flow, mirroring how the challenge says it will be graded: publish a correction via
POST /api/cms/admin?publish-correction=<path>, then re-run the entire failure-mode matrix
and assert every mode returns the corrected version, still fast.

Then one test per propagation trigger, because the redundancy is the point and each needs
to be shown working alone:
1. webhook enabled → corrected version on the very next request
2. webhook DISABLED, zero traffic → wait past the refresh interval, assert the corrected
   version without any intervening request (proves the background refresher covers it)
3. webhook disabled, refresher cold → assert the read-path bounded wait still yields the
   corrected version

Test 2 is the important one: it proves push invalidation is a latency optimization, not a
correctness dependency. A dropped webhook should be a regression in speed, not in accuracy.

Remember workers: 1 — these tests mutate shared CMS state.
```

**Done when:** all three triggers independently deliver the corrected version.

---

## Step 12 — Final docs

```
Write the durable documentation.

1. docs/ARCHITECTURE.md — short and human-readable, for someone who has never seen this
   repo. What the cache is, where it sits, the two-dial model (short fresh window for load
   shedding, unbounded stale window because a slightly old article beats a 500), the three
   redundant refresh triggers, how each failure mode is handled, and how to operate it.
   Include the ASCII request-flow diagram. Mention the small addition to the CMS mock's
   admin route explicitly. Keep it tight — this is the doc that gets read first.

2. docs/DESIGN_OPTIONS.md — finalize. Candidate architectures considered and why each was
   picked or rejected, including Redis for cross-replica sharing and the disk L2 tier we
   chose not to build.

3. docs/PRODUCTION.md — three sections: Edge/CDN, Personalization & entitlement, and
   Observability & alerting. See the approved plan for the full content brief.

Then delete or trim docs/IMPLEMENTATION_PLAN.md — it is scaffolding.
```

**Done when:** a reader can understand the system from `ARCHITECTURE.md` alone.
