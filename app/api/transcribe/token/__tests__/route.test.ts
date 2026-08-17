/** @vitest-environment node */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

const mocks = vi.hoisted(() => ({
  fetch: vi.fn(),
  loggerError: vi.fn(),
}));

vi.mock("@shared/middleware/composeApiRoute", () => ({
  composeApiRoute:
    (options: {
      handler: (request: NextRequest, context: unknown) => Promise<Response>;
    }) =>
    async (request: NextRequest) =>
      options.handler(request, {}),
}));

vi.mock("@shared/logger", () => ({
  aiLogger: { error: mocks.loggerError },
}));

import { POST } from "../route";

const originalGrantApiKey = process.env.DEEPGRAM_GRANT_API_KEY;
const originalInferenceApiKey = process.env.DEEPGRAM_API_KEY;

function request(): NextRequest {
  return new NextRequest("https://app.test/api/transcribe/token", {
    method: "POST",
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  process.env.DEEPGRAM_GRANT_API_KEY = "server-only-grant-key";
  process.env.DEEPGRAM_API_KEY = "must-never-be-returned";
  vi.stubGlobal("fetch", mocks.fetch);
});

afterEach(() => {
  vi.unstubAllGlobals();
  if (originalGrantApiKey === undefined)
    delete process.env.DEEPGRAM_GRANT_API_KEY;
  else process.env.DEEPGRAM_GRANT_API_KEY = originalGrantApiKey;
  if (originalInferenceApiKey === undefined)
    delete process.env.DEEPGRAM_API_KEY;
  else process.env.DEEPGRAM_API_KEY = originalInferenceApiKey;
});

describe("POST /api/transcribe/token", () => {
  it("mints a non-cacheable 30-second bearer grant without exposing a provider key", async () => {
    mocks.fetch.mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          access_token: "short-lived.deepgram.jwt",
          expires_in: 30,
        }),
        { status: 200 },
      ),
    );

    const response = await POST(request());

    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    expect(response.headers.get("pragma")).toBe("no-cache");
    await expect(response.json()).resolves.toEqual({
      token: "short-lived.deepgram.jwt",
      tokenType: "bearer",
      expiresIn: 30,
    });
    expect(mocks.fetch).toHaveBeenCalledWith(
      "https://api.deepgram.com/v1/auth/grant",
      expect.objectContaining({
        method: "POST",
        headers: {
          Authorization: "Token server-only-grant-key",
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ ttl_seconds: 30 }),
        cache: "no-store",
      }),
    );
  });

  it("fails closed when the grant credential is absent, even if an inference key exists", async () => {
    delete process.env.DEEPGRAM_GRANT_API_KEY;

    const response = await POST(request());

    expect(response.status).toBe(503);
    await expect(response.json()).resolves.toEqual({
      error: "Deepgram not configured",
    });
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    expect(mocks.fetch).not.toHaveBeenCalled();
  });

  it("fails closed when Deepgram rejects or returns an unsafe grant", async () => {
    mocks.fetch
      .mockResolvedValueOnce(new Response(null, { status: 403 }))
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({ access_token: "not-a-short-grant", expires_in: 31 }),
          { status: 200 },
        ),
      );

    const rejected = await POST(request());
    const malformed = await POST(request());

    expect(rejected.status).toBe(502);
    await expect(rejected.json()).resolves.toEqual({
      error: "Deepgram unavailable",
    });
    expect(malformed.status).toBe(502);
    await expect(malformed.json()).resolves.toEqual({
      error: "Deepgram unavailable",
    });
    expect(mocks.loggerError).toHaveBeenCalled();
  });
});
