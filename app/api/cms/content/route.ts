import { NextResponse } from "next/server";
import { listArticles, sleep } from "@/lib/cmsMock";

export async function GET(): Promise<NextResponse> {
  await sleep(100);

  const articles = listArticles().map(
    ({ path, headline, summary, author }) => ({
      path,
      headline,
      summary,
      author,
    }),
  );

  return NextResponse.json({ articles });
}
