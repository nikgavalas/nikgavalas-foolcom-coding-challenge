# Manual testing guide

This is a hands-on walkthrough for verifying the caching layer yourself. Eleven tests, each one
command, each with the output you should expect and an explanation of what it proves.

Every output below was captured from a real run. If you get something materially different,
that's a signal worth chasing, not a typo in this file. Timings will vary with your machine;
the *shape* of the result — cache status, version, order of magnitude — is what matters.

Each test names the [ARCHITECTURE.md](ARCHITECTURE.md) scenario it exercises, if you want the
design rationale behind what you're seeing.

---

## Setup

Two terminals. In the first:

```bash
npm ci
npm run demo           # builds if needed, starts the server, tees logs to /tmp/demo.log
```

In the second:

```bash
./scripts/demo.sh help
```

That's the whole setup. Every test below is one command from that help output.

**Config** lives in [.env.example](../.env.example), which documents all four env vars and holds
no secrets. `cp .env.example .env` if you want to change something; the script falls back to the
same values, so this works with no `.env` at all. Any var can be overridden inline
(`PORT=3005 ./scripts/demo.sh peek`), and `--no-webhook` is a global flag that points any command
at the second server used in Test 9.

If you edit `.env` after already having a build, run `npm run build` before `npm run demo` —
`demo.sh serve` only builds when `.next` doesn't exist yet, and env values are baked in at build
time, so it won't pick up the change on its own.

Two things about the setup that affect what you'll see:

- `npm run demo` sets `REVALIDATE_SECRET` and derives `CMS_WEBHOOK_URL` from `PORT`. Without
  both, push invalidation is off — deny-by-default, not "auth disabled" — and corrections would
  arrive via the background refresher instead. That's Test 9, deliberately isolated.
- It always serves a **production build**. Dev-mode timing (on-demand compilation, no
  minification) would not be representative of the latency behavior under test.

### The four seeded articles

All four are prewarmed at boot. The script drives the first one by default.

```bash
./scripts/demo.sh articles
```

```
  investing/2026/07/22/should-you-buy-spacex-stock-before-aug-4
  investing/2026/07/22/prediction-meta-platforms-will-soar-on-july-29-whe
  investing/2026/07/23/invest-10000-nvidia-stock-10-years-ago-how-much
  investing/2026/07/22/this-stock-is-crushing-both-lucid-and-rivian-in
```

### Testing in the browser instead

Open `http://localhost:3000`, then any article. A floating toolbar at the bottom gives you the
five failure modes as links and a **publish correction** button. It drives the same code paths as
the commands below — use it if you'd rather click than type. Inspect the `<article>` element to
see the cache status the commands print.

---

## Test 0 — The cache is warm before the first request (scenario 2)

**Run this first, before requesting any page.** It's the easiest piece to miss, because by the
time you look at anything else the evidence is gone.

```bash
./scripts/demo.sh stats
```

```json
"circuitBreaker": { "state": "closed" },
"articleCache": {
  "entryCount": 4,
  "maxAgeMs": 1032,
  "entries": [ { "path": "investing/...spacex...", "ageMs": 1032, "version": 1 }, ... ]
}
```

**What you're looking for:** `entryCount: 4`, with nobody having visited the site yet.

**What it proves:** `instrumentation.ts` fetched the CMS index at boot and warmed every article,
so the first real reader never pays for a cold cache. The warm is fire-and-forget, which means a
dead CMS at startup delays nothing and crashes nothing — the server comes up either way.

Confirm it in the logs:

```bash
./scripts/demo.sh logs prewarm
```

```json
{"outcome":"ok","articleCount":4,"durationMs":313,...,"message":"prewarm_run"}
```

---

## Test 1 — The happy path (scenario 1)

```bash
./scripts/demo.sh peek
```

```
http=200 time=0.164445s HIT         age=19ms   v1
```

**What you're looking for:** `HIT`, a small `age`, and `v1`.

**What it proves:** the page was served from memory, from an entry 19ms old, with no CMS call at
all. Verify that last part with `./scripts/demo.sh logs reads` — you'll see a `cache_read` with
`status:"HIT"` and *no* accompanying `upstream_call`.

> The 164ms is the **first** request to a freshly booted server, where Node is still doing
> first-request work (module loading, JIT). Run it twice; the second is ~5ms, and every other
> timing in this guide is a warm one.

---

## Test 2 — Every failure mode is invisible while the cache is warm (scenarios 4, 7–9)

This is the core requirement of the exercise, in one command.

```bash
./scripts/demo.sh modes
```

```
healthy  http=200 time=0.008374s HIT         age=177ms  v1
slow     http=200 time=0.006622s HIT         age=238ms  v1
down     http=200 time=0.005773s HIT         age=286ms  v1
hang     http=200 time=0.005788s HIT         age=334ms  v1
corrupt  http=200 time=0.006059s HIT         age=379ms  v1
```

**What you're looking for:** five rows, all `http=200`, all `HIT`, all `v1`, all single-digit
milliseconds.

**What it proves:** the CMS is returning 500s, hanging forever, and serving corrupt JSON — and
none of it reaches the reader. While an entry is inside its 1-second fresh window the cache never
contacts the CMS, so upstream state is simply irrelevant to the response.

Worth noticing: `healthy` is often the *slowest* of the five, because it's the only mode that
could have talked to the CMS at all.

---

## Test 3 — Serving stale rather than failing (scenarios 5, 7)

Test 2 shows the easy case. To reach the interesting path, the entry has to be older than the 1s
fresh window. The background refresher touches every warm key every 2s, so age oscillates 0–2s
and roughly half of your requests will land stale. This command fires several 0.5s apart to catch
some:

```bash
./scripts/demo.sh stale          # defaults to ?source=down, 8 reads
```

```
==> 8 reads with ?source=down, 0.5s apart
http=200 time=0.007275s HIT         age=705ms  v1
http=200 time=0.223319s STALE       age=1495ms v1
http=200 time=0.010784s HIT         age=96ms   v1
http=200 time=0.006991s HIT         age=703ms  v1
http=200 time=0.222890s STALE       age=1521ms v1
```

**What you're looking for:** a mix of `HIT` and `STALE`, every row still `http=200` and `v1`. If
you see all `HIT`, run it again — you're just landing inside the fresh window each time.

**What it proves:** on the `STALE` rows the entry had aged past 1s, so the cache attempted a
refresh, the CMS returned a 500, and the old copy was served anyway. **The failed response did
not overwrite the entry** — the version is still correct. Cost of the failure: ~220ms instead of
~7ms. Nobody gets an error page.

The log line carries the whole story:

```bash
./scripts/demo.sh logs '"status":"STALE"'
```

```json
{"path":"investing/...","caller":"read","status":"STALE","ageMs":1367,
 "upstreamOutcome":"http_error","circuitState":"open","version":1,...}
```

What was served, how old it was, what the upstream said, and what the breaker thought — one line,
no correlation required.

> **Why ~220ms and not ~110ms?** The Proxy reads the cache (to decide 200 vs 503) and *then* the
> page reads it. They're sequential, so a stale page view makes two upstream attempts of ~100ms
> each. `generateMetadata` and the page component *are* concurrent and do collapse into one.

### The `slow` mode specifically

```bash
./scripts/demo.sh stale slow 4
```

```
http=200 time=0.004975s HIT         age=489ms  v1
http=200 time=0.823800s STALE       age=1896ms v1
http=200 time=0.421614s HIT         age=234ms  v1
```

**What you're looking for:** a `STALE` around 400ms per cache read, then a `HIT` — not an
8-second wait anywhere.

**What it proves:** the CMS takes 8 seconds in this mode, but the read path only gives a refresh
400ms to land before it stops waiting and serves what it has. The refresh keeps running in the
background, and its result lands for the next reader — which is why the *following* request is a
`HIT` rather than another stale serve. A slow upstream costs you 400ms, not 8s, and only once.

> Run this against a **closed** breaker. If you've just run Test 4, the circuit is open, so no
> call is attempted and you'll see 5ms STALEs instead of the bounded wait. Wait ~5s.

---

## Test 4 — The circuit breaker opens, then heals itself (scenario 6)

```bash
./scripts/demo.sh trip
```

```
==> concurrent failing reads, one per seeded article
breaker: open  (round 1)
```

**What you're looking for:** `open`. Once three consecutive failures trip it, nothing can close
it for the full `BREAKER_COOLDOWN_MS` — `isAllowed()` refuses every caller, and only a caller
that got permission can report a success. So a poll inside that 5s window always catches it.

Then wait out the cooldown and look again:

```bash
sleep 9 && ./scripts/demo.sh breaker
```

```
closed
```

> Poll closer to the 5s mark and the answer is often `half-open`: the cooldown has elapsed, so
> the next caller will be let through as a probe, but nobody has been through yet. The 9s allows
> for the cooldown *plus* the up-to-2s wait for the next refresher tick.

**What it proves:** the system heals with no user request involved. The background refresher
never sends `?source=`, so it talks to the *real* CMS; its first post-cooldown probe succeeds and
closes the circuit. Between the two commands above, nothing but the refresher ran.

Two details in `trip` are there because getting three *consecutive* failures by hand is harder
than it sounds, and both are worth understanding:

- **It hits a different article per request.** Concurrent reads of the *same* path collapse into
  one upstream call via single-flight, which would score one failure, not four.
- **It retries up to six rounds.** Any success resets the failure count to zero
  ([circuitBreaker.ts:57](../lib/cache/circuitBreaker.ts#L57)), and a round scores nothing at all
  if the refresher revalidated everything a moment earlier — those entries are still inside the
  1s fresh window, so the reads are `HIT`s that never touch the CMS. If it still reports `closed`
  after six rounds, restart the server with `REFRESH_INTERVAL_MS=60000` to widen the gap between
  refresher ticks.

Every transition is in the log either way:

```bash
./scripts/demo.sh logs breaker
```

```json
{"from":"closed","to":"open","failureCount":3,...,"level":"warn","message":"circuit_transition"}
```

So: **the system heals without any user request having to discover the recovery.** In production
this is the difference between an alert that clears itself and a page at 3am.

> These are `warn`-level lines, which the logger writes to **stderr**. `./scripts/demo.sh serve`
> tees with `2>&1` for exactly this reason — pipe stdout alone and every breaker transition
> vanishes from the log.

---

## Test 5 — The one case with no good answer: 503 (scenario 10)

A path that has never been cached, against a failing CMS. There is nothing to fall back on, so
this test is about failing *correctly*.

```bash
./scripts/demo.sh cold
```

```
==> GET /articles/never-cached/demo-84027-28112?source=down
HTTP/1.1 503 Service Unavailable
cache-control: no-store
```

**What you're looking for:** `503`, and `cache-control: no-store`.

**What it proves:** two deliberate choices. **503, not 200** — a 200 would be cached at the edge,
and the outage would then be served to every reader for the full 60s TTL. And `no-store`, so no
layer anywhere retains the error page. A page component can't set a status code, which is why
this lives in [proxy.ts](../proxy.ts).

---

## Test 6 — A real 404, and the negative cache (scenario 11)

```bash
./scripts/demo.sh missing
```

```
==> first request:  404
==> second request: 404

==> log lines for nope/not-a-real-article (expect one upstream call, not two)
{"path":"nope/not-a-real-article","caller":"read","outcome":"not_found","durationMs":104,...}
{"path":"nope/not-a-real-article","caller":"read","status":"UNAVAILABLE","ageMs":0,
 "upstreamOutcome":"not_found","circuitState":"closed",...}
```

**What you're looking for:** two 404s, but only **one** `upstream_call` in the log.

**What it proves:** the second request was answered entirely from the 30s negative cache. It
produced no log lines at all, because it short-circuits before the policy engine even runs. That's
what stops a bad link from generating one CMS call per crawler hit.

Note also that a 404 counts as a breaker **success**: the CMS answered, it just answered "no."

> **Worth testing on purpose:** run this *while the breaker is open* and you get **503, not 404**.
> With the circuit open we never ask, so we can't distinguish "doesn't exist" from "can't reach
> the CMS" — 503 is the honest answer, and it isn't cached, so the next request after the circuit
> closes returns a real 404. The log line shows it: `status: "UNAVAILABLE"` with
> `circuitState: "open"`.

---

## Test 7 — CDN headers (the CDN section of ARCHITECTURE.md)

```bash
./scripts/demo.sh headers
```

```
HTTP/1.1 200 OK
cache-control: public, s-maxage=60, stale-while-revalidate=300, stale-if-error=86400
surrogate-key: article-investing-2026-07-22-should-you-buy-spacex-stock-before-aug-4
```

**What you're looking for:** all three directives on `cache-control`, plus a `surrogate-key`
derived from the article path.

**What it proves:** no CDN is hooked up here, but the caching policy is already expressed in the
vocabulary a CDN would understand. `s-maxage=60` is deliberately longer than the 1s internal
window, because edge invalidation is push-based and the TTL is only a backstop.
`stale-if-error=86400` is the same unbounded-stale rule from Test 3, projected one layer out — the
site survives even the *origin* going down. `Surrogate-Key` enables purge-by-tag, so one call
catches every URL an article is reachable at.

Contrast with Test 5, where errors get `no-store`: an outage should never become cacheable.

---

## Test 8 — Push invalidation, end to end (scenario 12)

First the auth gate, since this endpoint is what a real CMS would call:

```bash
./scripts/demo.sh revalidate
```

```
no secret     -> 401
wrong secret  -> 401
right secret  -> {"path":"investing/...","status":"REVALIDATED","version":1}
```

**What you're looking for:** 401 for both the missing and the wrong secret; a `REVALIDATED` JSON
body for the right one.

**What it proves:** every accepted call triggers a real upstream fetch, so an unauthenticated
endpoint here would be a request-amplification vector. The compare is constant-time, and a
*missing* secret means deny — not "auth off."

Now the actual requirement — publish a correction, then read immediately:

```bash
./scripts/demo.sh correct
```

```
==> publish: {"published":"investing/...","version":2,"updatedAt":"2026-08-05T16:40:06.904Z"}
==> read:    http=200 time=0.109886s HIT         age=2ms    v2

==> propagation
{"path":"...","oldVersion":1,"newVersion":2,"trigger":"push","propagationLagMs":105,...}
{"path":"...","oldVersion":1,"newVersion":2,"trigger":"read","propagationLagMs":123,...}
```

**What you're looking for:** `v2` on the very next read, and that read being a `HIT`.

**What it proves:** the cache was already updated before the read arrived — no reader paid for the
correction. `propagationLagMs: 105` is the wall-clock gap between the CMS stamping `updatedAt` and
the cache observing the new version, tagged with which mechanism got there first. That tagging is
the operational payoff: a silently broken webhook shows up as traffic shifting from `push` to
`refresher`, so you'd see the *lag* regress without anything erroring.

> Both a `push` and a `read` line appear because both paths independently observed the change.
> `correct` publishes and reads back-to-back, so which one wins the race varies run to run — if
> `trigger:"read"` comes first, the webhook simply landed a few ms later. Either way the reader
> got v2.

Then re-run Test 2 to confirm the correction survives every failure mode:

```bash
./scripts/demo.sh modes
```

```
healthy  http=200 time=0.005030s HIT         age=136ms  v2
slow     http=200 time=0.004601s HIT         age=188ms  v2
down     http=200 time=0.004153s HIT         age=233ms  v2
hang     http=200 time=0.004568s HIT         age=286ms  v2
corrupt  http=200 time=0.004729s HIT         age=340ms  v2
```

**What you're looking for:** `v2` on all five rows, still under 10ms. Not the old copy, and not an
error — which together are the whole ask of the exercise.

---

## Test 9 — Push is an optimization, not a dependency (scenario 13)

**The most important test here.** A dropped webhook should be a regression in *speed*, not in
*accuracy*. The only honest way to check that is to run a server with push genuinely turned off,
since `CMS_WEBHOOK_URL` is fixed for a process's lifetime. In a third terminal:

```bash
npm run demo:no-webhook        # PORT+1, no CMS_WEBHOOK_URL, its own log
```

Then, back in the second terminal — `--no-webhook` points any command at that server:

```bash
./scripts/demo.sh --no-webhook correct
```

```
==> publish: {"published":"investing/...","version":2,"updatedAt":"2026-08-05T16:40:23.653Z"}
==> read:    http=200 time=0.053936s HIT         age=855ms  v2

==> propagation
{"path":"investing/...","oldVersion":1,"newVersion":2,"trigger":"refresher",
 "propagationLagMs":342,"message":"version_changed"}
```

**What you're looking for:** `v2` again, but `trigger:"refresher"` instead of `"push"`.

**What it proves:** no webhook fired, and the cache still corrected itself — because the
background refresher re-probes every warm article every 2s. Push buys you ~105ms instead of up to
~2s. It does not buy you correctness; the refresher already guarantees that.

To make the "nobody had to request it" part airtight, publish and *don't* read:

```bash
curl -s -X POST "http://localhost:3001/api/cms/admin?publish-correction=$(
  ./scripts/demo.sh --no-webhook articles | head -1 | tr -d ' ')"
sleep 3
./scripts/demo.sh --no-webhook logs versions
```

The `version_changed` line is there, with no `caller:"read"` anywhere near it. The cache fixed
itself with zero traffic.

---

## Test 10 — Answering operational questions from the instrumentation

Three surfaces, each answering a different kind of question. This test is less "run it and check
the output" and more "find the answer to a question you'd actually have at 3am."

### 1. Structured logs (stdout + stderr, JSON lines)

Every log line is one JSON object. In production these would ship to a log aggregator; here,
`./scripts/demo.sh logs` greps them. Named filters:

```bash
./scripts/demo.sh logs reads        # what was served and why
./scripts/demo.sh logs upstream     # every CMS call, with outcome + duration
./scripts/demo.sh logs warn         # failures only
./scripts/demo.sh logs breaker      # breaker state changes
./scripts/demo.sh logs versions     # correction propagation, with lag
./scripts/demo.sh logs prewarm      # the boot-time warm
./scripts/demo.sh logs background   # prewarm + the last few refresh cycles
```

Anything else is treated as a raw pattern, e.g. `./scripts/demo.sh logs '"status":"STALE"'`.

If you have `jq`, this is the one to watch while you drive requests from another terminal — a live
view of what the cache is doing for real readers:

```bash
./scripts/demo.sh tail
```

It filters to `caller=="read"` deliberately: the refresher logs every 2s, so an unfiltered tail
drowns out anything you're doing by hand.

Field glossary: `caller` is one of `read` / `refresher` / `push` / `prewarm` — it's what keeps
background traffic out of user-facing latency percentiles. `status` is the five cache outcomes.
`circuitState` is the breaker at the moment of that read.

### 2. `/api/_internal/cache-stats`

```bash
./scripts/demo.sh stats
```

Answers the four operational questions at a glance:

| Question | Where to look |
|---|---|
| Is the upstream healthy? | `circuitBreaker.state`, plus `upstream_calls` counters by outcome |
| How stale is anything? | `articleCache.maxAgeMs`, and per-entry `ageMs` |
| What version is cached? | per-entry `version` |
| How is the cache performing? | `metrics.counters` / `metrics.histograms` |

No upstream I/O and no auth — it only reads state that's already in memory, so it's safe to poll.
It uses a non-mutating `peekEntries()` so that *looking* at the cache never perturbs LRU order.

Two slices are worth pulling out of that blob directly:

```bash
./scripts/demo.sh metrics
```

Real output after walking the tests above:

```
==> cache reads by status and caller
  {'status': 'MISS', 'caller': 'prewarm'} 4
  {'status': 'REVALIDATED', 'caller': 'refresher'} 83
  {'status': 'HIT', 'caller': 'read'} 78
  {'status': 'STALE', 'caller': 'read'} 13
  {'status': 'UNAVAILABLE', 'caller': 'read'} 2
  {'status': 'REVALIDATED', 'caller': 'push'} 2

==> upstream latency by outcome
  {'outcome': 'ok', 'caller': 'refresher'} p50 110 p95 117 max 137
  {'outcome': 'ok', 'caller': 'read'} p50 104 p95 104 max 104
  {'outcome': 'timeout', 'caller': 'read'} p50 2005 p95 2005 max 2005
  {'outcome': 'http_error', 'caller': 'read'} p50 105 p95 107 max 107
  {'outcome': 'not_found', 'caller': 'read'} p50 104 p95 104 max 104
```

**What to notice:** `caller` cleanly separates background probing from real reads. That separation
is why the refresher's 83 revalidations don't pollute the user-facing health signal. And the
`timeout` row is the `hang` mode hitting the 2s upstream timeout — fully visible to an operator
without a single user having seen a slow page.

### 3. `data-cache-status` in the HTML

This is what `peek` reads. A server component can't set response headers, so the cache status
rides on the rendered `<article>` element instead. In the browser, inspect that element and you'll
see it change as you click through the toolbar. It's also what the e2e tests assert on.

```bash
DEMO_VERBOSE=1 ./scripts/demo.sh peek down     # prints the underlying curl
```

---

## Automated tests

Everything above is also covered by the test suites, so you can check the same behavior without
driving it by hand:

```bash
npm run test        # unit tests, ~0.3s — cache policy, breaker, validator, store
npm run test:e2e    # Playwright, builds and boots two servers
```

The e2e suite spins up a **second server on `PORT+1` with no `CMS_WEBHOOK_URL`** — the same
arrangement as `npm run demo:no-webhook` — because that env var is fixed for a process's
lifetime; you can't toggle push invalidation per test. That's how Test 9 is verified honestly
rather than simulated.

| Spec | Covers |
|---|---|
| [failure-modes.spec.ts](../tests/e2e/failure-modes.spec.ts) | Tests 2–3: healthy, slow, down, hang, corrupt |
| [prewarm.spec.ts](../tests/e2e/prewarm.spec.ts) | Test 0, from a genuinely cold server |
| [cdn-headers.spec.ts](../tests/e2e/cdn-headers.spec.ts) | Tests 5 and 7 |
| [push-invalidation.spec.ts](../tests/e2e/push-invalidation.spec.ts) | Test 8, including both auth rejections |
| [corrections.spec.ts](../tests/e2e/corrections.spec.ts) | Test 9 — all three propagation triggers, independently |
| [toolbar.spec.ts](../tests/e2e/toolbar.spec.ts) | The browser toolbar renders every mode |

`npm run test:e2e` needs a Chromium binary; if you see `Executable doesn't exist`, run
`npx playwright install chromium` first. Only `toolbar.spec.ts` requires a browser — the rest
drive HTTP directly.

---

## If something looks wrong

| Symptom | Cause |
|---|---|
| `error: no server on http://localhost:3000` | Nothing is serving that port. `npm run demo` in another terminal — or you overrode `PORT` in only one of the two |
| Everything is `HIT`, you never see `STALE` | The refresher keeps entries under 1s about half the time. Fire several 0.5s apart: `./scripts/demo.sh stale` |
| `breaker` always says `closed` | Expected — the refresher heals it within seconds. Use `./scripts/demo.sh logs breaker` instead (Test 4) |
| `logs breaker` and `logs warn` are empty | Warn lines go to stderr. `serve` tees with `2>&1`; a hand-rolled `npm run start \| tee` drops them |
| A correction doesn't appear instantly | `CMS_WEBHOOK_URL` or `REVALIDATE_SECRET` isn't set — check [.env.example](../.env.example) and any `.env` you made. It'll still arrive within ~2s via the refresher, which is Test 9's whole point |
| Revalidate returns 401 with the right secret | The header is `x-revalidate-secret`, and the server's `REVALIDATE_SECRET` must match the one the script is using — same `.env` for both terminals |
| `stale slow` returns 5ms STALEs, not ~400ms | The breaker is open from an earlier test, so no call is attempted. Wait ~5s |
| A 404 comes back as 503 | The breaker is open. Wait ~5s and retry — see Test 6 |
| Versions reset to v1 | Corrections live in an in-memory mock CMS. Restarting the server resets them |
| Two servers fight over a port | Every process needs its own `PORT`; the CMS base URL derives from it. `--no-webhook` handles the second one for you |
