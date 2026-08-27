import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

const mocks = vi.hoisted(() => ({
  requireMembership: vi.fn(),
  readInbox: vi.fn(),
  compare: vi.fn(),
  searchCandidates: vi.fn(),
}));

vi.mock("../../../../_lib/composeHireApiRoute", () => ({
  composeHireApiRoute:
    (options: any) =>
    async (request: Request, context?: { params?: Record<string, string> }) =>
      options.handler(request, {
        user: { id: "member-1", email: "hr@example.com" },
        body: options.schema ? options.schema.parse(await request.json()) : {},
        params: context?.params ?? {},
      }),
}));

vi.mock("@hire", () => ({
  requireMembership: mocks.requireMembership,
}));
vi.mock("@hire-decisions", () => ({
  readHireDecisionActionInbox: mocks.readInbox,
  compareHireDecisionApplications: mocks.compare,
}));
vi.mock("@hire-operations", () => ({
  readHireJobCandidateIdentities: mocks.searchCandidates,
}));

import { GET } from "../route";
import { GET as candidatesGET } from "../candidates/route";
import { POST } from "../compare/route";

const JOB_ID = "111111111111111111111111";
const APP_A = "222222222222222222222222";
const APP_B = "333333333333333333333333";

describe("member decision routes", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.requireMembership.mockResolvedValue({
      workspace: { _id: { toString: () => "workspace-1" } },
    });
    mocks.readInbox.mockResolvedValue({ items: [], limit: 20, nextCursor: null });
    mocks.compare.mockResolvedValue({ applications: [] });
    mocks.searchCandidates.mockResolvedValue({
      candidates: [],
      pageInfo: { limit: 20, nextCursor: null },
    });
  });

  it("reads only the current member workspace and job action inbox", async () => {
    const response = await GET(
      new NextRequest(
        `https://hire.example/api/workspace/jobs/${JOB_ID}/decision?externalVerdictsSince=2026-08-14T00:00:00.000Z`,
      ) as never,
      { params: { jobId: JOB_ID } },
    );
    expect(response.headers.get("Cache-Control")).toBe("private, no-store");
    expect(mocks.readInbox).toHaveBeenCalledWith({
      workspaceId: "workspace-1",
      jobId: JOB_ID,
      externalVerdictsSince: new Date("2026-08-14T00:00:00.000Z"),
      limit: 20,
      cursor: undefined,
    });
    await expect(response.json()).resolves.toEqual({
      items: [],
      limit: 20,
      nextCursor: null,
    });
  });

  it("returns and accepts a scope-bound opaque inbox cursor", async () => {
    const occurredAt = new Date("2026-08-14T08:00:00.000Z");
    mocks.readInbox.mockResolvedValueOnce({
      items: [],
      limit: 2,
      nextCursor: {
        occurredAt,
        kind: "external_verdict_submitted",
        applicationId: APP_A,
        sourceId: APP_A,
      },
    });

    const first = await GET(
      new NextRequest(
        `https://hire.example/api/workspace/jobs/${JOB_ID}/decision?limit=2`,
      ) as never,
      { params: { jobId: JOB_ID } },
    );
    const page = await first.json();
    expect(page).toEqual({
      items: [],
      limit: 2,
      nextCursor: expect.any(String),
    });

    mocks.readInbox.mockResolvedValueOnce({
      items: [],
      limit: 2,
      nextCursor: null,
    });
    await GET(
      new NextRequest(
        `https://hire.example/api/workspace/jobs/${JOB_ID}/decision?limit=2&cursor=${encodeURIComponent(page.nextCursor)}`,
      ) as never,
      { params: { jobId: JOB_ID } },
    );
    expect(mocks.readInbox).toHaveBeenLastCalledWith({
      workspaceId: "workspace-1",
      jobId: JOB_ID,
      externalVerdictsSince: undefined,
      limit: 2,
      cursor: {
        occurredAt,
        kind: "external_verdict_submitted",
        applicationId: APP_A,
        sourceId: APP_A,
      },
    });

    const cursorParts = String(page.nextCursor).split(".");
    cursorParts[1] = `${cursorParts[1][0] === "A" ? "B" : "A"}${cursorParts[1].slice(1)}`;
    await expect(
      GET(
        new NextRequest(
          `https://hire.example/api/workspace/jobs/${JOB_ID}/decision?limit=2&cursor=${encodeURIComponent(cursorParts.join("."))}`,
        ) as never,
        { params: { jobId: JOB_ID } },
      ),
    ).rejects.toMatchObject({ code: "INVALID_DECISION_CURSOR" });

    await expect(
      GET(
        new NextRequest(
          `https://hire.example/api/workspace/jobs/${"9".repeat(24)}/decision?limit=2&cursor=${encodeURIComponent(page.nextCursor)}`,
        ) as never,
        { params: { jobId: "9".repeat(24) } },
      ),
    ).rejects.toMatchObject({ code: "INVALID_DECISION_CURSOR" });
  });

  it("rejects an invalid verdict cursor before reading any decision data", async () => {
    await expect(
      GET(
        new NextRequest(
          `https://hire.example/api/workspace/jobs/${JOB_ID}/decision?externalVerdictsSince=never`,
        ) as never,
        { params: { jobId: JOB_ID } },
      ),
    ).rejects.toMatchObject({ code: "INVALID_VERDICT_CURSOR" });
    expect(mocks.readInbox).not.toHaveBeenCalled();
  });

  it("rejects an unbounded inbox page before reading decision data", async () => {
    await expect(
      GET(
        new NextRequest(
          `https://hire.example/api/workspace/jobs/${JOB_ID}/decision?limit=51`,
        ) as never,
        { params: { jobId: JOB_ID } },
      ),
    ).rejects.toMatchObject({ code: "INVALID_DECISION_LIMIT" });
    expect(mocks.readInbox).not.toHaveBeenCalled();
  });

  it("compares a member-selected 2–3 application set only within the path job", async () => {
    const response = await POST(
      new Request(
        `https://hire.example/api/workspace/jobs/${JOB_ID}/decision/compare`,
        {
          method: "POST",
          body: JSON.stringify({ applicationIds: [APP_A, APP_B] }),
        },
      ) as never,
      { params: { jobId: JOB_ID } },
    );
    expect(mocks.compare).toHaveBeenCalledWith({
      workspaceId: "workspace-1",
      jobId: JOB_ID,
      applicationIds: [APP_A, APP_B],
    });
    expect(response.headers.get("Cache-Control")).toBe("private, no-store");
  });

  it("returns a paginated identity-only comparison search with no rank or evidence fields", async () => {
    mocks.searchCandidates.mockResolvedValue({
      candidates: [
        {
          applicationId: APP_A,
          candidateName: "Ada Lovelace",
          candidateEmail: "ada@example.com",
          stage: "offer",
          jdMatch: { score: 99, rank: 1 },
          humanReview: { state: "complete" },
          aiInterview: { overallScore: 98 },
          resumeText: "PRIVATE_RESUME",
        },
      ],
      pageInfo: {
        limit: 20,
        nextCursor: "opaque-candidate-page",
        hasNextPage: true,
        snapshotAt: "2026-08-25T00:00:00.000Z",
      },
      rankContext: { freshScoredTotal: 500 },
    });

    const response = await candidatesGET(
      new NextRequest(
        `https://hire.example/api/workspace/jobs/${JOB_ID}/decision/candidates?q=ada&limit=20`,
      ) as never,
      { params: { jobId: JOB_ID } },
    );

    expect(response.headers.get("Cache-Control")).toBe("private, no-store");
    expect(mocks.searchCandidates).toHaveBeenCalledWith({
      workspaceId: "workspace-1",
      jobId: JOB_ID,
      query: {
        q: "ada",
        limit: 20,
      },
    });
    const payload = await response.json();
    expect(payload).toEqual({
      candidates: [
        {
          applicationId: APP_A,
          candidateName: "Ada Lovelace",
          candidateEmail: "ada@example.com",
        },
      ],
      pageInfo: { limit: 20, nextCursor: "opaque-candidate-page" },
    });
    const encoded = JSON.stringify(payload).toLowerCase();
    for (const forbidden of [
      "rank",
      "score",
      "stage",
      "review",
      "interview",
      "resume",
      "evidence",
    ]) {
      expect(encoded).not.toContain(forbidden);
    }
  });

  it("rejects duplicate or over-limit comparison inputs at the route boundary", async () => {
    await expect(
      POST(
        new Request(
          `https://hire.example/api/workspace/jobs/${JOB_ID}/decision/compare`,
          {
            method: "POST",
            body: JSON.stringify({ applicationIds: [APP_A, APP_A] }),
          },
        ) as never,
        { params: { jobId: JOB_ID } },
      ),
    ).rejects.toThrow();
    expect(mocks.compare).not.toHaveBeenCalled();
  });

});
