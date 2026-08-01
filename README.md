# Fool.com Coding Challenge

Article pages on [Fool.com](https://www.fool.com) serve millions of hits a month. They must stay fast and render accurate content even when an upstream service is slow, down, or hanging.

This coding exercise is a small, self-contained slice of that problem. Work the way you normally would, and feel free to use AI tools (Cursor, Claude Code, etc.). We use them daily ourselves.

## Repository

This repo is a self-contained exercise:

1. **The app**: a Next.js App Router app written in TypeScript. Article pages are served through a catch-all route at `/articles/[...slug]`, e.g. `/articles/investing/2026/07/23/invest-10000-nvidia-stock-10-years-ago-how-much`. Like the real Fool.com, the page is a dynamic async server component that fetches article content from an upstream CMS API on every request.
2. **The upstream CMS API** (`/api/cms/...`): a mocked version of an internal API the real site depends on. It runs locally inside this repo, and it can reproduce the ways a real upstream fails.

### Failure modes

The CMS mocks upstream failures on demand via a `?source=<mode>` query param on any article page URL, which the page forwards to the CMS fetch:

```bash
curl "localhost:3000/articles/<path>?source=hang"
```

| Mode      | Behavior                                              |
| --------- | ----------------------------------------------------- |
| (none)    | Responds normally                                     |
| `slow`    | Responds successfully, after several seconds          |
| `down`    | Returns 500 errors                                    |
| `hang`    | Never responds                                        |
| `corrupt` | Returns structurally-valid JSON that isn't a real article. Deciding how to validate article content is your call |

The page forwards `source` to the CMS request (see `services/articleService.ts`). Keep that intact as you make edits, or the failure modes will stop doing anything.

### Publishing a correction

The CMS also lets you publish a correction to an article. This mutates its content, bumping the article's `version` and `updatedAt`:

```bash
curl -X POST "localhost:3000/api/cms/admin?publish-correction=<path>"
```

## Your Task

The current implementation only works when the upstream is healthy. Try the failure modes to see for yourself, then complete the following items:

1. Add a custom backend/app level caching layer somewhere in the system. Where it lives, what it stores, and how it's designed are your call. We run Next.js self-hosted, so for the purpose of this exercise, don't lean on `use cache` or Next's other built-in caching. We want to see your cache design from scratch. If your design calls for Redis or similar, use an in-memory version rather than spinning up real infrastructure. (`?source=` is test tooling, not part of an article's identity, so don't factor it into your cache key.)
2. Make the page stay fast and keep serving article content under every [failure mode](#failure-modes): `slow`, `down`, `hang`, and `corrupt`.
3. [Publish a correction](#publishing-a-correction) to an article, then repeat step 2. The corrected version is what readers and crawlers should get, not the old copy and not an error.
4. Add observability. No real Datadog/APM integration needed, but from the app's logs or metrics alone, someone operating it should be able to answer:

- Is the upstream healthy, slow, or failing right now?
- Was this page served from cache or fetched fresh?
- Did a correction propagate, and when?
  Be ready to discuss how you'd handle this in production with Datadog: what you'd measure, what you'd alert on, and what you'd leave out.

Ground rules:

- No need to deploy; run via `npm run dev` or `npm run build` + `npm run start` locally.
- Don't use any real infrastructure.
- Don't modify or change any of the internal mocked failure mode logic.

## How We'll Check It

Load each article and failure mode (`?source=hang`, `down`, `slow`, `corrupt`) and
confirm a fast response with accurate article content. Then
[publish a correction](#publishing-a-correction) and do the same again — every
response should now be the corrected version, still fast under every failure mode.

## Getting Started

```bash
npm install
npm run dev
```

Open [http://localhost:3000](http://localhost:3000). The home page links to the seeded articles.

## Submitting

Push your work to a public repo (or zip the repo) and send it back to us. We'll walk through your decisions together in a follow-up conversation.
