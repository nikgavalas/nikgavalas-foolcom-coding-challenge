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

  return NextResponse.json({
    published: article.path,
    version: article.version,
    updatedAt: article.updatedAt,
  });
}
