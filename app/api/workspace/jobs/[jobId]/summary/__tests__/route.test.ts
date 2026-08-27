import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  requireMembership: vi.fn(),
  parseParams: vi.fn(),
  readOverview: vi.fn(),
}));

vi.mock("../../../../_lib/composeHireApiRoute", () => ({
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
  HireOperationsJobParamsSchema: { parse: mocks.parseParams },
  readHireJobOverview: mocks.readOverview,
}));

import { GET } from "../route";

const JOB_ID = "222222222222222222222222";

describe("GET /api/workspace/jobs/:jobId/summary", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.parseParams.mockReturnValue({ jobId: JOB_ID });
    mocks.requireMembership.mockResolvedValue({
      workspace: { _id: { toString: () => "111111111111111111111111" } },
    });
    mocks.readOverview.mockResolvedValue({
      job: { jobId: JOB_ID },
      recentActivity: [],
    });
  });

  it("derives workspace scope from membership and returns a private aggregate", async () => {
    const response = await GET(
      new Request(`https://hire.example/api/workspace/jobs/${JOB_ID}/summary`) as never,
      { params: { jobId: JOB_ID } },
    );

    expect(mocks.parseParams).toHaveBeenCalledWith({ jobId: JOB_ID });
    expect(mocks.requireMembership).toHaveBeenCalledWith({
      userId: "member-user",
      email: "hr@example.com",
    });
    expect(mocks.readOverview).toHaveBeenCalledWith({
      workspaceId: "111111111111111111111111",
      jobId: JOB_ID,
    });
    expect(response.headers.get("Cache-Control")).toBe("private, no-store");
    await expect(response.json()).resolves.toEqual({
      job: { jobId: JOB_ID },
      recentActivity: [],
    });
  });

  it("fails path validation before membership or database access", async () => {
    mocks.parseParams.mockImplementation(() => {
      throw new Error("invalid job id");
    });
    await expect(
      GET(
        new Request("https://hire.example/api/workspace/jobs/nope/summary") as never,
        { params: { jobId: "nope" } },
      ),
    ).rejects.toThrow("invalid job id");
    expect(mocks.requireMembership).not.toHaveBeenCalled();
    expect(mocks.readOverview).not.toHaveBeenCalled();
  });
});
