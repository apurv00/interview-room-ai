import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  requireMembership: vi.fn(),
  parseQuery: vi.fn(),
  readAudit: vi.fn(),
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
  HireOperationsAuditQuerySchema: { parse: mocks.parseQuery },
  readHireWorkspaceAudit: mocks.readAudit,
}));

import { GET } from "../route";

describe("GET /api/workspace/audit", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.parseQuery.mockReturnValue({ cursor: "opaque", limit: 2 });
    mocks.requireMembership.mockResolvedValue({
      workspace: { _id: { toString: () => "workspace-1" } },
    });
    mocks.readAudit.mockResolvedValue({ items: [], nextCursor: null });
  });

  it("uses only membership scope and a parsed cursor query", async () => {
    const response = await GET(
      new Request(
        "https://hire.example/api/workspace/audit?cursor=opaque&limit=2&workspaceId=other-workspace",
      ) as never,
    );

    expect(mocks.parseQuery).toHaveBeenCalledWith({
      cursor: "opaque",
      limit: "2",
    });
    expect(mocks.requireMembership).toHaveBeenCalledWith({
      userId: "member-1",
      email: "hr@example.com",
    });
    expect(mocks.readAudit).toHaveBeenCalledWith({
      workspaceId: "workspace-1",
      cursor: "opaque",
      limit: 2,
    });
    expect(response.headers.get("Cache-Control")).toBe("private, no-store");
    await expect(response.json()).resolves.toEqual({
      items: [],
      nextCursor: null,
    });
  });

  it("does not query membership or sources when the cursor query is invalid", async () => {
    mocks.parseQuery.mockImplementation(() => {
      throw new Error("invalid audit query");
    });

    await expect(
      GET(
        new Request(
          "https://hire.example/api/workspace/audit?limit=0",
        ) as never,
      ),
    ).rejects.toThrow("invalid audit query");
    expect(mocks.requireMembership).not.toHaveBeenCalled();
    expect(mocks.readAudit).not.toHaveBeenCalled();
  });
});
