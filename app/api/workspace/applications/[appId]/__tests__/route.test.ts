import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  requireMembership: vi.fn(),
  detail: vi.fn(),
  inviteViews: vi.fn(),
  resultFind: vi.fn(),
  photoFind: vi.fn(),
  attemptFind: vi.fn(),
  ingestionFind: vi.fn(),
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
  HireEngineIngestionEvent: { find: mocks.ingestionFind },
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
  screenRecording: "9".repeat(24),
  runtimeSession: "f".repeat(24),
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
  mocks.attemptFind.mockReturnValue(selected([{
    _id: objectId(IDS.attempt),
    roundId: objectId(IDS.round),
    sequence: 1,
    status: "completed",
  }]));
  mocks.ingestionFind.mockReturnValue(selected([]));
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
      kind: {
        $in: ["identity_photo", "camera_recording", "screen_recording"],
      },
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

  it("returns a V6 shared-display asset only for the completed result attempt", async () => {
    mocks.detail.mockResolvedValueOnce({
      application: { _id: IDS.application },
      candidate: { resumeText: "" },
      job: {},
      rounds: [
        {
          _id: objectId(IDS.round),
          status: "completed",
          consentVersion: "hire-ai-v6-2026-08-20",
        },
      ],
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
          _id: objectId(IDS.screenRecording),
          kind: "screen_recording",
          roundId: objectId(IDS.round),
          attemptId: objectId(IDS.attempt),
          capturedAt: new Date("2026-08-20T12:00:00.000Z"),
          bytes: 84_000,
          objectKey: "hire-media/must-never-serialize-screen.webm",
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
    expect(body.rounds[0].screenRecording).toEqual({
      status: "ready",
      assetId: IDS.screenRecording,
      capturedAt: "2026-08-20T12:00:00.000Z",
      bytes: 84_000,
    });
    expect(JSON.stringify(body)).not.toContain("objectKey");
    expect(JSON.stringify(body)).not.toContain("must-never-serialize-screen");
  });

  it("does not invent a pending display recording for pre-V6 rounds", async () => {
    mocks.detail.mockResolvedValueOnce({
      application: { _id: IDS.application },
      candidate: { resumeText: "" },
      job: {},
      rounds: [
        {
          _id: objectId(IDS.round),
          status: "completed",
          consentVersion: "hire-ai-v5-2026-08-19",
        },
      ],
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
    expect(body.rounds[0].screenRecording).toBeNull();
  });

  it("does not treat an unknown V6-prefixed receipt as display consent", async () => {
    mocks.detail.mockResolvedValueOnce({
      application: { _id: IDS.application },
      candidate: { resumeText: "" },
      job: {},
      rounds: [
        {
          _id: objectId(IDS.round),
          status: "completed",
          consentVersion: "hire-ai-v6-2099-01-01",
        },
      ],
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
    expect(body.rounds[0].screenRecording).toBeNull();
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

  it("returns the latest versioned terminal media reason instead of polling forever", async () => {
    mocks.detail.mockResolvedValueOnce({
      application: { _id: IDS.application },
      candidate: { resumeText: "" },
      job: {},
      rounds: [{
        _id: objectId(IDS.round),
        status: "completed",
        consentVersion: "hire-ai-v6-2026-08-20",
      }],
      humanRounds: [],
    });
    mocks.resultFind.mockReturnValueOnce(
      selected([{
        roundId: objectId(IDS.round),
        attemptId: objectId(IDS.attempt),
        piiPurgedAt: undefined,
      }]),
    );
    mocks.attemptFind.mockReturnValueOnce(
      selected([{
        _id: objectId(IDS.attempt),
        roundId: objectId(IDS.round),
        sequence: 1,
        status: "completed",
      }]),
    );
    mocks.ingestionFind.mockReturnValueOnce(
      selected([{
        roundId: objectId(IDS.round),
        attempt: 1,
        revision: 2,
        mediaCompletion: {
          contractVersion: 1,
          camera: { status: "unavailable", reason: "retry_exhausted" },
          screen: { status: "unavailable", reason: "upload_expired" },
        },
      }]),
    );

    const response = await GET(
      new Request(
        `https://hire.example/api/workspace/applications/${IDS.application}`,
      ) as never,
      { params: { appId: IDS.application } },
    );

    const body = await response.json();
    expect(body.rounds[0].interviewRecording).toEqual({
      status: "unavailable",
      reason: "retry_exhausted",
    });
    expect(body.rounds[0].screenRecording).toEqual({
      status: "unavailable",
      reason: "upload_expired",
    });
  });

  it("does not reuse terminal media from an older attempt", async () => {
    mocks.detail.mockResolvedValueOnce({
      application: { _id: IDS.application },
      candidate: { resumeText: "" },
      job: {},
      rounds: [{ _id: objectId(IDS.round), status: "completed" }],
      humanRounds: [],
    });
    mocks.attemptFind.mockReturnValueOnce(
      selected([{
        _id: objectId("8".repeat(24)),
        roundId: objectId(IDS.round),
        sequence: 2,
        status: "completed",
      }]),
    );
    mocks.ingestionFind.mockReturnValueOnce(
      selected([{
        roundId: objectId(IDS.round),
        attempt: 1,
        revision: 3,
        mediaCompletion: {
          contractVersion: 1,
          camera: { status: "unavailable", reason: "upload_expired" },
          screen: { status: "not_required" },
        },
      }]),
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

  it("binds results, ready assets, and terminal media to one latest attempt", async () => {
    const latestAttemptId = "7".repeat(24);
    mocks.detail.mockResolvedValueOnce({
      application: { _id: IDS.application },
      candidate: { resumeText: "" },
      job: {},
      rounds: [{
        _id: objectId(IDS.round),
        status: "completed",
        consentVersion: "hire-ai-v6-2026-08-20",
      }],
      humanRounds: [],
    });
    mocks.attemptFind.mockReturnValueOnce(selected([
      {
        _id: objectId(IDS.attempt),
        roundId: objectId(IDS.round),
        sequence: 1,
        status: "completed",
      },
      {
        _id: objectId(latestAttemptId),
        roundId: objectId(IDS.round),
        sequence: 2,
        status: "completed",
      },
    ]));
    mocks.resultFind.mockReturnValueOnce(selected([
      {
        roundId: objectId(IDS.round),
        attemptId: objectId(latestAttemptId),
        projection: { overallScore: 91, marker: "latest" },
        evidenceIndex: ["latest-evidence"],
      },
      {
        roundId: objectId(IDS.round),
        attemptId: objectId(IDS.attempt),
        projection: { overallScore: 12, marker: "older" },
        evidenceIndex: ["older-evidence"],
      },
    ]));
    mocks.photoFind.mockReturnValueOnce(selected([
      {
        _id: objectId(IDS.recording),
        kind: "camera_recording",
        roundId: objectId(IDS.round),
        attemptId: objectId(IDS.attempt),
        capturedAt: new Date("2026-08-20T12:00:00.000Z"),
        bytes: 42_000,
      },
      {
        _id: objectId(IDS.screenRecording),
        kind: "screen_recording",
        roundId: objectId(IDS.round),
        attemptId: objectId(IDS.attempt),
        capturedAt: new Date("2026-08-20T12:00:00.000Z"),
        bytes: 84_000,
      },
    ]));
    mocks.ingestionFind.mockReturnValueOnce(selected([{
      roundId: objectId(IDS.round),
      attempt: 2,
      revision: 3,
      mediaCompletion: {
        contractVersion: 1,
        camera: { status: "unavailable", reason: "retry_exhausted" },
        screen: { status: "unavailable", reason: "upload_expired" },
      },
    }]));

    const response = await GET(
      new Request(
        `https://hire.example/api/workspace/applications/${IDS.application}`,
      ) as never,
      { params: { appId: IDS.application } },
    );

    const body = await response.json();
    expect(body.rounds[0]).toMatchObject({
      assessment: { overallScore: 91, marker: "latest" },
      evidenceIndex: ["latest-evidence"],
      interviewRecording: {
        status: "unavailable",
        reason: "retry_exhausted",
      },
      screenRecording: {
        status: "unavailable",
        reason: "upload_expired",
      },
    });
    expect(mocks.ingestionFind).toHaveBeenCalledWith(expect.objectContaining({
      status: "processed",
      terminalOutcome: "processed",
    }));
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

  it("passes neutral interview-validation events through only to their matching round", async () => {
    mocks.detail.mockResolvedValueOnce({
      application: { _id: IDS.application },
      candidate: { resumeText: "" },
      job: {},
      rounds: [{ _id: objectId(IDS.round), status: "completed" }],
      humanRounds: [],
    });
    mocks.observationFind.mockReturnValueOnce(
      selected([
        {
          roundId: objectId(IDS.round),
          runtimeSessionId: objectId(IDS.runtimeSession),
          revision: 1,
          observedAt: new Date("2026-08-19T12:00:00.000Z"),
          report: {
            status: "completed",
            capture: { camera: "captured", browserVisibility: "captured" },
            events: [
              {
                kind: "speech_video_unverified",
                source: "speech_video_corroboration",
                startMs: 10_000,
                endMs: 12_000,
              },
            ],
          },
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
    expect(body.rounds[0].supplementalObservations).toEqual([
      {
        observedAt: "2026-08-19T12:00:00.000Z",
        report: {
          status: "completed",
          capture: { camera: "captured", browserVisibility: "captured" },
          events: [
            {
              kind: "speech_video_unverified",
              source: "speech_video_corroboration",
              startMs: 10_000,
              endMs: 12_000,
            },
          ],
        },
      },
    ]);
    expect(JSON.stringify(body)).not.toMatch(/score|rank|recommendation/i);
  });

  it("surfaces cumulative validation revisions once per runtime session", async () => {
    mocks.detail.mockResolvedValueOnce({
      application: { _id: IDS.application },
      candidate: { resumeText: "" },
      job: {},
      rounds: [{ _id: objectId(IDS.round), status: "completed" }],
      humanRounds: [],
    });
    const capture = { camera: "captured", browserVisibility: "captured" } as const;
    const fullscreenEvent = {
      kind: "fullscreen_exited" as const,
      source: "fullscreen" as const,
      startMs: 1_000,
      endMs: 1_000,
    };
    const windowEvent = {
      kind: "browser_window_not_visible" as const,
      source: "browser_visibility" as const,
      startMs: 2_000,
      endMs: 2_500,
    };
    const microphoneEvent = {
      kind: "microphone_interrupted" as const,
      source: "microphone_track" as const,
      startMs: 3_000,
      endMs: 3_250,
    };
    mocks.observationFind.mockReturnValueOnce(
      selected([
        {
          roundId: objectId(IDS.round),
          runtimeSessionId: objectId(IDS.runtimeSession),
          revision: 1,
          observedAt: new Date("2026-08-19T12:00:00.000Z"),
          report: { status: "completed", capture, events: [fullscreenEvent] },
        },
        {
          roundId: objectId(IDS.round),
          runtimeSessionId: objectId(IDS.runtimeSession),
          revision: 2,
          observedAt: new Date("2026-08-19T12:01:00.000Z"),
          report: {
            status: "completed",
            capture,
            events: [fullscreenEvent, windowEvent],
          },
        },
        {
          roundId: objectId(IDS.round),
          runtimeSessionId: objectId(IDS.runtimeSession),
          revision: 3,
          observedAt: new Date("2026-08-19T12:02:00.000Z"),
          report: {
            status: "completed",
            capture,
            events: [fullscreenEvent, windowEvent, microphoneEvent],
          },
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
    expect(body.rounds[0].supplementalObservations).toEqual([
      {
        observedAt: "2026-08-19T12:02:00.000Z",
        report: {
          status: "completed",
          capture,
          events: [fullscreenEvent, windowEvent, microphoneEvent],
        },
      },
    ]);
  });
});
