import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  requireMembership: vi.fn(),
  readOverview: vi.fn(),
}));

vi.mock("../../_lib/composeHireApiRoute", () => ({
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
  readHireWorkspaceOverview: mocks.readOverview,
}));

import { GET } from "../route";

describe("GET /api/workspace/overview", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.requireMembership.mockResolvedValue({
      workspace: { _id: { toString: () => "workspace-1" } },
    });
    mocks.readOverview.mockResolvedValue({
      kpis: {},
      actionInbox: { items: [] },
    });
  });

  it("derives the only workspace coordinate from current membership and disables caching", async () => {
    const response = await GET(
      new Request("https://hire.example/api/workspace/overview") as never,
    );

    expect(mocks.requireMembership).toHaveBeenCalledWith({
      userId: "member-1",
      email: "hr@example.com",
    });
    expect(mocks.readOverview).toHaveBeenCalledWith({
      workspaceId: "workspace-1",
    });
    expect(response.headers.get("Cache-Control")).toBe("private, no-store");
    await expect(response.json()).resolves.toEqual({
      kpis: {},
      actionInbox: { items: [] },
    });
  });

  it("keeps legacy clients compatible until they explicitly request contract v2", async () => {
    mocks.readOverview.mockResolvedValue({
      kpis: {},
      actionInbox: {
        items: [
          { kind: "candidates_awaiting_decision", count: 1 },
          { kind: "interview_validation_attention", count: 2 },
        ],
      },
    });

    const legacy = await GET(
      new Request("https://hire.example/api/workspace/overview") as never,
    );
    await expect(legacy.json()).resolves.toEqual({
      kpis: {},
      actionInbox: {
        items: [{ kind: "candidates_awaiting_decision", count: 1 }],
      },
    });

    const v2 = await GET(
      new Request(
        "https://hire.example/api/workspace/overview?contractVersion=2",
      ) as never,
    );
    await expect(v2.json()).resolves.toEqual({
      kpis: {},
      actionInbox: {
        items: [
          { kind: "candidates_awaiting_decision", count: 1 },
          { kind: "interview_validation_attention", count: 2 },
        ],
      },
    });
  });
});
