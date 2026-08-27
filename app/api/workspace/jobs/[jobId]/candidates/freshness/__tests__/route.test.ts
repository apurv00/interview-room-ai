import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  requireMembership: vi.fn(),
  parseParams: vi.fn(),
  parseQuery: vi.fn(),
  readFreshness: vi.fn(),
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
  HireJobCandidateFreshnessQuerySchema: { parse: mocks.parseQuery },
  HireOperationsJobParamsSchema: { parse: mocks.parseParams },
  readHireJobCandidateFreshness: mocks.readFreshness,
}));

import { GET } from "../route";

const JOB_ID = "222222222222222222222222";
const QUERY = {
  snapshotAt: "2026-08-25T12:00:00.000Z",
  view: "decision_ready",
  stage: [], source: [], scoreState: [], humanReview: [], aiInterview: [],
  sort: "newest", direction: "desc",
};

describe("GET /api/workspace/jobs/:jobId/candidates/freshness", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.parseParams.mockReturnValue({ jobId: JOB_ID });
    mocks.parseQuery.mockReturnValue(QUERY);
    mocks.requireMembership.mockResolvedValue({ workspace: { _id: "111111111111111111111111" } });
    mocks.readFreshness.mockResolvedValue({
      hasNewerResults: true,
      checkedAt: "2026-08-25T12:01:00.000Z",
    });
  });

  it("validates the frozen filters and returns only private freshness metadata", async () => {
    const response = await GET(new Request(
      `https://hire.example/api/workspace/jobs/${JOB_ID}/candidates/freshness?snapshotAt=2026-08-25T12%3A00%3A00.000Z&view=decision_ready`,
    ) as never, { params: { jobId: JOB_ID } });

    expect(mocks.parseQuery).toHaveBeenCalledWith({
      snapshotAt: "2026-08-25T12:00:00.000Z",
      view: "decision_ready",
    });
    expect(mocks.readFreshness).toHaveBeenCalledWith({
      workspaceId: "111111111111111111111111",
      jobId: JOB_ID,
      query: QUERY,
    });
    expect(response.headers.get("Cache-Control")).toBe("private, no-store");
    await expect(response.json()).resolves.toEqual({
      hasNewerResults: true,
      checkedAt: "2026-08-25T12:01:00.000Z",
    });
  });

  it("fails repeated query validation before membership or database reads", async () => {
    mocks.parseQuery.mockImplementation(() => { throw new Error("invalid freshness query"); });
    await expect(GET(new Request(
      `https://hire.example/api/workspace/jobs/${JOB_ID}/candidates/freshness?snapshotAt=a&snapshotAt=b`,
    ) as never, { params: { jobId: JOB_ID } })).rejects.toThrow("invalid freshness query");
    expect(mocks.parseQuery).toHaveBeenCalledWith({ snapshotAt: ["a", "b"] });
    expect(mocks.requireMembership).not.toHaveBeenCalled();
    expect(mocks.readFreshness).not.toHaveBeenCalled();
  });
});
