import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  requireMembership: vi.fn(),
  parseParams: vi.fn(),
  readMetadata: vi.fn(),
  release: vi.fn(),
}));

vi.mock("../../../../../_lib/composeHireApiRoute", () => ({
  composeHireApiRoute:
    (options: any) =>
    async (request: Request, context?: { params?: Record<string, string> }) =>
      options.handler(request, {
        user: { id: "member-user", email: "hr@example.com" },
        body: {},
        params: context?.params ?? {},
      }),
}));

vi.mock("@hire-operations-boundary", () => ({
  requireMembership: mocks.requireMembership,
}));

vi.mock("@hire-operations", () => ({
  HireCandidateSelectionParamsSchema: { parse: mocks.parseParams },
  readCandidateSelectionMetadata: mocks.readMetadata,
  releaseCandidateSelectionSnapshot: mocks.release,
}));

import { DELETE, GET } from "../route";

const JOB_ID = "222222222222222222222222";
const SELECTION_ID = "555555555555555555555555";

describe("/api/workspace/jobs/:jobId/candidate-selections/:selectionId", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.parseParams.mockReturnValue({ jobId: JOB_ID, selectionId: SELECTION_ID });
    mocks.requireMembership.mockResolvedValue({ membership: { _id: "member" } });
    mocks.readMetadata.mockResolvedValue({
      selectionId: SELECTION_ID,
      count: 4,
      expiresAt: "2026-08-25T12:15:00.000Z",
      description: "All matching · 4 candidates",
      homogeneousStage: null,
    });
    mocks.release.mockResolvedValue(true);
  });

  it("returns scoped metadata without immutable IDs", async () => {
    const response = await GET(
      new Request(`https://hire.example/api/workspace/jobs/${JOB_ID}/candidate-selections/${SELECTION_ID}`) as never,
      { params: { jobId: JOB_ID, selectionId: SELECTION_ID } },
    );
    expect(mocks.readMetadata).toHaveBeenCalledWith(expect.anything(), {
      jobId: JOB_ID,
      selectionId: SELECTION_ID,
    });
    expect(response.headers.get("Cache-Control")).toBe("private, no-store");
    const payload = await response.json();
    expect(payload.count).toBe(4);
    expect(payload.homogeneousStage).toBeNull();
    expect(payload).not.toHaveProperty("applicationIds");
  });

  it("releases only the member-scoped snapshot", async () => {
    const response = await DELETE(
      new Request(`https://hire.example/api/workspace/jobs/${JOB_ID}/candidate-selections/${SELECTION_ID}`, { method: "DELETE" }) as never,
      { params: { jobId: JOB_ID, selectionId: SELECTION_ID } },
    );
    expect(mocks.release).toHaveBeenCalledWith(expect.anything(), {
      jobId: JOB_ID,
      selectionId: SELECTION_ID,
    });
    await expect(response.json()).resolves.toEqual({ released: true });
  });
});
