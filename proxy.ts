import { NextRequest, NextResponse } from "next/server";

import { ARTICLE_UNAVAILABLE_MESSAGE } from "@/lib/articleMessages";
import { toSurrogateKey } from "@/lib/cache/surrogateKey";
import { getArticle } from "@/services/articleService";

// Runs the same in-memory cache read the page will do, so it must share the
// Node.js process (and therefore the globalThis cache singleton) rather than
// an Edge isolate — see lib/cache/store.ts and instrumentation.ts, which
// guard on NEXT_RUNTIME === 'nodejs' for the same reason. The "proxy" file
// convention (replacing "middleware") always runs on Node.js, so no runtime
// export is needed here.
export const config = {
  matcher: ["/articles/:path*"],
};

export async function proxy(request: NextRequest) {
  const path = request.nextUrl.pathname.replace(/^\/articles\//, "");
  const source = request.nextUrl.searchParams.get("source") ?? undefined;

  const { kind } = await getArticle(path, source);

  if (kind === "unavailable") {
    return new NextResponse(
      `<!doctype html><html><body><p>${ARTICLE_UNAVAILABLE_MESSAGE}</p></body></html>`,
      {
        status: 503,
        headers: {
          "Content-Type": "text/html; charset=utf-8",
          "Cache-Control": "no-store",
        },
      },
    );
  }

  if (kind === "not_found") {
    return NextResponse.next();
  }

  const response = NextResponse.next();
  // Anonymous-traffic policy only: this repo has no auth, so nothing here is
  // conditional on a session. The day a session cookie exists, authenticated
  // requests need their own branch — `private, no-store`, with any
  // personalization injected client-side or at the edge — since an
  // unconditional `public` would leak personalized content to shared caches.
  response.headers.set(
    "Cache-Control",
    "public, s-maxage=60, stale-while-revalidate=300, stale-if-error=86400",
  );
  response.headers.set("Surrogate-Key", toSurrogateKey(path));
  return response;
}
