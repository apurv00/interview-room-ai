import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  requireMembership: vi.fn(),
  readHealth: vi.fn(),
}));

vi.mock("../../../_lib/composeHireApiRoute", () => ({
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
vi.mock("@hire-operations", () => ({ readHireJobsHealth: mocks.readHealth }));

import { GET } from "../route";

describe("GET /api/workspace/jobs/health", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.requireMembership.mockResolvedValue({
      workspace: { _id: { toString: () => "workspace-1" } },
    });
    mocks.readHealth.mockResolvedValue({ jobs: [] });
  });

  it("does not accept a caller workspace coordinate and returns only member-scoped health", async () => {
    const response = await GET(
      new Request(
        "https://hire.example/api/workspace/jobs/health?workspaceId=other-workspace",
      ) as never,
    );

    expect(mocks.requireMembership).toHaveBeenCalledWith({
      userId: "member-1",
      email: "hr@example.com",
    });
    expect(mocks.readHealth).toHaveBeenCalledWith({
      workspaceId: "workspace-1",
    });
    expect(response.headers.get("Cache-Control")).toBe("private, no-store");
    await expect(response.json()).resolves.toEqual({ jobs: [] });
  });

  it("filters the new attention enum for legacy clients and exposes it in v2", async () => {
    mocks.readHealth.mockResolvedValue({
      jobs: [{
        jobId: "job-1",
        attention: [
          { kind: "failed_multimodal_analyses", count: 1 },
          { kind: "interview_validation_attention", count: 2 },
        ],
      }],
    });

    const legacy = await GET(
      new Request("https://hire.example/api/workspace/jobs/health") as never,
    );
    await expect(legacy.json()).resolves.toEqual({
      jobs: [{
        jobId: "job-1",
        attention: [{ kind: "failed_multimodal_analyses", count: 1 }],
      }],
    });

    const v2 = await GET(
      new Request(
        "https://hire.example/api/workspace/jobs/health?contractVersion=2",
      ) as never,
    );
    await expect(v2.json()).resolves.toEqual({
      jobs: [{
        jobId: "job-1",
        attention: [
          { kind: "failed_multimodal_analyses", count: 1 },
          { kind: "interview_validation_attention", count: 2 },
        ],
      }],
    });
  });
});
