import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  requireMembership: vi.fn(),
  jobFind: vi.fn(),
  testDriveFind: vi.fn(),
}));

vi.mock("../../../_lib/composeHireApiRoute", () => ({
  composeHireApiRoute: (options: any) => async (req: Request) =>
    options.handler(req, {
      user: { id: "member-user", email: "hr@example.com" },
      body: {},
      params: {},
    }),
}));

vi.mock("@hire/services/workspaceService", () => ({
  requireMembership: mocks.requireMembership,
}));

vi.mock("@hire-decision-boundary", () => ({
  HireJob: { find: mocks.jobFind },
}));

vi.mock("@/modules/hire-onboarding/models", () => ({
  HireOnboardingTestDrive: { find: mocks.testDriveFind },
}));

import { GET } from "../route";

const WORKSPACE_ID = "workspace-1";
const REAL_JOB_ID = "1".repeat(24);
const PRACTICE_JOB_ID = "2".repeat(24);

function query(rows: unknown[]) {
  const lean = vi.fn().mockResolvedValue(rows);
  const sort = vi.fn().mockReturnValue({ lean });
  const select = vi.fn().mockReturnValue({ lean, sort });
  return { select, sort, lean };
}

describe("GET /api/workspace/reports/job-options", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.requireMembership.mockResolvedValue({
      workspace: { _id: WORKSPACE_ID },
    });
    mocks.testDriveFind.mockReturnValue(
      query([{ jobId: { toString: () => PRACTICE_JOB_ID } }]),
    );
    mocks.jobFind.mockReturnValue(
      query([
        {
          _id: { toString: () => REAL_JOB_ID },
          title: "Platform engineer",
          status: "open",
          closeNote: "Do not expose this operational note",
          jdText: "Do not expose this job description",
          screeningSettings: { location: "private" },
        },
        {
          _id: { toString: () => PRACTICE_JOB_ID },
          title: "Interview yourself",
          status: "open",
          closeNote: "Synthetic only",
        },
      ]),
    );
  });

  it("returns a membership-scoped exact DTO and excludes onboarding jobs", async () => {
    const response = await GET(
      new Request(
        "https://hire.example/api/workspace/reports/job-options",
      ) as never,
    );
    const body = await response.json();

    expect(mocks.requireMembership).toHaveBeenCalledWith({
      userId: "member-user",
      email: "hr@example.com",
    });
    expect(mocks.testDriveFind).toHaveBeenCalledWith({
      workspaceId: WORKSPACE_ID,
      excludeFromAggregates: true,
    });
    expect(mocks.jobFind).toHaveBeenCalledWith({ workspaceId: WORKSPACE_ID });
    expect(response.headers.get("Cache-Control")).toBe("private, no-store");
    expect(body).toEqual({
      jobs: [{ id: REAL_JOB_ID, title: "Platform engineer", status: "open" }],
    });
    const encoded = JSON.stringify(body);
    expect(encoded).not.toContain("closeNote");
    expect(encoded).not.toContain("job description");
    expect(encoded).not.toContain("screeningSettings");
    expect(encoded).not.toContain("Interview yourself");
  });
});
