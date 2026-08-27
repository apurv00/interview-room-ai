import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  requireMembership: vi.fn(),
  parseParams: vi.fn(),
  parseBody: vi.fn(),
  createSelection: vi.fn(),
}));

vi.mock("../../../../_lib/composeHireApiRoute", () => ({
  composeHireApiRoute:
    (options: any) =>
    async (request: Request, context?: { params?: Record<string, string> }) => {
      const raw = options.schema ? await request.json() : {};
      const body = options.schema ? options.schema.parse(raw) : {};
      return options.handler(request, {
        user: { id: "member-user", email: "hr@example.com" },
        body,
        params: context?.params ?? {},
      });
    },
}));

vi.mock("@hire-operations-boundary", () => ({
  requireMembership: mocks.requireMembership,
}));

vi.mock("@hire-operations", () => ({
  HireCandidateSelectionCreateSchema: { parse: mocks.parseBody },
  HireOperationsJobParamsSchema: { parse: mocks.parseParams },
  createCandidateSelectionSnapshot: mocks.createSelection,
}));

import { POST } from "../route";

const JOB_ID = "222222222222222222222222";
const APPLICATION_ID = "333333333333333333333333";

describe("POST /api/workspace/jobs/:jobId/candidate-selections", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.parseParams.mockReturnValue({ jobId: JOB_ID });
    mocks.parseBody.mockImplementation((value) => value);
    mocks.requireMembership.mockResolvedValue({
      workspace: { _id: "111111111111111111111111" },
      membership: { _id: "444444444444444444444444" },
    });
    mocks.createSelection.mockResolvedValue({
      selectionId: "555555555555555555555555",
      count: 1,
      expiresAt: "2026-08-25T12:15:00.000Z",
      description: "Selected candidates · 1 candidate",
      homogeneousStage: "new",
    });
  });

  it("creates only a member-scoped snapshot and returns no application IDs", async () => {
    const body = { mode: "explicit", applicationIds: [APPLICATION_ID] };
    const response = await POST(
      new Request(`https://hire.example/api/workspace/jobs/${JOB_ID}/candidate-selections`, {
        method: "POST",
        body: JSON.stringify(body),
      }) as never,
      { params: { jobId: JOB_ID } },
    );

    expect(mocks.parseParams).toHaveBeenCalledWith({ jobId: JOB_ID });
    expect(mocks.requireMembership).toHaveBeenCalledWith({
      userId: "member-user",
      email: "hr@example.com",
    });
    expect(mocks.createSelection).toHaveBeenCalledWith(
      expect.anything(),
      { jobId: JOB_ID, payload: body },
    );
    expect(response.status).toBe(201);
    expect(response.headers.get("Cache-Control")).toBe("private, no-store");
    const payload = await response.json();
    expect(payload).toEqual({
      selectionId: "555555555555555555555555",
      count: 1,
      expiresAt: "2026-08-25T12:15:00.000Z",
      description: "Selected candidates · 1 candidate",
      homogeneousStage: "new",
    });
    expect(payload).not.toHaveProperty("applicationIds");
  });
});
