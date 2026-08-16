import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  requireMembership: vi.fn(),
  deleteEmptyHireJob: vi.fn(),
}));

vi.mock("../../../_lib/composeHireApiRoute", () => ({
  composeHireApiRoute:
    (options: any) =>
    async (req: Request, routeContext?: { params?: Record<string, string> }) =>
      options.handler(req, {
        user: { id: "member-user", email: "admin@example.com" },
        body: options.schema ? options.schema.parse(await req.json()) : {},
        params: routeContext?.params ?? { jobId: "aaaaaaaaaaaaaaaaaaaaaaaa" },
      }),
}));

vi.mock("@hire", () => ({
  requireMembership: mocks.requireMembership,
  getJobCloseEmailDelivery: vi.fn(),
  getJobPipeline: vi.fn(),
  updateJobStatus: vi.fn(),
  UpdateJobStatusSchema: {},
}));

vi.mock("@/modules/hire-job-deletion", () => ({
  DeleteEmptyHireJobSchema: {
    parse: (value: unknown) => value,
  },
  deleteEmptyHireJob: mocks.deleteEmptyHireJob,
}));

import { DELETE } from "../route";

const ctx = {
  workspace: { _id: { toString: () => "workspace-1" } },
  membership: { _id: { toString: () => "member-1" }, role: "admin" },
};

beforeEach(() => {
  vi.clearAllMocks();
  mocks.requireMembership.mockResolvedValue(ctx);
  mocks.deleteEmptyHireJob.mockResolvedValue({
    jobId: "aaaaaaaaaaaaaaaaaaaaaaaa",
  });
});

describe("DELETE /api/workspace/jobs/[jobId]", () => {
  it("uses the membership-scoped empty-job command and returns a private success shape", async () => {
    const payload = {
      confirmationTitle: "Backend Engineer",
      acknowledgeEmptyJobDeletion: true,
    };

    const response = await DELETE(
      new Request(
        "https://hire.example/api/workspace/jobs/aaaaaaaaaaaaaaaaaaaaaaaa",
        {
          method: "DELETE",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(payload),
        },
      ) as never,
      { params: { jobId: "aaaaaaaaaaaaaaaaaaaaaaaa" } },
    );

    expect(mocks.requireMembership).toHaveBeenCalledWith({
      userId: "member-user",
      email: "admin@example.com",
    });
    expect(mocks.deleteEmptyHireJob).toHaveBeenCalledWith(
      ctx,
      "aaaaaaaaaaaaaaaaaaaaaaaa",
      payload,
    );
    expect(response.headers.get("Cache-Control")).toBe("private, no-store");
    await expect(response.json()).resolves.toEqual({
      deleted: true,
      jobId: "aaaaaaaaaaaaaaaaaaaaaaaa",
    });
  });
});
