# How I approached this

This file is the narrative — how I read the problem, what I tried, and why the design and process
ended up where they did. [ARCHITECTURE.md](ARCHITECTURE.md) covers *what* the system does — start
there if you want the design itself. [MANUAL_TESTING.md](MANUAL_TESTING.md) covers how to verify it
yourself. This file is the *how I got there*, including the parts of the process that aren't visible
in the diff.

---

## Reading the problem

I started by reading the README end to end and poking at the app in its broken state — hitting each
`?source=` mode to see it fail for real, rather than taking the failure descriptions on faith. From
there I went back and forth with AI quite a bit, researching the option space: where a cache like
this should live, what policies would actually satisfy "stay fast and accurate under failure," what
a real CDN would add on top. That reasoning — the options considered and why each was picked or
rejected — is written up in [DESIGN_OPTIONS.md](DESIGN_OPTIONS.md) rather than repeated here.

## Planning before building

Once I was happy with the direction, I had the AI turn it into
[IMPLEMENTATION_PLAN.md](IMPLEMENTATION_PLAN.md). This is my usual approach to a problem of any
size, AI or not: break it into small, independently reviewable chunks before writing any code. Only
once the chunks were small enough did I have the AI actually implement them, one at a time. The tool
changed; the habit of decomposing first didn't.

## Trying parallel implementation

For this project I wanted to test something I'd been meaning to try: ask the AI which steps of the
plan were actually independent, then spawn separate Claude Code sessions in separate git worktrees
to implement several of them at once instead of strictly one after another. The
[Parallelization section](IMPLEMENTATION_PLAN.md#parallelization) of the implementation plan is
where that dependency graph and wave breakdown live — including the conflicts (lockfile, ports,
shared spec files) I had to plan around to make concurrent worktrees actually safe.

## Writing the architecture and manual testing docs

After the implementation was in place, I wrote [ARCHITECTURE.md](ARCHITECTURE.md) and
[MANUAL_TESTING.md](MANUAL_TESTING.md) — partly to communicate what was built, and partly as a way
of fact-checking it against what I'd actually asked for. I didn't write either by hand, but I
dictated most of the content myself and read and iterated on the drafts a lot. That process was
genuinely useful: it surfaced real bugs, and a couple of spots where the design itself was less
clear than I'd assumed while building it.

## Why I didn't read every line

Because of the limited time I had, I leaned on an idea from a talk by a chemical process engineer
turned software engineer: as a process engineer, you rarely need to see inside the reactor — you
need to know that, given a set of inputs, the outputs are what you expect. You don't always know
exactly how the reactor works internally, just that it reliably does.

I applied that here. My effort went into giving the best "inputs" — detailed instructions and a plan
I'd already thought through — and then into writing rigorous automated tests plus a very detailed
manual testing pass to confirm the "reactor" produces the right outputs. I did not read every line of
the implementation.

I want to be direct about the tradeoff that represents. If this were a real production system, I
would not take this approach. This cache would end up driving a large part of the site, which is
exactly the kind of critical path that deserves real scrutiny — I'd want to be much more involved in
the implementation itself, not just its inputs and outputs, and I'd move a lot slower than I did
here. The reactor approach was a deliberate choice to fit a time-boxed exercise, not a recommendation
for how this should ship.

## A deliberate addition beyond the brief

I added CDN-facing response headers (`Cache-Control`, `Surrogate-Key`) even though nothing in the
brief asked for them — see [How a CDN fits in](ARCHITECTURE.md#how-a-cdn-fits-in). In a real
deployment that would be part of the design from day one, so I wanted this to reflect that thinking
rather than stop at the literal task list.

## What I'd change for production operation

A couple of things I'd tune before running this for real, beyond the general "review it properly"
point above:

- **Not everything should stay warm.** Right now prewarm and the background refresher treat every
  seeded article the same. At real scale I wouldn't keep the entire catalog warm indefinitely — I'd
  warm and keep refreshing only the most recently accessed or most recently published articles to
  some bounded degree, and let the long tail fall back to the normal cold path.
- **The timeouts are a bit aggressive.** The constants here (`UPSTREAM_TIMEOUT_MS`,
  `REVALIDATE_DEADLINE_MS`, and friends — see [Operating it](ARCHITECTURE.md#operating-it)) were
  tuned for a demo with a fast, predictable mock CMS. Against a real upstream I'd expect to loosen
  several of them.

## Running this yourself

If you change `.env` and want to manually test against it, run `npm run build` before
`npm run demo` — env values are baked in at build time, and `demo.sh serve` only builds when `.next`
doesn't already exist, so it won't pick up an env change on its own. [MANUAL_TESTING.md](MANUAL_TESTING.md)
has the full walkthrough. Separately: I didn't exercise `npm run dev` during this work — that's
something I'd want to try in a real follow-up, but it isn't verified here.

## For what it's worth

I really enjoyed this project. This problem space is deeper than what I've worked on day to day, and
I learned a lot digging into it. Regardless of how the interview goes, I'm glad I got to spend the
time on it.
