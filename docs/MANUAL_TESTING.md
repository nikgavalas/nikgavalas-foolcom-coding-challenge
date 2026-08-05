# Manual testing & live demo runbook

A script for driving the system by hand and watching each piece work. Every command below was
run against a real server and the outputs are the ones actually observed — if you get
something different, that's a signal, not a typo.

Pair this with [ARCHITECTURE.md](ARCHITECTURE.md); the exercises are numbered to match its
scenarios where they line up.

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

That's the whole setup. Every exercise below is one command from that help output.

**Config** lives in [.env.example](../.env.example), which documents all four env vars and holds
no secrets. `cp .env.example .env` if you want to change something; the script falls back to the
same values, so the demo works with no `.env` at all. Any var can be overridden inline
(`PORT=3005 ./scripts/demo.sh peek`), and `--no-webhook` is a global flag that points any command
at the second server used in Exercise 9.

Two things worth knowing about the setup, because they're both talking points:

- `npm run demo` sets `REVALIDATE_SECRET` and derives `CMS_WEBHOOK_URL` from `PORT`. Without
  both, push invalidation is off — deny-by-default, not "auth disabled" — and you'd be demoing
  the refresher instead. That's Exercise 9, on purpose.
- It always serves a **production build**. Dev-mode timing (on-demand compilation, no
  minification) is not representative of the latency behavior on show here.

### The four seeded articles

All four are prewarmed at boot. The script drives the first one by default; `./scripts/demo.sh
articles` lists them all.

```bash
./scripts/demo.sh articles
```

```
  investing/2026/07/22/should-you-buy-spacex-stock-before-aug-4
  investing/2026/07/22/prediction-meta-platforms-will-soar-on-july-29-whe
  investing/2026/07/23/invest-10000-nvidia-stock-10-years-ago-how-much
  investing/2026/07/22/this-stock-is-crushing-both-lucid-and-rivian-in
```

### The browser toolbar

Open `http://localhost:3000`, then any article. A floating toolbar at the bottom gives you the
five failure modes as links and a **publish correction** button. It's the fastest way to demo
live — the commands below are the same thing, with the numbers visible.

---

## Exercise 0 — Prewarm filled the cache before you asked for anything

Do this **first**, before any page request. It's the most easily missed piece.

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

**Say:** four articles cached, and nobody has visited the site yet. `instrumentation.ts` fetched
the CMS index at boot and warmed every article. It's fire-and-forget, so a dead CMS at startup
delays nothing and crashes nothing.

```bash
./scripts/demo.sh logs prewarm
```

```json
{"outcome":"ok","articleCount":4,"durationMs":313,...,"message":"prewarm_run"}
```

---

## Exercise 1 — The happy path (scenario 1)

```bash
./scripts/demo.sh peek
```

```
http=200 time=0.164445s HIT         age=19ms   v1
```

**Say:** served from memory, from an entry 19ms old. No CMS call happened at all — confirm with
`./scripts/demo.sh logs reads`: you'll see `cache_read` with `status:"HIT"` and *no* accompanying
`upstream_call`.

> That 164ms is the **first** request to a freshly booted server — Node is still doing
> first-request work (module loading, JIT). Run it twice; the second is ~5ms, and every
> subsequent number in this doc is a warm one.

---

## Exercise 2 — Every failure mode is invisible while the cache is warm (scenarios 4, 7–9)

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

**This is the headline result.** The CMS is returning 500s, hanging forever, and serving
corrupt JSON — and every response is a 200 with correct content in under 10ms. While an entry
is inside its 1-second fresh window we simply never contact the CMS, so its state is
irrelevant.

Note `healthy` is the *slowest* of the five, because it's the only one that could have talked to
the CMS at all. Good line to land.

---

## Exercise 3 — Catching a STALE serve (scenarios 5, 7)

To see the interesting path you need the entry to be older than the 1s fresh window. The
background refresher touches every warm key every 2s, so age oscillates 0–2s and roughly half
of your requests will land stale. `stale` just fires several 0.5s apart:

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

**Say:** the STALE ones are where the entry had aged past 1s, so we attempted a refresh, the
CMS returned a 500, and we served the old copy anyway — **the failed response did not overwrite
the entry**. Version is still correct. Cost: ~220ms instead of 7ms.

Now show the log proving it:

```bash
./scripts/demo.sh logs '"status":"STALE"'
```

```json
{"path":"investing/...","caller":"read","status":"STALE","ageMs":1367,
 "upstreamOutcome":"http_error","circuitState":"open","version":1,...}
```

One line contains the whole story: what we served, how old it was, what the upstream said, and
what the breaker thought.

> **Why ~220ms and not ~110ms?** The Proxy reads the cache (to decide 200 vs 503) and *then* the
> page reads it. They're sequential, so a stale page view makes two upstream attempts of ~100ms
> each. `generateMetadata` and the page component *are* concurrent and do collapse into one.

### To demo `slow` specifically

```bash
./scripts/demo.sh stale slow 4
```

```
http=200 time=0.004975s HIT         age=489ms  v1
http=200 time=0.823800s STALE       age=1896ms v1
http=200 time=0.421614s HIT         age=234ms  v1
```

The CMS takes 8 seconds; the STALE serve comes back in **~400ms per cache read**. That's the
bounded wait: we give a refresh 400ms to land, then stop waiting. The refresh keeps running in
the background and its result lands for the next reader — which is why the *following* request
is a 421ms `HIT` rather than another stale one.

> Run this on a **closed** breaker. If you just ran Exercise 4, the circuit is open, so we don't
> even attempt the call and you'll see 5ms STALEs instead of the bounded wait. Wait ~5s.

---

## Exercise 4 — Tripping the circuit breaker (scenario 6)

```bash
./scripts/demo.sh trip
```

```
==> six failing reads
breaker: closed
```

**Expect to catch this in the logs rather than in the state.** Three consecutive failures open
it for 5s, but the background refresher — which never sends `?source=`, so it talks to the
*real* CMS — succeeds every 2s and resets the counter, then closes the circuit on its first
post-cooldown probe. So the poll usually reads `closed` by the time it runs.

```bash
./scripts/demo.sh logs breaker
```

```json
{"from":"closed","to":"open","failureCount":3,...,"level":"warn","message":"circuit_transition"}
```

That's the point worth making: **the system heals itself without any user request needing to
discover the recovery.**

> These are `warn`-level lines, which `logger` writes to **stderr**. `./scripts/demo.sh serve`
> tees with `2>&1` for exactly this reason — pipe stdout alone and every breaker transition
> vanishes from the log.

---

## Exercise 5 — The one case with no good answer: 503 (scenario 10)

A path that has never been cached, against a failing CMS. Nothing to fall back on.

```bash
./scripts/demo.sh cold
```

```
==> GET /articles/never-cached/demo-84027-28112?source=down
HTTP/1.1 503 Service Unavailable
cache-control: no-store
```

**Say:** two deliberate choices. **503, not 200** — a 200 would be cached at the edge and the
outage served to every reader for the full 60s TTL. And `no-store` so no layer anywhere retains
the error page. A page component can't set a status code, which is why this lives in
[proxy.ts](../proxy.ts).

---

## Exercise 6 — A real 404, and the negative cache (scenario 11)

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

**Two requests, one upstream call.** The second was answered entirely from the 30s negative
cache — it produced no log lines at all, because it short-circuits before the policy engine.
That's what stops a bad link from generating one CMS call per crawler hit.

Note also that a 404 counts as a breaker **success**: the CMS answered, it just answered "no."

> **Gotcha worth demoing on purpose:** run this *while the breaker is open* and you get **503,
> not 404**. With the circuit open we never ask, so we can't tell "doesn't exist" from "can't
> reach the CMS." 503 is the honest answer, and it isn't cached — the next request after the
> circuit closes returns a real 404. You can see it in the log line: `status: "UNAVAILABLE"`
> with `circuitState: "open"`.

---

## Exercise 7 — CDN headers (the CDN section of ARCHITECTURE.md)

```bash
./scripts/demo.sh headers
```

```
HTTP/1.1 200 OK
cache-control: public, s-maxage=60, stale-while-revalidate=300, stale-if-error=86400
surrogate-key: article-investing-2026-07-22-should-you-buy-spacex-stock-before-aug-4
```

**Say:** no CDN is hooked up, but the policy is already expressed in the vocabulary one would
understand. `s-maxage=60` is deliberately longer than our 1s internal window because edge
invalidation is push-based and the TTL is only a backstop. `stale-if-error=86400` is our
unbounded-stale rule projected one layer out — the site survives even the *origin* going down.
`Surrogate-Key` enables purge-by-tag, so one call catches every URL an article is reachable at.

Then contrast with Exercise 5: errors get `no-store`. Never let an outage become cacheable.

---

## Exercise 8 — Push invalidation, end to end (scenario 12)

First, the auth gate:

```bash
./scripts/demo.sh revalidate
```

```
no secret     -> 401
wrong secret  -> 401
right secret  -> {"path":"investing/...","status":"REVALIDATED","version":1}
```

**Say:** every call here triggers a real upstream fetch, so an open endpoint is a
request-amplification vector. Constant-time compare, and a missing secret means deny, not
"auth off."

Now the real thing — publish a correction and read immediately:

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

**v2 on the very next request**, and it's a `HIT` — the cache was already updated before the
read arrived. `propagationLagMs: 105` is the wall-clock gap between the CMS stamping `updatedAt`
and us observing the new version. Tagged with `trigger`, so a silently broken webhook shows up
as traffic shifting from `push` to `refresher` — you'd see the *lag* regress without anything
erroring. (The second line is the read path independently confirming the same version; both are
logged because both observed the change. `correct` publishes and reads back-to-back, so which of
the two wins the race varies run to run — if you see `trigger:"read"` first, the webhook simply
landed a few ms later. Either way the reader got v2.)

Then the closer:

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

All five return **v2**, all under 10ms. The correction propagated, and it survives every
failure mode.

---

## Exercise 9 — Proving push is an optimization, not a dependency (scenario 13)

**This is the most important exercise in the doc.** A dropped webhook should be a regression in
speed, not accuracy. Prove it by running a server with push turned off. In a third terminal:

```bash
npm run demo:no-webhook        # PORT+1, no CMS_WEBHOOK_URL, its own log
```

Then, back in the second terminal — `--no-webhook` points every command at that server:

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

**Say:** no webhook fired — yet the cache corrected itself before anyone asked for the page,
because the background refresher re-probes every warm article every 2s. `trigger:"refresher"`,
not `"push"`. Push buys you ~105ms instead of up to ~2s. It doesn't buy you correctness; the
refresher already guarantees that.

To make the "nobody requested it" part airtight, publish and *don't* read:

```bash
curl -s -X POST "http://localhost:3001/api/cms/admin?publish-correction=$(
  ./scripts/demo.sh --no-webhook articles | head -1 | tr -d ' ')"
sleep 3
./scripts/demo.sh --no-webhook logs versions
```

The `version_changed` line is there with no `caller:"read"` anywhere near it.

---

## Exercise 10 — Reading the instrumentation

Three surfaces. Know which one answers which question.

### 1. Structured logs (stdout + stderr, JSON lines)

Every log line is one JSON object. In production these ship to a log aggregator; here,
`./scripts/demo.sh logs` greps them. Named filters:

```bash
./scripts/demo.sh logs reads        # what we served and why
./scripts/demo.sh logs upstream     # every CMS call, with outcome + duration
./scripts/demo.sh logs warn         # failures only
./scripts/demo.sh logs breaker      # breaker state changes
./scripts/demo.sh logs versions     # correction propagation, with lag
./scripts/demo.sh logs prewarm      # the boot-time warm
./scripts/demo.sh logs background   # prewarm + the last few refresh cycles
```

Anything else is treated as a raw pattern, e.g. `./scripts/demo.sh logs '"status":"STALE"'`.

If you have `jq`, this is the money command — a live tail of exactly what the cache is doing
for real readers:

```bash
./scripts/demo.sh tail
```

It filters to `caller=="read"` deliberately: the refresher logs every 2s, so an unfiltered tail
is too noisy to demo against.

Field glossary: `caller` is one of `read` / `refresher` / `push` / `prewarm` — it's what keeps
background traffic out of your user-facing latency percentiles. `status` is the five cache
outcomes. `circuitState` is the breaker at the moment of that read.

### 2. `/api/_internal/cache-stats`

```bash
./scripts/demo.sh stats
```

Answers the four operational questions at a glance:

| Question | Field |
|---|---|
| Is the upstream healthy? | `circuitBreaker.state`, plus `upstream_calls` counters by outcome |
| How stale is anything? | `articleCache.maxAgeMs`, and per-entry `ageMs` |
| What version is cached? | per-entry `version` |
| How is the cache performing? | `metrics.counters` / `metrics.histograms` |

No upstream I/O and no auth — it only reads state that's already in memory. It uses a
non-mutating `peekEntries()` so that *looking* at the cache never perturbs LRU order.

The two slices worth pulling out of that blob:

```bash
./scripts/demo.sh metrics
```

Real output after walking the exercises above:

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

Note how cleanly `caller` separates background probing from real reads. That separation is why
the refresher's 83 revalidations don't pollute the user-facing health signal — and the
`timeout` row is the `hang` mode hitting the 2s upstream timeout, visible without any user ever
seeing a slow page.

### 3. `data-cache-status` in the HTML

This is what `peek` reads. A server component can't set response headers, so the cache status
rides on the rendered `<article>` element instead. In the browser, inspect the article element
and you'll see it change as you click through the toolbar. It's also what the e2e tests assert
on.

```bash
DEMO_VERBOSE=1 ./scripts/demo.sh peek down     # prints the underlying curl
```

---

## Automated tests

```bash
npm run test        # unit tests, ~0.3s — cache policy, breaker, validator, store
npm run test:e2e    # Playwright, builds and boots two servers
```

The e2e suite spins up a **second server on `PORT+1` with no `CMS_WEBHOOK_URL`** — the same
arrangement as `npm run demo:no-webhook` — because that env var is fixed for a process's
lifetime; you can't toggle push invalidation per test. That's how Exercise 9 is tested honestly
rather than simulated.

| Spec | Covers |
|---|---|
| [failure-modes.spec.ts](../tests/e2e/failure-modes.spec.ts) | Exercises 2–3: healthy, slow, down, hang, corrupt |
| [prewarm.spec.ts](../tests/e2e/prewarm.spec.ts) | Exercise 0, from a genuinely cold server |
| [cdn-headers.spec.ts](../tests/e2e/cdn-headers.spec.ts) | Exercises 5 and 7 |
| [push-invalidation.spec.ts](../tests/e2e/push-invalidation.spec.ts) | Exercise 8, including both auth rejections |
| [corrections.spec.ts](../tests/e2e/corrections.spec.ts) | Exercise 9 — all three propagation triggers, independently |
| [toolbar.spec.ts](../tests/e2e/toolbar.spec.ts) | The browser toolbar renders every mode |

---

## Troubleshooting the demo

| Symptom | Cause |
|---|---|
| `error: no server on http://localhost:3000` | Nothing is serving that port. `npm run demo` in another terminal — or you overrode `PORT` in only one of the two |
| Everything is `HIT`, you never see `STALE` | The refresher keeps entries under 1s about half the time. Fire several 0.5s apart: `./scripts/demo.sh stale` |
| `breaker` always says `closed` | Expected — the refresher heals it within seconds. Use `./scripts/demo.sh logs breaker` instead |
| `logs breaker` and `logs warn` are empty | Warn lines go to stderr. `serve` tees with `2>&1`; a hand-rolled `npm run start \| tee` drops them |
| A correction doesn't appear instantly | `CMS_WEBHOOK_URL` or `REVALIDATE_SECRET` isn't set — check [.env.example](../.env.example) and any `.env` you made. It'll still arrive within ~2s via the refresher, which is Exercise 9's whole point |
| Revalidate returns 401 with the right secret | The header is `x-revalidate-secret`, and the server's `REVALIDATE_SECRET` must match the one the script is using — same `.env` for both terminals |
| `stale slow` returns 5ms STALEs, not ~400ms | The breaker is open from a previous exercise, so no call is attempted. Wait ~5s |
| A 404 comes back as 503 | The breaker is open. Wait ~5s and retry — see Exercise 6 |
| Versions reset to v1 | Corrections live in an in-memory mock CMS. Restarting the server resets them |
| Two servers fight over a port | Every process needs its own `PORT`; the CMS base URL derives from it. `--no-webhook` handles the second one for you |
