import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  requireMembership: vi.fn(),
  getPreference: vi.fn(),
  updatePreference: vi.fn(),
  parsePreference: vi.fn(),
}));

vi.mock("../../_lib/composeHireApiRoute", () => ({
  composeHireApiRoute:
    (options: any) =>
    async (request: Request, context?: { params?: Record<string, string> }) => {
      const body = options.schema
        ? options.schema.parse(await request.json())
        : {};
      return options.handler(request, {
        user: { id: "member-1", email: "hr@example.com" },
        body,
        params: context?.params ?? {},
      });
    },
}));

vi.mock("@hire-operations-boundary", () => ({
  requireMembership: mocks.requireMembership,
}));

vi.mock("@hire-digest", () => ({
  getHireDigestPreference: mocks.getPreference,
  updateHireDigestPreference: mocks.updatePreference,
  UpdateHireDigestPreferenceSchema: { parse: mocks.parsePreference },
}));

import { GET, PATCH } from "../route";

const ctx = {
  workspace: { _id: { toString: () => "workspace-1" } },
  membership: {
    _id: { toString: () => "member-1" },
    email: "hr@example.com",
    name: "Hiring Admin",
  },
};

function preference(overrides: Record<string, unknown> = {}) {
  return {
    enabled: false,
    updatedAt: new Date("2026-08-15T08:00:00.000Z"),
    recipientEmail: "PRIVATE_RECIPIENT@example.com",
    outboxId: "PRIVATE_OUTBOX_ID",
    outboxStatus: "sending",
    payload: { candidateName: "PRIVATE_CANDIDATE_NAME" },
    providerMessageId: "PRIVATE_PROVIDER_ID",
    capability: "PRIVATE_CAPABILITY",
    ...overrides,
  };
}

describe("/api/workspace/digest-preference", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.requireMembership.mockResolvedValue(ctx);
    mocks.getPreference.mockResolvedValue(preference());
    mocks.updatePreference.mockResolvedValue(preference({ enabled: true }));
    mocks.parsePreference.mockImplementation((value) => value);
  });

  it("GET derives scope only from membership and serializes the two safe fields", async () => {
    const response = await GET(
      new Request(
        "https://hire.example/api/workspace/digest-preference?workspaceId=foreign-workspace",
      ) as never,
    );

    expect(mocks.requireMembership).toHaveBeenCalledWith({
      userId: "member-1",
      email: "hr@example.com",
    });
    expect(mocks.getPreference).toHaveBeenCalledWith(ctx);
    expect(response.headers.get("Cache-Control")).toBe("private, no-store");
    await expect(response.json()).resolves.toEqual({
      enabled: false,
      updatedAt: "2026-08-15T08:00:00.000Z",
    });
  });

  it("PATCH accepts only the strict enabled flag and passes membership authority to the digest service", async () => {
    const response = await PATCH(
      new Request("https://hire.example/api/workspace/digest-preference", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ enabled: true }),
      }) as never,
    );

    expect(mocks.parsePreference).toHaveBeenCalledWith({ enabled: true });
    expect(mocks.updatePreference).toHaveBeenCalledWith(ctx, { enabled: true });
    expect(response.headers.get("Cache-Control")).toBe("private, no-store");
    await expect(response.json()).resolves.toEqual({
      enabled: true,
      updatedAt: "2026-08-15T08:00:00.000Z",
    });
  });

  it("does not reach membership or digest data when strict input parsing rejects a body", async () => {
    mocks.parsePreference.mockImplementation(() => {
      throw new Error("enabled must be a boolean and no extra data is allowed");
    });

    await expect(
      PATCH(
        new Request("https://hire.example/api/workspace/digest-preference", {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            enabled: "true",
            recipientEmail: "attempted-leak@example.com",
          }),
        }) as never,
      ),
    ).rejects.toThrow("enabled must be a boolean");
    expect(mocks.requireMembership).not.toHaveBeenCalled();
    expect(mocks.updatePreference).not.toHaveBeenCalled();
  });

  it("stops before the digest service when membership is unavailable for deletion", async () => {
    mocks.requireMembership.mockRejectedValue(
      new Error("Workspace is scheduled for deletion"),
    );

    await expect(
      GET(
        new Request(
          "https://hire.example/api/workspace/digest-preference",
        ) as never,
      ),
    ).rejects.toThrow("Workspace is scheduled for deletion");
    expect(mocks.getPreference).not.toHaveBeenCalled();
    expect(mocks.updatePreference).not.toHaveBeenCalled();
  });

  it("never returns recipient, outbox, payload, provider, candidate, or capability data", async () => {
    const response = await GET(
      new Request(
        "https://hire.example/api/workspace/digest-preference",
      ) as never,
    );
    const text = JSON.stringify(await response.json());

    for (const deniedValue of [
      "PRIVATE_RECIPIENT@example.com",
      "PRIVATE_OUTBOX_ID",
      "sending",
      "PRIVATE_CANDIDATE_NAME",
      "PRIVATE_PROVIDER_ID",
      "PRIVATE_CAPABILITY",
    ]) {
      expect(text).not.toContain(deniedValue);
    }
  });
});
