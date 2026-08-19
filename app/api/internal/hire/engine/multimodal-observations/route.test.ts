import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

const mocks = vi.hoisted(() => {
  class MockIngestionError extends Error {
    constructor(
      message: string,
      readonly code: string,
      readonly status: number,
    ) {
      super(message);
    }
  }
  return {
    verify: vi.fn(),
    ingest: vi.fn(),
    MockIngestionError,
  };
});

vi.mock("@shared/services/internalServiceAuth", () => ({
  verifyInternalServiceRequest: mocks.verify,
}));
vi.mock(
  "@/modules/hire-multimodal/services/observationIngestionService",
  () => ({
    HireMultimodalObservationIngestionError: mocks.MockIngestionError,
    ingestHireMultimodalObservation: mocks.ingest,
  }),
);

import { POST } from "./route";

const ROUTE_PATH = "/api/internal/hire/engine/multimodal-observations";
const MAX_BODY_BYTES = 128 * 1024;

function request(body: string): NextRequest {
  return new NextRequest(
    "https://hire.example/api/internal/hire/engine/multimodal-observations",
    { method: "POST", body },
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.verify.mockResolvedValue({ ok: true });
  mocks.ingest.mockResolvedValue({ outcome: "processed" });
});

describe("Hire supplemental-observation bridge route", () => {
  it("requires signed internal service authentication before parsing or ingesting", async () => {
    mocks.verify.mockResolvedValueOnce({
      ok: false,
      reason: "invalid-signature",
    });

    const response = await POST(request("{not-json"));

    expect(response.status).toBe(401);
    await expect(response.json()).resolves.toEqual({
      error: "Service authentication failed",
    });
    expect(mocks.ingest).not.toHaveBeenCalled();
  });

  it("returns only a no-store typed acknowledgement", async () => {
    const body = JSON.stringify({ eventId: "event-1" });
    const response = await POST(request(body));

    expect(mocks.verify).toHaveBeenCalledWith({
      method: "POST",
      path: ROUTE_PATH,
      body,
      headers: expect.any(Headers),
    });
    expect(mocks.ingest).toHaveBeenCalledWith({ eventId: "event-1" });
    expect(response.status).toBe(200);
    expect(response.headers.get("Cache-Control")).toBe("no-store");
    await expect(response.json()).resolves.toEqual({
      ok: true,
      outcome: "processed",
    });
  });

  it("fails closed when replay protection is unavailable", async () => {
    mocks.verify.mockResolvedValueOnce({
      ok: false,
      reason: "replay-store-unavailable",
    });

    const response = await POST(request("{}"));

    expect(response.status).toBe(503);
    expect(mocks.ingest).not.toHaveBeenCalled();
  });

  it("keeps bridge conflicts internal and bounded", async () => {
    mocks.ingest.mockRejectedValueOnce(
      new mocks.MockIngestionError("same revision differs", "conflict", 409),
    );

    const response = await POST(request("{}"));

    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toEqual({
      error: "same revision differs",
      code: "conflict",
    });
  });

  it("rejects oversize derived-report bodies before authentication work", async () => {
    const response = await POST(
      request("x".repeat(MAX_BODY_BYTES + 1)),
    );

    expect(response.status).toBe(413);
    expect(mocks.verify).not.toHaveBeenCalled();
    expect(mocks.ingest).not.toHaveBeenCalled();
  });
});
