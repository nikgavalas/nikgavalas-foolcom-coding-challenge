# Design options and tradeoffs

The approaches considered for the caching layer, and why each was taken or rejected. The chosen
design is described in `ARCHITECTURE.md`; this document is the reasoning behind it.

## The problem in one line

Article pages must stay fast and serve accurate content while the upstream CMS is slow, down,
hanging or returning garbage — and a published correction must still reach readers promptly.

Those two goals pull in opposite directions. **Surviving an outage wants a long-lived cache;
propagating a correction wants a short-lived one.** Every option below is really a different answer
to that tension.

### Measured starting point

| Mode | Behaviour before any caching |
|---|---|
| healthy | 200 in 0.49s |
| `slow` | 200 in **8.05s** |
| `down` | **HTTP 500** |
| `corrupt` | 200, renders literal `{{article.headline}}`, `Updated null`, `v` (null version) |
| `hang` | never returns |

`corrupt` is the most dangerous of the five: it is the only one that returns a *confident, wrong
answer*. The others fail loudly.

---

## A. Where the cache lives

| | Option | Verdict |
|---|---|---|
| **A1** | **Data cache in the service layer** — wrap `getArticle`, store validated `ArticleData` | ✅ **Chosen** |
| A2 | Internal BFF route (`/api/articles/...`) the page fetches from | ✗ |
| A3 | Rendered-HTML cache in middleware | ✗ |
| A4 | Custom `server.js` wrapping Next, full-page cache | ✗ |

**Why A1.** It covers the page, `generateMetadata` and the home index through one seam; it is
framework-agnostic and trivially unit-testable; and it is the only layer at which *"is this a real
article?"* is even a meaningful question. Caching HTML means caching `{{article.headline}}` just as
happily as real content.

**Why not A2.** It adds an HTTP hop and a second failure domain to solve a problem we already have
in-process. It only wins if other consumers — a mobile app, a syndication feed — need the same
resilient read path.

**Why not A3/A4.** Caching rendered HTML is faster (it skips React entirely), but it fails on three
counts: middleware runs in a separate runtime and cannot share memory with the Node render process;
an HTML cache cannot distinguish a good page from one that rendered placeholder text; and it
collapses the moment the page carries anything user-specific. See *Personalization* below — this is
the decision that question turns on.

A3 is not wrong, it is simply a **different layer**. It describes a CDN, which belongs *in front of*
this cache rather than instead of it. See
[How a CDN fits in](ARCHITECTURE.md#how-a-cdn-fits-in) in `ARCHITECTURE.md`.

---

## B. Refresh and serve policy

This is where the actual design lives. The options compose rather than compete.

| | Policy | Survives failure? | Propagates corrections? | Taken |
|---|---|---|---|---|
| B1 | Plain read-through TTL | ✗ on expiry there is nothing to serve | ✓ within TTL | ✗ |
| B2 | Stale-while-revalidate | ✓ serves stale, refreshes behind | ⚠ first request after a correction serves the old copy | ✓ |
| B3 | Stale-if-error | ✓ **this is the durability mechanism** | — | ✓ |
| B4 | Bounded-wait revalidation | ✓ degrades to stale within the deadline | ✓ a healthy refresh lands inside the deadline | ✓ |
| B5 | Single-flight coalescing | ✓ required at this traffic volume | — | ✓ |
| B6 | Circuit breaker | ✓ turns ~400ms/request into ~0 | — | ✓ |
| B7 | Background refresher | ✓ requests never touch upstream | ✓ bounds lag regardless of traffic | ✓ |
| B8 | Push invalidation (CMS webhook) | — | ✓ near-instant | ✓ |

### The two dials

The core idea is that **freshness and durability are separate settings**:

- The **fresh window** (1s) is how much staleness is acceptable when everything is healthy. It is a
  load-shedding dial, and single-flight makes it cheap — a million concurrent readers of one
  article still produce one upstream call.
- The **stale window** is **unbounded**. An entry is only ever overwritten by a successful,
  *validated* response. Nothing else evicts it, because a thirty-second-old article beats a 500.

A 1s TTL looks like "barely a cache" until you separate those. Durability does not come from the
TTL; it comes from B3.

### Why not just B1

B1 is the obvious first answer and it fails the brief outright. At the moment the TTL expires,
`slow` costs a reader 8 seconds and `down` gives them an error page. A TTL cache improves the
*average* case and does nothing for the case the exercise is actually about.

### Why B2 alone is not enough

Pure stale-while-revalidate serves the *old* version to the first reader after a correction. The
stated acceptance check is "publish a correction, then every response should be the corrected
version" — so B2 on its own fails the grading. B4 is what fixes it: with a healthy 100ms upstream,
the refresh lands inside the 400ms deadline and the very next request is already corrected.

### Three refresh triggers, deliberately redundant

| Trigger | Lag | Fails when |
|---|---|---|
| Push invalidation (B8) | ~50ms | webhook misconfigured, dropped, unreachable |
| Background refresher (B7) | ≤2s | process just booted, or key not warm |
| Bounded-wait on read (B4) | next request | no traffic on that path |

Any one satisfies the requirement alone. Push is the fast path; the other two are why a dropped
webhook is a **latency regression rather than a correctness bug**. The correction test suite runs
with the webhook disabled specifically to prove that.

### A note on push invalidation and eviction

The intuitive implementation of "invalidate on publish" deletes the cache entry. That is wrong
here. If a correction is published while the upstream is down, deleting the entry destroys the only
good copy we hold and turns a *slightly stale* page into an *unavailable* one — the failure mode
the whole design exists to prevent. Push therefore **marks stale and attempts a refresh**, and a
failed refresh leaves the old entry serving.

---

## C. Validating `corrupt`

The corrupt payload is structurally valid JSON with the right field names, so a shape check alone
is not sufficient — this is the difference between schema validation and *content* validation.

| Option | Tradeoff |
|---|---|
| **Hand-rolled type guard** ✅ | ~30 lines, no dependency, matches the repo's zero-runtime-dependency posture |
| Zod | Better error messages and composability, but a dependency for a single schema |

Rules applied: required strings non-empty, `version` a positive integer, dates parse, `body` a
non-empty string array, returned `path` matches the requested path, and **no unresolved `{{...}}`
placeholders**. The null fields alone would catch this particular fixture; the placeholder rule is
the one that generalises to a half-rendered CMS template.

**The load-bearing decision is not the rules, it is the consequence:** an invalid payload is
treated exactly like a 500. It is never written to cache, the previous good entry keeps serving,
and a counter increments. Corrupt content stops being a rendering problem and becomes an upstream
health signal.

---

## D. Cold start

Cache empty *and* upstream broken is the one state with no good answer.

| Option | Taken |
|---|---|
| Graceful degraded render (503, `no-store`) | ✓ the floor, always needed |
| **Prewarm on boot** from the CMS index | ✓ makes the bad state nearly unreachable |
| Disk L2 tier — last-known-good surviving restart | ✗ documented only |
| Negative caching for genuine 404s | ✓ small, prevents crawler amplification |

**Why not the disk tier.** It is the honest no-real-infrastructure stand-in for Redis persistence
and it would survive a restart during an outage. It also adds I/O, serialization and staleness
questions for a case prewarm already covers in this exercise. In production this role belongs to
Redis, not to local disk — a per-pod disk cache diverges across replicas.

---

## E. Storage

A `CacheStore` interface with an in-memory LRU implementation. The interface is not speculative
generality — it is the point. It makes "we would use Redis here" a code change rather than a
paragraph, and it is the honest place to note two real limits:

- The cache is **per-process**. Under PM2 cluster mode or multiple pods, each replica keeps its own
  copy and warms independently. That is the concrete argument for Redis, and it also means a
  push invalidation would need fan-out to every replica.
- Next's dev-mode HMR re-evaluates modules, silently resetting a plain module-level `Map`. The
  store is held on `globalThis` to avoid local behaviour diverging from production.

---

## F. Testing

Two runners, because one tool cannot do both jobs well.

| Layer | Tool | Why |
|---|---|---|
| Cache internals | Vitest + fake timers | TTL boundaries, single-flight collapsing, breaker transitions and a 400ms deadline are impossible to test deterministically through a browser |
| Acceptance | Playwright | The criterion is literally "load the page and confirm it is fast and correct" |

Two Playwright choices worth noting. Most assertions run through the **`request` fixture with no
browser at all** — these are server-rendered pages, so the HTML is the product; a browser is
reserved for the toolbar interaction. And the suite runs **single-worker**, because publishing a
correction permanently mutates in-memory CMS state that every test shares.

`data-testid="article-version"` already exists in the starter page, which is a strong hint that
version assertions are the expected acceptance signal.

---

## G. Personalization

Fool.com has subscriber-gated articles and logged-in state. No auth exists in this repo, so nothing
was built for it — but it is the question that retroactively justifies **A1 over A3/A4**.

Because the cache stores `ArticleData` keyed by path and React renders per request, the article
bytes are identical for every reader while entitlement and greetings resolve at render time. The
cache is personalization-safe for free. A full-page HTML cache would have to either vary by user —
collapsing hit rate to nothing — or risk serving one reader's session state to another.

The rule: **cache keys may include entitlement class, never user identity.** Tier has cardinality
3-5; user ID has cardinality in the millions. Wanting to key by user means caching at the wrong
layer.

See point 1 under [How a CDN fits in](ARCHITECTURE.md#how-a-cdn-fits-in) in `ARCHITECTURE.md` for
the consequences at the edge tier, where this constraint actually bites.
