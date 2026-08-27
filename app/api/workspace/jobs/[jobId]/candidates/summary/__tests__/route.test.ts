import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  requireMembership: vi.fn(),
  parseParams: vi.fn(),
  parseQuery: vi.fn(),
  readSummary: vi.fn(),
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
  HireJobCandidateSummaryQuerySchema: { parse: mocks.parseQuery },
  HireOperationsJobParamsSchema: { parse: mocks.parseParams },
  readHireJobCandidateSummary: mocks.readSummary,
}));

import { GET } from "../route";

const JOB_ID = "222222222222222222222222";
const QUERY = {
  view: "decision_ready",
  stage: [],
  source: [],
  scoreState: [],
  humanReview: [],
  aiInterview: [],
  sort: "attention",
  direction: "desc",
};

describe("GET /api/workspace/jobs/:jobId/candidates/summary", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.parseParams.mockReturnValue({ jobId: JOB_ID });
    mocks.parseQuery.mockReturnValue(QUERY);
    mocks.requireMembership.mockResolvedValue({
      workspace: { _id: "111111111111111111111111" },
    });
    mocks.readSummary.mockResolvedValue({
      counts: { total: 1_000, matching: 200 },
      rankContext: { freshScoredTotal: 700, stale: 100, unscored: 150, pending: 50 },
    });
  });

  it("validates filters, derives workspace scope, and returns private counts without rows", async () => {
    const response = await GET(
      new Request(
        `https://hire.example/api/workspace/jobs/${JOB_ID}/candidates/summary?view=decision_ready`,
      ) as never,
      { params: { jobId: JOB_ID } },
    );

    expect(mocks.parseQuery).toHaveBeenCalledWith({ view: "decision_ready" });
    expect(mocks.requireMembership).toHaveBeenCalledWith({
      userId: "member-user",
      email: "hr@example.com",
    });
    expect(mocks.readSummary).toHaveBeenCalledWith({
      workspaceId: "111111111111111111111111",
      jobId: JOB_ID,
      query: QUERY,
    });
    expect(response.headers.get("Cache-Control")).toBe("private, no-store");
    const payload = await response.json();
    expect(payload.counts.total).toBe(1_000);
    expect(payload).not.toHaveProperty("rows");
    expect(payload).not.toHaveProperty("pageInfo");
  });

  it("fails repeated/unknown query validation before membership and reads", async () => {
    mocks.parseQuery.mockImplementation(() => {
      throw new Error("invalid candidate summary query");
    });
    await expect(
      GET(
        new Request(
          `https://hire.example/api/workspace/jobs/${JOB_ID}/candidates/summary?stage=new&stage=offer`,
        ) as never,
        { params: { jobId: JOB_ID } },
      ),
    ).rejects.toThrow("invalid candidate summary query");
    expect(mocks.parseQuery).toHaveBeenCalledWith({ stage: ["new", "offer"] });
    expect(mocks.requireMembership).not.toHaveBeenCalled();
    expect(mocks.readSummary).not.toHaveBeenCalled();
  });
});
