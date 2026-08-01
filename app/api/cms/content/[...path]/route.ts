import { NextRequest, NextResponse } from "next/server";

import {
  CORRUPT_ARTICLE_PAYLOAD,
  getArticleByPath,
  sleep,
} from "@/lib/cmsMock";

const HEALTHY_LATENCY_MS = 100;
const SLOW_LATENCY_MS = 8_000;

type ServeArticle = () => NextResponse;

const modes: Record<
  string,
  (serveArticle: ServeArticle) => Promise<NextResponse>
> = {
  healthy: async (serveArticle) => {
    await sleep(HEALTHY_LATENCY_MS);
    return serveArticle();
  },
  slow: async (serveArticle) => {
    await sleep(SLOW_LATENCY_MS);
    return serveArticle();
  },
  down: async () => {
    await sleep(HEALTHY_LATENCY_MS);
    return NextResponse.json(
      { error: "Internal Server Error" },
      { status: 500 },
    );
  },
  hang: () => new Promise<NextResponse>(() => {}),
  corrupt: async () => {
    await sleep(HEALTHY_LATENCY_MS);
    return NextResponse.json(CORRUPT_ARTICLE_PAYLOAD);
  },
};

type RouteContext = { params: Promise<{ path: string[] }> };

export async function GET(
  request: NextRequest,
  context: RouteContext,
): Promise<NextResponse> {
  const source = request.nextUrl.searchParams.get("source") ?? "healthy";
  const { path } = await context.params;

  const serveArticle: ServeArticle = () => {
    const article = getArticleByPath(path.join("/"));
    return article
      ? NextResponse.json(article)
      : NextResponse.json({ error: "Not Found" }, { status: 404 });
  };

  const respond = modes[source] ?? modes.healthy;
  return respond(serveArticle);
}
