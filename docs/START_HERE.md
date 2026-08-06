# How I approached this

> **Placeholder.** This file is the narrative — how I read the problem, what I tried, what I
> changed my mind about, and why the design ended up where it did. The sections below are a
> skeleton to write into; the italic prompts are notes to myself, not content.
>
> [ARCHITECTURE.md](ARCHITECTURE.md) covers *what* the system does and
> [MANUAL_TESTING.md](MANUAL_TESTING.md) covers how to verify it. This file covers *how I got
> there* — the reasoning, including the parts that didn't survive.

---

## Reading the problem

*What I understood the real requirement to be, past the literal task list. What I decided the
hard part actually was, and what I decided was incidental.*

---

## Where I started

*First thing I did after cloning. What I ran, what I read, what surprised me about the existing
code or the failure modes.*

---

## The design space I considered

*The approaches that were on the table and why. What I ruled out early and on what grounds —
see [DESIGN_OPTIONS.md](DESIGN_OPTIONS.md) for the written-out version of this.*

---

## The decisions that mattered

*The handful of choices the whole design hangs on, each with the alternative I rejected and the
tradeoff I accepted. Candidates: the fresh window vs. the bounded wait, serving stale
indefinitely, 503 instead of a 200 for the uncached-and-failing case, validating upstream
responses before caching them, the refresher existing at all alongside push invalidation.*

---

## What I built, in the order I built it

*The actual sequence, including what I deferred and why. See
[IMPLEMENTATION_PLAN.md](IMPLEMENTATION_PLAN.md) for the plan I was working from and how much of
it survived contact.*

---

## Dead ends and course corrections

*Things I built and backed out, or got wrong the first time. What the failure taught me about the
problem. This is the most interesting section — worth being specific and honest here.*

---

## How I convinced myself it works

*Why I trust the result: what the tests actually assert vs. what I verified by hand, and what
"correct" means for a cache that's allowed to serve old data.*

---

## What I'd do differently with more time

*Known gaps, deliberate omissions, and what I'd reach for first in a real production version —
including anything I'd expect a reviewer to push back on.*

---

## If I were running this in production

*The Datadog conversation: what I'd measure, what I'd actually alert on, what I'd deliberately
leave out, and where this design would need to change under real traffic and multiple instances.*
