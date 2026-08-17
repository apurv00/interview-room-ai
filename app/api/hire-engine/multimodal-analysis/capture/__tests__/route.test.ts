import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

const mocks = vi.hoisted(() => ({
  getServerSession: vi.fn(),
  requireWorkspace: vi.fn(),
  capture: vi.fn(),
}));

vi.mock("next-auth", () => ({ getServerSession: mocks.getServerSession }));
vi.mock("@shared/auth/authOptions", () => ({ authOptions: {} }));
vi.mock("@modules/hire-runtime/services/runtimeTenantScope", () => ({
  requireRuntimeWorkspaceId: mocks.requireWorkspace,
}));
vi.mock(
  "@modules/hire-runtime/services/multimodalAnalysisCaptureService",
  async () => {
    const actual = await vi.importActual<
      typeof import("@modules/hire-runtime/services/multimodalAnalysisCaptureService")
    >("@modules/hire-runtime/services/multimodalAnalysisCaptureService");
    return { ...actual, captureHireRuntimeMultimodalAnalysis: mocks.capture };
  },
);

import { POST } from "../route";

const WORKSPACE_ID = "1".repeat(24);
const PRINCIPAL_ID = "2".repeat(24);
const SESSION_ID = "3".repeat(24);
const FENCE_SECRET = "f".repeat(64);

function request(
  body: Record<string, unknown>,
  headers: Record<string, string> = {},
): NextRequest {
  return new NextRequest(
    "https://hire-runtime.test/api/hire-engine/multimodal-analysis/capture",
    {
      method: "POST",
      headers: { "content-type": "application/json", ...headers },
      body: JSON.stringify(body),
    },
  );
}

const capture = {
  sessionId: SESSION_ID,
  frames: [
    {
      ts: 0,
      gazeX: 0,
      gazeY: 0,
      headPoseYaw: 0,
      headPosePitch: 0,
      expression: "neutral",
      eyeContactScore: 0.8,
    },
  ],
};

const trustedHeaders = {
  "x-ipg-hire-runtime-fence-bypass": FENCE_SECRET,
  "x-origin-user-id": PRINCIPAL_ID,
};

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubEnv("HIRE_RUNTIME_FENCE_SECRET", FENCE_SECRET);
  mocks.getServerSession.mockResolvedValue({
    user: { id: PRINCIPAL_ID, organizationId: WORKSPACE_ID },
  });
  mocks.requireWorkspace.mockReturnValue(WORKSPACE_ID);
  mocks.capture.mockResolvedValue("accepted");
});

describe("POST /api/hire-engine/multimodal-analysis/capture", () => {
  it("does not expose a direct browser-write path outside the signed runtime fence", async () => {
    const response = await POST(request(capture));

    expect(response.status).toBe(404);
    expect(mocks.capture).not.toHaveBeenCalled();
  });

  it("rejects an unauthenticated or cross-principal runtime request", async () => {
    mocks.getServerSession.mockResolvedValueOnce(null);
    const unauthenticated = await POST(request(capture, trustedHeaders));

    expect(unauthenticated.status).toBe(401);
    await expect(unauthenticated.json()).resolves.toEqual({
      error: "Unauthorized",
    });
    expect(mocks.capture).not.toHaveBeenCalled();

    const foreignPrincipal = await POST(
      request(capture, {
        ...trustedHeaders,
        "x-origin-user-id": "4".repeat(24),
      }),
    );

    expect(foreignPrincipal.status).toBe(409);
    await expect(foreignPrincipal.json()).resolves.toEqual({
      error: "Session changed",
    });
    expect(mocks.capture).not.toHaveBeenCalled();
  });

  it("accepts a bounded capture only for the fence-bound runtime principal", async () => {
    const response = await POST(request(capture, trustedHeaders));

    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    await expect(response.json()).resolves.toEqual({
      accepted: true,
      outcome: "accepted",
    });
    expect(mocks.capture).toHaveBeenCalledWith({
      workspaceId: WORKSPACE_ID,
      principalId: PRINCIPAL_ID,
      capture,
    });
  });

  it("rejects malformed capture input without echoing raw frame payloads", async () => {
    const privateFrameValue = "candidate-private-facial-landmark-value";
    const response = await POST(
      request(
        {
          ...capture,
          frames: [
            { ...capture.frames[0], untrustedRawValue: privateFrameValue },
          ],
        },
        trustedHeaders,
      ),
    );

    expect(response.status).toBe(400);
    const payload = await response.json();
    expect(payload).toEqual({ error: "Invalid capture" });
    expect(JSON.stringify(payload)).not.toContain(privateFrameValue);
    expect(mocks.capture).not.toHaveBeenCalled();
  });

  it("redacts unexpected capture failures rather than exposing candidate input", async () => {
    const privateFailureDetail = "landmarks/private/candidate-capture.json";
    mocks.capture.mockRejectedValueOnce(new Error(privateFailureDetail));

    const response = await POST(request(capture, trustedHeaders));

    expect(response.status).toBe(503);
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    const payload = await response.json();
    expect(payload).toEqual({ error: "Capture unavailable" });
    expect(JSON.stringify(payload)).not.toContain(privateFailureDetail);
  });
});
