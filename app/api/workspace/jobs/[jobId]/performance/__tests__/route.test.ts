import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  requireMembership: vi.fn(),
  parseParams: vi.fn(),
  readPerformance: vi.fn(),
}));

vi.mock("../../../../_lib/composeHireApiRoute", () => ({
  composeHireApiRoute:
    (options: any) =>
    async (request: Request, context?: { params?: Record<string, string> }) =>
      options.handler(request, {
        user: { id: "member-1", email: "hr@example.com" },
        body: {},
        params: context?.params ?? {},
      }),
}));

vi.mock("@hire-operations-boundary", () => ({
  requireMembership: mocks.requireMembership,
}));
vi.mock("@hire-operations", () => ({
  HireOperationsJobParamsSchema: { parse: mocks.parseParams },
  readHireJobPerformance: mocks.readPerformance,
}));

import { GET } from "../route";

const JOB_ID = "111111111111111111111111";

describe("GET /api/workspace/jobs/:jobId/performance", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.parseParams.mockReturnValue({ jobId: JOB_ID });
    mocks.requireMembership.mockResolvedValue({
      workspace: { _id: { toString: () => "workspace-1" } },
    });
    mocks.readPerformance.mockResolvedValue({ job: { jobId: JOB_ID } });
  });

  it("validates the path job id and scopes the performance aggregate to membership", async () => {
    const response = await GET(
      new Request(
        `https://hire.example/api/workspace/jobs/${JOB_ID}/performance`,
      ) as never,
      { params: { jobId: JOB_ID } },
    );

    expect(mocks.parseParams).toHaveBeenCalledWith({ jobId: JOB_ID });
    expect(mocks.requireMembership).toHaveBeenCalledWith({
      userId: "member-1",
      email: "hr@example.com",
    });
    expect(mocks.readPerformance).toHaveBeenCalledWith({
      workspaceId: "workspace-1",
      jobId: JOB_ID,
    });
    expect(response.headers.get("Cache-Control")).toBe("private, no-store");
    await expect(response.json()).resolves.toEqual({ job: { jobId: JOB_ID } });
  });

  it("does not query membership or performance after invalid path parsing", async () => {
    mocks.parseParams.mockImplementation(() => {
      throw new Error("invalid job id");
    });

    await expect(
      GET(
        new Request(
          "https://hire.example/api/workspace/jobs/not-an-id/performance",
        ) as never,
        { params: { jobId: "not-an-id" } },
      ),
    ).rejects.toThrow("invalid job id");
    expect(mocks.requireMembership).not.toHaveBeenCalled();
    expect(mocks.readPerformance).not.toHaveBeenCalled();
  });
});
