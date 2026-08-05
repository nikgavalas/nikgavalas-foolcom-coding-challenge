# Manual testing & live demo runbook

A script for driving the system by hand and watching each piece work. Every command below was
run against a real server and the outputs are the ones actually observed — if you get
something different, that's a signal, not a typo.

Pair this with [ARCHITECTURE.md](ARCHITECTURE.md); the exercises are numbered to match its
scenarios where they line up.

---

## Setup

### One-time

```bash
npm ci
npm run build          # always demo the production build — dev-mode timing is not representative
```

### Start the demo server

The three env vars matter. Without `REVALIDATE_SECRET` and `CMS_WEBHOOK_URL`, push
invalidation is off (deny-by-default, not "auth disabled") and you'll be demoing the
refresher instead.

```bash
PORT=3000 \
REVALIDATE_SECRET=demo-secret \
CMS_WEBHOOK_URL=http://localhost:3000/api/internal/revalidate \
npm run start | tee /tmp/demo.log
```

Piping through `tee` matters — the structured logs *are* the observability story, and you'll
want to grep them mid-demo.

### Shell helpers

Paste these into a second terminal. Everything below assumes them.

```bash
export P=investing/2026/07/22/should-you-buy-spacex-stock-before-aug-4
export B=http://localhost:3000

# status + timing + cache status + version, in one line
peek() {
  curl -s -o /tmp/o.html -w "http=%{http_code} time=%{time_total}s " "$B/articles/$P${1:+?source=$1}"
  echo "$(grep -o 'data-cache-status="[A-Z]*" data-cache-age="[0-9]*"' /tmp/o.html) $(grep -o 'v<!-- -->[0-9]*' /tmp/o.html | head -1 | sed 's/<!-- -->//')"
}

stats() { curl -s "$B/api/_internal/cache-stats" | python3 -m json.tool; }
breaker() { curl -s "$B/api/_internal/cache-stats" | python3 -c "import sys,json;print(json.load(sys.stdin)['circuitBreaker']['state'])"; }
```

> The `v<!-- -->2` weirdness is React splitting the `v` prefix and the number into two text
> nodes. The `sed` cleans it up.

### The four seeded articles

All four are prewarmed at boot. `$P` above is the first one. Get the full list with
`curl -s $B/api/cms/content | python3 -m json.tool`.

### The browser toolbar

Open `http://localhost:3000/articles/$P`. A floating toolbar at the bottom gives you the five
failure modes as links and a **publish correction** button. It's the fastest way to demo
live — the curl commands below are the same thing, with the numbers visible.

---

## Exercise 0 — Prewarm filled the cache before you asked for anything

Do this **first**, before any page request. It's the most easily missed piece.

```bash
stats
```

```json
"circuitBreaker": { "state": "closed" },
"articleCache": {
  "entryCount": 4,
  "maxAgeMs": 563,
  "entries": [ { "path": "investing/...spacex...", "ageMs": 563, "version": 1 }, ... ]
}
```

**Say:** four articles cached, and nobody has visited the site yet. `instrumentation.ts` fetched
the CMS index at boot and warmed every article. It's fire-and-forget, so a dead CMS at startup
delays nothing and crashes nothing.

```bash
grep prewarm_run /tmp/demo.log
```

```json
{"outcome":"ok","articleCount":4,"durationMs":309,...,"message":"prewarm_run"}
```

---

## Exercise 1 — The happy path (scenario 1)

```bash
peek
```

```
http=200 time=0.055392s data-cache-status="HIT" data-cache-age="689" v1
```

**Say:** served from memory in 55ms, from an entry 689ms old. No CMS call happened at all —
confirm by watching `/tmp/demo.log`: you'll see `cache_read` with `status:"HIT"` and *no*
accompanying `upstream_call`.

---

## Exercise 2 — Every failure mode is invisible while the cache is warm (scenarios 4, 7–9)

```bash
for m in healthy slow down hang corrupt; do printf "%-8s " $m; peek $m; done
```

```
healthy  200 0.110036s data-cache-status="HIT" ... v1
slow     200 0.004703s data-cache-status="HIT" ... v1
down     200 0.004626s data-cache-status="HIT" ... v1
hang     200 0.004496s data-cache-status="HIT" ... v1
corrupt  200 0.004687s data-cache-status="HIT" ... v1
```

**This is the headline result.** The CMS is returning 500s, hanging forever, and serving
corrupt JSON — and every response is a 200 with correct content in under 5ms. While an entry
is inside its 1-second fresh window we simply never contact the CMS, so its state is
irrelevant.

Note `healthy` is the *slowest* of the five (110ms), because it's the only one that actually
talked to the CMS. Good line to land.

---

## Exercise 3 — Catching a STALE serve (scenarios 5, 7)

To see the interesting path you need the entry to be older than the 1s fresh window. The
background refresher touches every warm key every 2s, so age oscillates 0–2s and roughly half
of your requests will land stale. Just fire a few:

```bash
for i in $(seq 8); do peek down; sleep 0.5; done
```

```
http=200 time=0.007480s data-cache-status="HIT"   ...
http=200 time=0.232393s data-cache-status="STALE" ...
http=200 time=0.229292s data-cache-status="STALE" ...
http=200 time=0.012934s data-cache-status="HIT"   ...
http=200 time=0.225455s data-cache-status="STALE" ...
```

**Say:** the STALE ones are where the entry had aged past 1s, so we attempted a refresh, the
CMS returned a 500, and we served the old copy anyway — **the failed response did not overwrite
the entry**. Version is still correct. Cost: ~230ms instead of 5ms.

Now show the log proving it:

```bash
grep -m1 '"status":"STALE"' /tmp/demo.log
```

```json
{"path":"investing/...","caller":"read","status":"STALE","ageMs":1159,
 "upstreamOutcome":"http_error","circuitState":"closed","version":1,...}
```

One line contains the whole story: what we served, how old it was, what the upstream said, and
what the breaker thought.

> **Why ~230ms and not ~110ms?** The Proxy reads the cache (to decide 200 vs 503) and *then* the
> page reads it. They're sequential, so a stale page view makes two upstream attempts of ~100ms
> each. `generateMetadata` and the page component *are* concurrent and do collapse into one.

### To demo `slow` specifically

Same command with `slow` instead of `down`. The CMS takes 8 seconds; you'll get **STALE at
~400ms**. That's the bounded wait: we give a refresh 400ms to land, then stop waiting. The
refresh keeps running in the background and its result lands for the next reader.

---

## Exercise 4 — Tripping the circuit breaker (scenario 6)

```bash
grep circuit_transition /tmp/demo.log
```

```json
{"from":"closed","to":"open","failureCount":3,...,"level":"warn","message":"circuit_transition"}
```

**Expect to catch this in the logs rather than in `breaker`.** Three consecutive failures open
it for 5s, but the background refresher — which never sends `?source=`, so it talks to the
*real* CMS — succeeds every 2s and resets the counter, then closes the circuit on its first
post-cooldown probe. So `breaker` usually reads `closed` by the time you poll.

That's the point worth making: **the system heals itself without any user request needing to
discover the recovery.**

If you want to catch `open` live, run the loop and poll in the same breath:

```bash
for i in $(seq 6); do peek down > /dev/null; done; breaker
```

---

## Exercise 5 — The one case with no good answer: 503 (scenario 10)

A path that has never been cached, against a failing CMS. Nothing to fall back on.

```bash
curl -sI "$B/articles/never-cached/demo-$(date +%s)?source=down" | grep -iE "^HTTP|cache-control"
```

```
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
curl -s -o /dev/null -w "%{http_code}\n" "$B/articles/nope/not-a-real-article"   # 404
curl -s -o /dev/null -w "%{http_code}\n" "$B/articles/nope/not-a-real-article"   # 404
grep 'nope/not-a-real-article' /tmp/demo.log
```

```json
{"path":"nope/not-a-real-article","caller":"read","outcome":"not_found","durationMs":103,...}
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
curl -sI "$B/articles/$P" | grep -iE "^HTTP|cache-control|surrogate"
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
curl -s -o /dev/null -w "no secret  -> %{http_code}\n" -X POST "$B/api/internal/revalidate?path=$P"
curl -s -X POST -H "x-revalidate-secret: demo-secret" "$B/api/internal/revalidate?path=$P"; echo
```

```
no secret  -> 401
{"path":"investing/...","status":"REVALIDATED","version":1}
```

**Say:** every call here triggers a real upstream fetch, so an open endpoint is a
request-amplification vector. Constant-time compare, and a missing secret means deny, not
"auth off."

Now the real thing — publish a correction and read immediately:

```bash
curl -s -X POST "$B/api/cms/admin?publish-correction=$P"; echo
peek
```

```
{"published":"investing/...","version":2,"updatedAt":"2026-08-03T00:35:59.635Z"}
http=200 time=0.010s data-cache-status="HIT" data-cache-age="12" v2
```

**v2 on the very next request**, and it's a `HIT` — the cache was already updated before the
read arrived. The propagation metric:

```bash
grep version_changed /tmp/demo.log | tail -2
```

```json
{"path":"...","oldVersion":1,"newVersion":2,"trigger":"push","propagationLagMs":105,...}
```

`propagationLagMs: 105` is the wall-clock gap between the CMS stamping `updatedAt` and us
observing the new version. Tagged with `trigger`, so a silently broken webhook shows up as
traffic shifting from `push` to `refresher` — you'd see the *lag* regress without anything
erroring.

Then the closer:

```bash
for m in healthy slow down hang corrupt; do printf "%-8s " $m; peek $m; done
```

All five return **v2**, all under ~110ms. The correction propagated, and it survives every
failure mode.

---

## Exercise 9 — Proving push is an optimization, not a dependency (scenario 13)

**This is the most important exercise in the doc.** A dropped webhook should be a regression in
speed, not accuracy. Prove it by running a server with push turned off.

```bash
# second terminal, no CMS_WEBHOOK_URL at all
PORT=3001 npm run start | tee /tmp/nowebhook.log
```

```bash
curl -s -X POST "http://localhost:3001/api/cms/admin?publish-correction=$P"; echo
# now make NO article requests at all
sleep 3
grep version_changed /tmp/nowebhook.log
```

```json
{"path":"investing/...","oldVersion":1,"newVersion":2,"trigger":"refresher",
 "propagationLagMs":1439,"message":"version_changed"}
```

**Say:** no webhook fired, and nobody requested the page — yet the cache corrected itself in
1.4 seconds, because the background refresher re-probes every warm article every 2s. Push
buys you 105ms instead of 1439ms. It doesn't buy you correctness; the refresher already
guarantees that.

Confirm with a read:

```bash
curl -s "http://localhost:3001/articles/$P" | grep -o 'v<!-- -->[0-9]*'   # v2
```

---

## Exercise 10 — Reading the instrumentation

Three surfaces. Know which one answers which question.

### 1. Structured logs (stdout, JSON lines)

Every log line is one JSON object. In production these ship to a log aggregator; here, grep
them. Useful filters:

```bash
grep '"message":"cache_read"'      /tmp/demo.log | tail -5   # what we served and why
grep '"message":"upstream_call"'   /tmp/demo.log | tail -5   # every CMS call, with outcome + duration
grep '"level":"warn"'              /tmp/demo.log             # failures only
grep circuit_transition            /tmp/demo.log             # breaker state changes
grep version_changed               /tmp/demo.log             # correction propagation, with lag
grep -E 'prewarm_run|refresh_cycle' /tmp/demo.log | tail -3   # background jobs
```

If you have `jq`, this is the money command — a live tail of exactly what the cache is doing:

```bash
tail -f /tmp/demo.log | jq -c 'select(.message=="cache_read")
  | {status, ageMs, caller, upstreamOutcome, circuitState, version}'
```

Field glossary: `caller` is one of `read` / `refresher` / `push` / `prewarm` — it's what keeps
background traffic out of your user-facing latency percentiles. `status` is the five cache
outcomes. `circuitState` is the breaker at the moment of that read.

**Demo tip:** the refresher logs every 2s, so an idle tail is noisy. Filter to
`select(.caller=="read")` while you drive requests.

### 2. `/api/_internal/cache-stats`

```bash
stats
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

Useful slices:

```bash
# hit/stale/miss breakdown
curl -s $B/api/_internal/cache-stats | python3 -c \
"import sys,json;[print(c['tags'],c['value']) for c in json.load(sys.stdin)['metrics']['counters'] if c['name']=='cache_reads']"

# upstream latency percentiles by outcome
curl -s $B/api/_internal/cache-stats | python3 -c \
"import sys,json;[print(h['tags'],'p50',h['p50'],'p95',h['p95'],'max',h['max']) for h in json.load(sys.stdin)['metrics']['histograms'] if h['name']=='upstream_latency_ms']"
```

Real output from the run above:

```
{'outcome': 'ok', 'caller': 'prewarm'} 5
{'outcome': 'ok', 'caller': 'refresher'} 108
{'outcome': 'http_error', 'caller': 'read'} 6
```

Note how cleanly `caller` separates background probing from real reads. That separation is why
the refresher's 108 calls don't pollute the user-facing health signal.

### 3. `data-cache-status` in the HTML

```bash
curl -s "$B/articles/$P" | grep -o 'data-cache-status="[A-Z]*" data-cache-age="[0-9]*"'
```

A server component can't set response headers, so the cache status rides on the rendered
`<article>` element instead. In the browser, inspect the article element and you'll see it
change as you click through the toolbar. It's also what the e2e tests assert on.

---

## Automated tests

```bash
npm run test        # 124 unit tests, ~0.3s — cache policy, breaker, validator, store
npm run test:e2e    # Playwright, builds and boots two servers
```

The e2e suite spins up a **second server on `PORT+1` with no `CMS_WEBHOOK_URL`**, because that
env var is fixed for a process's lifetime — you can't toggle push invalidation per test. That's
how Exercise 9 is tested honestly rather than simulated.

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
| Everything is `HIT`, you never see `STALE` | The refresher keeps entries under 1s about half the time. Fire several requests 0.5s apart (Exercise 3) |
| `breaker` always says `closed` | Expected — the refresher heals it within seconds. Look for `circuit_transition` in the logs instead |
| A correction doesn't appear instantly | `CMS_WEBHOOK_URL` or `REVALIDATE_SECRET` isn't set. It'll still arrive within ~2s via the refresher — which is Exercise 9's whole point |
| Revalidate returns 401 with the right secret | The header is `x-revalidate-secret`, and the server's `REVALIDATE_SECRET` must match exactly |
| A 404 comes back as 503 | The breaker is open. Wait ~5s and retry — see Exercise 6 |
| Versions reset to v1 | Corrections live in an in-memory mock CMS. Restarting the server resets them |
| Two servers fight over a port | Every process needs its own `PORT`; the CMS base URL derives from it |
