import { NextRequest, NextResponse } from "next/server";

import { publishCorrection } from "@/lib/cmsMock";

export async function POST(request: NextRequest): Promise<NextResponse> {
  const path = request.nextUrl.searchParams.get("publish-correction");

  if (!path) {
    return NextResponse.json(
      { error: "Missing publish-correction=<article path> query param" },
      { status: 400 },
    );
  }

  const article = publishCorrection(path);

  if (!article) {
    return NextResponse.json(
      { error: `No article at path: ${path}` },
      { status: 404 },
    );
  }

  // Step 9 push invalidation: simulates the real CMS calling our webhook the
  // instant a correction is published. Fire-and-forget and error-swallowed —
  // this is correction-publishing glue, not failure-mode logic, so a slow or
  // failing webhook must never affect the admin response.
  const webhookUrl = process.env.CMS_WEBHOOK_URL;
  if (webhookUrl) {
    void fetch(`${webhookUrl}?path=${encodeURIComponent(path)}`, {
      method: "POST",
      headers: { "x-revalidate-secret": process.env.REVALIDATE_SECRET ?? "" },
    }).catch(() => {});
  }

  return NextResponse.json({
    published: article.path,
    version: article.version,
    updatedAt: article.updatedAt,
  });
}
