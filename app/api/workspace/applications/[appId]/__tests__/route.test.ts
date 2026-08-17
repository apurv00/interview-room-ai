import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  requireMembership: vi.fn(),
  detail: vi.fn(),
  inviteViews: vi.fn(),
  resultFind: vi.fn(),
  photoFind: vi.fn(),
  attemptFind: vi.fn(),
  observationFind: vi.fn(),
  analysisViews: vi.fn(),
}));

function selected(rows: unknown[]) {
  return {
    select: () => ({
      lean: async () => rows,
      sort: () => ({ lean: async () => rows }),
    }),
  };
}

vi.mock("../../../_lib/composeHireApiRoute", () => ({
  composeHireApiRoute:
    (options: { handler: Function }) =>
    async (request: Request, context?: { params?: Record<string, string> }) =>
      options.handler(request, {
        user: { id: "member-id", email: "hr@example.com" },
        params: context?.params ?? {},
      }),
}));
vi.mock("@hire", () => ({
  requireMembership: mocks.requireMembership,
  getApplicationDetail: mocks.detail,
  getAiInviteDeliveryViews: mocks.inviteViews,
  HireInterviewResult: { find: mocks.resultFind },
  HireMediaAsset: { find: mocks.photoFind },
  HireInterviewAttempt: { find: mocks.attemptFind },
}));
vi.mock("@modules/hire-multimodal/models/HireMultimodalObservation", () => ({
  HireMultimodalObservation: { find: mocks.observationFind },
}));
vi.mock("@modules/hire-multimodal/services/analysisPresenter", () => ({
  getHireMultimodalAnalysisViews: mocks.analysisViews,
}));
vi.mock("../../../_lib/serialize", () => ({
  serializeApplication: () => ({ id: "application" }),
  serializeCandidate: () => ({ id: "candidate" }),
  serializeHumanRoundDetail: (value: unknown) => value,
  serializeJob: () => ({ id: "job" }),
  serializeRound: (value: { _id: { toString(): string } }) => ({
    id: value._id.toString(),
  }),
  resumeHashOf: () => "resume-hash",
}));

import { GET } from "../route";

const IDS = {
  workspace: "a".repeat(24),
  application: "b".repeat(24),
  round: "c".repeat(24),
  attempt: "d".repeat(24),
  recording: "e".repeat(24),
};

function objectId(value: string) {
  return { toString: () => value };
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.requireMembership.mockResolvedValue({
    workspace: { _id: IDS.workspace },
  });
  mocks.detail.mockResolvedValue({
    application: { _id: IDS.application },
    candidate: { resumeText: "" },
    job: {},
    rounds: [],
    humanRounds: [],
  });
  mocks.inviteViews.mockResolvedValue(new Map());
  mocks.resultFind.mockReturnValue(selected([]));
  mocks.photoFind.mockReturnValue(selected([]));
  mocks.attemptFind.mockReturnValue(selected([]));
  mocks.observationFind.mockReturnValue(selected([]));
  mocks.analysisViews.mockResolvedValue([]);
});

describe("application supplemental-observation read fence", () => {
  it("never returns an observation once its asynchronous retention deadline has elapsed", async () => {
    const response = await GET(
      new Request(
        `https://hire.example/api/workspace/applications/${IDS.application}`,
      ) as never,
      { params: { appId: IDS.application } },
    );

    expect(response.status).toBe(200);
    expect(mocks.observationFind).toHaveBeenCalledWith({
      workspaceId: IDS.workspace,
      applicationId: IDS.application,
      roundId: { $in: [] },
      $or: [
        { purgeEligibleAt: { $exists: false } },
        { purgeEligibleAt: { $gt: expect.any(Date) } },
      ],
    });
  });

  it("returns only opaque, ready control-side camera recording metadata for its exact round attempt", async () => {
    mocks.detail.mockResolvedValueOnce({
      application: { _id: IDS.application },
      candidate: { resumeText: "" },
      job: {},
      rounds: [{ _id: objectId(IDS.round), status: "completed" }],
      humanRounds: [],
    });
    mocks.resultFind.mockReturnValueOnce(
      selected([
        {
          roundId: objectId(IDS.round),
          attemptId: objectId(IDS.attempt),
          piiPurgedAt: undefined,
        },
      ]),
    );
    mocks.photoFind.mockReturnValueOnce(
      selected([
        {
          _id: objectId(IDS.recording),
          kind: "camera_recording",
          roundId: objectId(IDS.round),
          attemptId: objectId(IDS.attempt),
          capturedAt: new Date("2026-08-17T12:00:00.000Z"),
          bytes: 42_000,
          objectKey: "hire-media/must-never-serialize.webm",
        },
      ]),
    );

    const response = await GET(
      new Request(
        `https://hire.example/api/workspace/applications/${IDS.application}`,
      ) as never,
      { params: { appId: IDS.application } },
    );

    expect(mocks.photoFind).toHaveBeenCalledWith({
      workspaceId: IDS.workspace,
      applicationId: IDS.application,
      roundId: { $in: [expect.anything()] },
      kind: { $in: ["identity_photo", "camera_recording"] },
      state: "ready",
      active: true,
      $or: [
        { purgeEligibleAt: { $exists: false } },
        { purgeEligibleAt: { $gt: expect.any(Date) } },
      ],
    });
    const body = await response.json();
    expect(body.rounds[0].interviewRecording).toEqual({
      status: "ready",
      assetId: IDS.recording,
      capturedAt: "2026-08-17T12:00:00.000Z",
      bytes: 42_000,
    });
    expect(JSON.stringify(body)).not.toContain("objectKey");
    expect(JSON.stringify(body)).not.toContain("must-never-serialize");
  });

  it("reports an honest awaiting-transfer state when scores arrived before the camera asset", async () => {
    mocks.detail.mockResolvedValueOnce({
      application: { _id: IDS.application },
      candidate: { resumeText: "" },
      job: {},
      rounds: [{ _id: objectId(IDS.round), status: "completed" }],
      humanRounds: [],
    });
    mocks.resultFind.mockReturnValueOnce(
      selected([
        {
          roundId: objectId(IDS.round),
          attemptId: objectId(IDS.attempt),
          piiPurgedAt: undefined,
        },
      ]),
    );

    const response = await GET(
      new Request(
        `https://hire.example/api/workspace/applications/${IDS.application}`,
      ) as never,
      { params: { appId: IDS.application } },
    );

    const body = await response.json();
    expect(body.rounds[0].interviewRecording).toEqual({
      status: "awaiting_transfer",
    });
  });

  it("adds the complete native Hire analysis only to its matching round", async () => {
    mocks.detail.mockResolvedValueOnce({
      application: { _id: IDS.application },
      candidate: { resumeText: "" },
      job: {},
      rounds: [{ _id: objectId(IDS.round), status: "completed" }],
      humanRounds: [],
    });
    mocks.analysisViews.mockResolvedValueOnce([
      {
        id: "analysis-1",
        roundId: IDS.round,
        attemptId: IDS.attempt,
        status: "completed",
        capturedAt: "2026-08-17T12:00:00.000Z",
        durationMs: 90_000,
        facialFrameCount: 24,
        report: {
          metrics: {
            bodyLanguageScore: 81,
            eyeContactScore: 76,
            facialFrameCount: 24,
          },
          prosodySegments: [],
          facialSegments: [],
          facialTimeseries: [],
          timeline: [{ title: "Full report event" }],
          summary: { deliverySummary: "Full report summary" },
        },
      },
    ]);

    const response = await GET(
      new Request(
        `https://hire.example/api/workspace/applications/${IDS.application}`,
      ) as never,
      { params: { appId: IDS.application } },
    );

    expect(mocks.analysisViews).toHaveBeenCalledWith({
      workspaceId: IDS.workspace,
      applicationId: IDS.application,
    });
    const body = await response.json();
    expect(body.rounds[0].multimodalAnalysis).toMatchObject({
      id: "analysis-1",
      roundId: IDS.round,
      report: { summary: { deliverySummary: "Full report summary" } },
    });
  });
});
