import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

const mocks = vi.hoisted(() => ({
  requireMembership: vi.fn(),
  readInbox: vi.fn(),
  compare: vi.fn(),
  getJobPipeline: vi.fn(),
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
  getJobPipeline: mocks.getJobPipeline,
}));
vi.mock("@hire-decisions", () => ({
  readHireDecisionActionInbox: mocks.readInbox,
  compareHireDecisionApplications: mocks.compare,
}));

import { GET } from "../route";
import { POST } from "../compare/route";
import { GET as GET_CANDIDATES } from "../candidates/route";

const JOB_ID = "111111111111111111111111";
const APP_A = "222222222222222222222222";
const APP_B = "333333333333333333333333";

describe("member decision routes", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.requireMembership.mockResolvedValue({
      workspace: { _id: { toString: () => "workspace-1" } },
    });
    mocks.readInbox.mockResolvedValue({ items: [] });
    mocks.compare.mockResolvedValue({ applications: [] });
    mocks.getJobPipeline.mockResolvedValue({ entries: [] });
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
    });
    await expect(response.json()).resolves.toEqual({ items: [] });
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

  it("projects only current-job application ids and candidate names for the comparison picker", async () => {
    const appAda = "444444444444444444444444";
    const appGrace = "555555555555555555555555";
    mocks.getJobPipeline.mockResolvedValue({
      entries: [
        {
          application: {
            _id: { toString: () => appGrace },
            stage: "PRIVATE_STAGE",
            decisionNote: "PRIVATE_DECISION_NOTE",
            events: [{ note: "PRIVATE_EVENT_NOTE" }],
            resumeMatch: { strengths: ["PRIVATE_RESUME_EVIDENCE"] },
            jdText: "PRIVATE_JD_TEXT",
          },
          candidate: {
            name: "Grace Hopper",
            email: "grace@example.com",
            phone: "+91-PRIVATE_PHONE",
            resumeText: "PRIVATE_RESUME_TEXT",
            screeningProfile: { location: "PRIVATE_LOCATION" },
          },
          rank: 1,
          latestRound: { results: { raw: "PRIVATE_RAW_AI" } },
        },
        {
          application: { _id: { toString: () => appAda } },
          candidate: { name: "Ada Lovelace", email: "ada@example.com" },
          rank: 2,
        },
        {
          application: { _id: { toString: () => "666666666666666666666666" } },
          candidate: null,
          rank: 3,
        },
      ],
    });

    const response = await GET_CANDIDATES(
      new Request(
        `https://hire.example/api/workspace/jobs/${JOB_ID}/decision/candidates`,
      ) as never,
      { params: { jobId: JOB_ID } },
    );

    expect(mocks.requireMembership).toHaveBeenCalledWith({
      userId: "member-1",
      email: "hr@example.com",
    });
    expect(mocks.getJobPipeline).toHaveBeenCalledWith(
      expect.objectContaining({ workspace: expect.anything() }),
      JOB_ID,
    );
    expect(response.headers.get("Cache-Control")).toBe("private, no-store");
    const body = await response.clone().text();
    await expect(response.json()).resolves.toEqual({
      candidates: [
        { applicationId: appAda, candidateName: "Ada Lovelace" },
        { applicationId: appGrace, candidateName: "Grace Hopper" },
      ],
    });

    for (const forbidden of [
      "PRIVATE_DECISION_NOTE",
      "PRIVATE_EVENT_NOTE",
      "PRIVATE_RESUME_EVIDENCE",
      "grace@example.com",
      "+91-PRIVATE_PHONE",
      "PRIVATE_RESUME_TEXT",
      "PRIVATE_LOCATION",
      "PRIVATE_JD_TEXT",
      "PRIVATE_RAW_AI",
    ]) {
      expect(body).not.toContain(forbidden);
    }
    for (const forbiddenField of [
      "email",
      "phone",
      "rank",
      "stage",
      "decisionNote",
      "events",
      "resumeMatch",
      "resumeText",
      "screeningProfile",
      "jdText",
      "latestRound",
      "results",
      "raw",
      "rawAi",
    ]) {
      expect(body).not.toContain(`"${forbiddenField}"`);
    }
  });
});
