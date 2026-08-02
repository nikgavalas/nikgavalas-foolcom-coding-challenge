import { NextRequest } from "next/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/cache/articleCache", () => ({
  revalidatePath: vi.fn(),
}));
vi.mock("@/lib/cache/purgeEdge", () => ({
  purgeEdge: vi.fn(),
}));

import { revalidatePath } from "@/lib/cache/articleCache";
import { purgeEdge } from "@/lib/cache/purgeEdge";
import { POST } from "@/app/api/internal/revalidate/route";

const mockRevalidatePath = vi.mocked(revalidatePath);
const mockPurgeEdge = vi.mocked(purgeEdge);

const SECRET = "test-secret";

function makeRequest(options: { path?: string; secret?: string } = {}): NextRequest {
  const url = new URL("http://localhost:3000/api/internal/revalidate");
  if (options.path !== undefined) url.searchParams.set("path", options.path);

  const headers: Record<string, string> = {};
  if (options.secret !== undefined) headers["x-revalidate-secret"] = options.secret;

  return new NextRequest(url, { method: "POST", headers });
}

describe("POST /api/internal/revalidate", () => {
  const originalSecret = process.env.REVALIDATE_SECRET;

  beforeEach(() => {
    vi.clearAllMocks();
    process.env.REVALIDATE_SECRET = SECRET;
  });

  afterEach(() => {
    if (originalSecret === undefined) {
      delete process.env.REVALIDATE_SECRET;
    } else {
      process.env.REVALIDATE_SECRET = originalSecret;
    }
  });

  it("rejects a request with no secret header", async () => {
    const response = await POST(makeRequest({ path: "a" }));

    expect(response.status).toBe(401);
    expect(mockRevalidatePath).not.toHaveBeenCalled();
  });

  it("rejects a request with the wrong secret", async () => {
    const response = await POST(makeRequest({ path: "a", secret: "wrong" }));

    expect(response.status).toBe(401);
    expect(mockRevalidatePath).not.toHaveBeenCalled();
  });

  it("rejects every request when REVALIDATE_SECRET is unset", async () => {
    delete process.env.REVALIDATE_SECRET;

    const response = await POST(makeRequest({ path: "a", secret: "" }));

    expect(response.status).toBe(401);
    expect(mockRevalidatePath).not.toHaveBeenCalled();
  });

  it("returns 400 when path is missing", async () => {
    const response = await POST(makeRequest({ secret: SECRET }));

    expect(response.status).toBe(400);
    expect(mockRevalidatePath).not.toHaveBeenCalled();
  });

  it("revalidates through the push caller and purges the edge on success", async () => {
    mockRevalidatePath.mockResolvedValue({
      article: { version: 2 } as never,
      status: "REVALIDATED",
      ageMs: 0,
      upstreamOutcome: "ok",
    });

    const response = await POST(makeRequest({ path: "some/path", secret: SECRET }));
    const body = await response.json();

    expect(mockRevalidatePath).toHaveBeenCalledWith("some/path", { caller: "push" });
    expect(mockPurgeEdge).toHaveBeenCalledWith("some/path");
    expect(response.status).toBe(200);
    expect(body).toEqual({ path: "some/path", status: "REVALIDATED", version: 2 });
  });

  it("does not purge the edge when the upstream refresh fails", async () => {
    mockRevalidatePath.mockResolvedValue({
      article: { version: 1 } as never,
      status: "STALE",
      ageMs: 500,
      upstreamOutcome: "http_error",
    });

    const response = await POST(makeRequest({ path: "some/path", secret: SECRET }));

    expect(response.status).toBe(200);
    expect(mockPurgeEdge).not.toHaveBeenCalled();
  });
});
