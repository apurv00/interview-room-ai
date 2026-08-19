import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

const mocks = vi.hoisted(() => {
  class MockIngestionError extends Error {
    constructor(
      message: string,
      readonly code: "not_found" | "conflict" | "digest_mismatch",
      readonly status: number,
    ) {
      super(message);
    }
  }
  return {
    verify: vi.fn(),
    ingest: vi.fn(),
    send: vi.fn(),
    MockIngestionError,
  };
});

vi.mock("@shared/services/internalServiceAuth", () => ({
  verifyInternalServiceRequest: mocks.verify,
}));
vi.mock("@shared/services/inngest", () => ({
  inngest: { send: mocks.send },
}));
vi.mock("@modules/hire-multimodal/services/analysisIngestionService", () => ({
  HireMultimodalAnalysisIngestionError: mocks.MockIngestionError,
  ingestHireMultimodalAnalysis: mocks.ingest,
}));

import { POST } from "./route";

const ROUTE_PATH = "/api/internal/hire/engine/multimodal-analysis";

const WORKSPACE_ID = "1".repeat(24);
const APPLICATION_ID = "2".repeat(24);
const ROUND_ID = "3".repeat(24);
const RUNTIME_SESSION_ID = "4".repeat(24);

function request(body: string): NextRequest {
  return new NextRequest(
    "https://hire.example/api/internal/hire/engine/multimodal-analysis",
    { method: "POST", body },
  );
}

const privateSourceKey = "landmarks/private-candidate/raw-landmarks.json";
const privateTranscriptText = "candidate private interview answer";
const bridgePayload = {
  schemaVersion: 1,
  eventId: "a".repeat(64),
  workspaceId: WORKSPACE_ID,
  applicationId: APPLICATION_ID,
  roundId: ROUND_ID,
  runtimeSessionId: RUNTIME_SESSION_ID,
  attempt: 1,
  revision: 1,
  consentVersion: "hire-ai-interview-v4",
  policyVersion: "hire-recorded-interview-analysis-v1",
  capturedAt: "2026-08-17T10:00:00.000Z",
  durationMs: 60_000,
  landmarks: {
    kind: "landmarks",
    sourceKey: privateSourceKey,
    contentType: "application/json",
    sizeBytes: 1_024,
    sha256: "b".repeat(64),
  },
  transcript: [
    {
      speaker: "candidate",
      text: privateTranscriptText,
      timestampMs: 0,
    },
  ],
  liveTranscriptWords: [],
};

beforeEach(() => {
  vi.clearAllMocks();
  mocks.verify.mockResolvedValue({ ok: true });
  mocks.ingest.mockResolvedValue({
    outcome: "processed",
    analysisId: "analysis-1",
  });
  mocks.send.mockResolvedValue(undefined);
});

describe("Hire full multimodal-analysis bridge route", () => {
  it("requires signed service authentication before parsing or ingesting", async () => {
    mocks.verify.mockResolvedValueOnce({
      ok: false,
      reason: "invalid-signature",
    });
    const body = JSON.stringify(bridgePayload);

    const response = await POST(request(body));

    expect(response.status).toBe(401);
    const payload = await response.json();
    expect(payload).toEqual({ error: "Service authentication failed" });
    expect(JSON.stringify(payload)).not.toContain(privateSourceKey);
    expect(mocks.ingest).not.toHaveBeenCalled();
    expect(mocks.send).not.toHaveBeenCalled();
  });

  it("accepts a signed, bounded bridge request and returns only a typed acknowledgement", async () => {
    const body = JSON.stringify(bridgePayload);
    const response = await POST(request(body));

    expect(mocks.verify).toHaveBeenCalledWith({
      method: "POST",
      path: ROUTE_PATH,
      body,
      headers: expect.any(Headers),
    });
    expect(mocks.ingest).toHaveBeenCalledWith(bridgePayload);
    expect(mocks.send).toHaveBeenCalledWith({
      name: "hire/multimodal-analysis.requested",
      data: { workspaceId: WORKSPACE_ID, analysisId: "analysis-1" },
    });
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    const payload = await response.json();
    expect(payload).toEqual({
      ok: true,
      outcome: "processed",
      analysisId: "analysis-1",
    });
    expect(JSON.stringify(payload)).not.toContain(privateSourceKey);
    expect(JSON.stringify(payload)).not.toContain(privateTranscriptText);
  });

  it("rejects signed malformed input without passing it to ingestion", async () => {
    const malformed = "{candidate private raw body";
    const response = await POST(request(malformed));

    expect(response.status).toBe(400);
    const payload = await response.json();
    expect(payload).toEqual({ error: "Invalid request" });
    expect(JSON.stringify(payload)).not.toContain(malformed);
    expect(mocks.ingest).not.toHaveBeenCalled();
    expect(mocks.send).not.toHaveBeenCalled();
  });

  it("keeps foreign analysis-coordinate failures bounded and does not wake a job", async () => {
    mocks.ingest.mockRejectedValueOnce(
      new mocks.MockIngestionError("Application not found", "not_found", 404),
    );

    const response = await POST(request(JSON.stringify(bridgePayload)));

    expect(response.status).toBe(404);
    await expect(response.json()).resolves.toEqual({
      error: "Application not found",
      code: "not_found",
    });
    expect(mocks.send).not.toHaveBeenCalled();
  });

  it("redacts unexpected ingestion failures rather than exposing raw artifacts", async () => {
    mocks.ingest.mockRejectedValueOnce(new Error(privateSourceKey));

    const response = await POST(request(JSON.stringify(bridgePayload)));

    expect(response.status).toBe(503);
    const payload = await response.json();
    expect(payload).toEqual({ error: "Service unavailable" });
    expect(JSON.stringify(payload)).not.toContain(privateSourceKey);
    expect(mocks.send).not.toHaveBeenCalled();
  });
});
