import crypto from "crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AppError } from "@shared/errors";

const IDS = {
  workspace: "1".repeat(24),
  application: "2".repeat(24),
  job: "3".repeat(24),
  candidate: "4".repeat(24),
  packet: "5".repeat(24),
};
const SECRET = "ab".repeat(32);
const CAPABILITY = `${IDS.workspace}.${IDS.packet}.${SECRET}`;

const mocks = vi.hoisted(() => ({
  connect: vi.fn(),
  withTransaction: vi.fn(),
  resolveAuthority: vi.fn(),
  decodeCapability: vi.fn(),
  encodeCapability: vi.fn(),
  claimCandidate: vi.fn(),
  claimApplication: vi.fn(),
  applicationFindOne: vi.fn(),
  applicationExists: vi.fn(),
  jobUpdateOne: vi.fn(),
  jobExists: vi.fn(),
  candidateExists: vi.fn(),
  privacyExists: vi.fn(),
  workspaceExists: vi.fn(),
  packetFindOne: vi.fn(),
  packetUpdateOne: vi.fn(),
  packetCreate: vi.fn(),
  verdictCreate: vi.fn(),
  buildDecision: vi.fn(),
  buildSnapshot: vi.fn(),
}));

function query<T>(value: T) {
  return {
    session: vi.fn().mockResolvedValue(value),
    select: vi.fn().mockResolvedValue(value),
  };
}

vi.mock("@hire-decision-boundary", () => ({
  HireApplication: {
    findOne: mocks.applicationFindOne,
    exists: mocks.applicationExists,
    updateOne: vi.fn().mockResolvedValue({ matchedCount: 1 }),
  },
  HireCandidate: { exists: mocks.candidateExists },
  HireJob: { updateOne: mocks.jobUpdateOne, exists: mocks.jobExists },
  HirePrivacyRequest: { exists: mocks.privacyExists },
  HireWorkspace: { exists: mocks.workspaceExists },
  activeHireWorkspaceLifecycleFilter: () => ({}),
  withActiveHireWorkspaceWriteTransaction: mocks.withTransaction,
  claimHireCandidatePiiWriteFence: mocks.claimCandidate,
  HireCandidatePiiTombstoneError: class HireCandidatePiiTombstoneError extends Error {},
  claimNonTerminalHireApplicationDispatchFence: mocks.claimApplication,
  resolveWorkspaceWriteAuthority: mocks.resolveAuthority,
  decodeWorkspaceResourceCapability: mocks.decodeCapability,
  encodeWorkspaceResourceCapability: mocks.encodeCapability,
}));

vi.mock("@hire-decisions/models", () => ({
  HireSharePacket: {
    findOne: mocks.packetFindOne,
    updateOne: mocks.packetUpdateOne,
    create: mocks.packetCreate,
    findOneAndUpdate: vi.fn(),
    find: vi.fn(),
  },
  HireExternalVerdict: { create: mocks.verdictCreate },
}));

vi.mock("@hire-decisions/services/hireDecisionBoundary", () => ({
  connectHireDecisionDB: mocks.connect,
}));

vi.mock("@hire-decisions/services/decisionAggregateService", () => ({
  buildHireDecisionView: mocks.buildDecision,
  buildSharePacketSnapshot: mocks.buildSnapshot,
  HireDecisionError: class HireDecisionError extends Error {},
}));

import {
  __sharePacket,
  bootstrapSharePacket,
  createSharePacket,
  submitExternalVerdict,
} from "../services/sharePacketService";

const ctx = {
  workspace: { _id: { toString: () => IDS.workspace } },
  membership: {
    _id: { toString: () => "6".repeat(24) },
    name: "Recruiter",
    email: "recruiter@example.com",
  },
} as any;

const application = {
  _id: { toString: () => IDS.application },
  jobId: { toString: () => IDS.job },
  candidateId: { toString: () => IDS.candidate },
};

function packet(overrides: Record<string, unknown> = {}) {
  return {
    _id: { toString: () => IDS.packet },
    workspaceId: { toString: () => IDS.workspace },
    applicationId: { toString: () => IDS.application },
    jobId: { toString: () => IDS.job },
    candidateId: { toString: () => IDS.candidate },
    allowedSections: ["candidate_brief", "human_scorecards"],
    snapshot: {
      version: 1,
      candidateBrief: {
        candidateName: "Ada Lovelace",
        jobTitle: "Senior Engineer",
      },
      humanScorecards: {
        total: {
          count: 1,
          recommendations: { strong_yes: 1, yes: 0, no: 0, strong_no: 0 },
          dimensions: [],
        },
        member: {
          count: 1,
          recommendations: { strong_yes: 1, yes: 0, no: 0, strong_no: 0 },
          dimensions: [],
        },
        kit: {
          count: 0,
          recommendations: { strong_yes: 0, yes: 0, no: 0, strong_no: 0 },
          dimensions: [],
        },
      },
      internalSecret: "must-not-leak",
    },
    secretHash: crypto.createHash("sha256").update(SECRET).digest("hex"),
    active: true,
    status: "active",
    expiresAt: new Date("2099-08-14T00:00:00.000Z"),
    createdAt: new Date("2026-08-14T00:00:00.000Z"),
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.connect.mockResolvedValue(undefined);
  mocks.withTransaction.mockImplementation(
    async (
      _workspace: unknown,
      _authority: unknown,
      work: (session: object) => unknown,
    ) => work({}),
  );
  mocks.resolveAuthority.mockResolvedValue({ toString: () => "7".repeat(24) });
  mocks.decodeCapability.mockImplementation((raw: string) =>
    raw === CAPABILITY
      ? { workspaceId: IDS.workspace, resourceId: IDS.packet, secret: SECRET }
      : null,
  );
  mocks.encodeCapability.mockImplementation(
    (workspaceId: string, resourceId: string, secret: string) =>
      `${workspaceId}.${resourceId}.${secret}`,
  );
  mocks.claimCandidate.mockResolvedValue(undefined);
  mocks.claimApplication.mockResolvedValue(undefined);
  mocks.applicationFindOne.mockResolvedValue(application);
  mocks.applicationExists.mockReturnValue(query({ _id: application._id }));
  mocks.jobUpdateOne.mockResolvedValue({ matchedCount: 1 });
  mocks.jobExists.mockReturnValue(query({ _id: application.jobId }));
  mocks.candidateExists.mockReturnValue(
    query({ _id: application.candidateId }),
  );
  mocks.privacyExists.mockReturnValue(query(null));
  mocks.workspaceExists.mockReturnValue(query({ _id: ctx.workspace._id }));
  mocks.packetUpdateOne.mockResolvedValue({ matchedCount: 1 });
  mocks.verdictCreate.mockResolvedValue([]);
  mocks.buildDecision.mockResolvedValue({
    coordinates: {
      workspaceId: IDS.workspace,
      applicationId: IDS.application,
      jobId: IDS.job,
      candidateId: IDS.candidate,
    },
  });
  mocks.buildSnapshot.mockReturnValue({
    version: 1,
    candidateBrief: {
      candidateName: "Ada Lovelace",
      jobTitle: "Senior Engineer",
    },
  });
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("share packet service", () => {
  it("explicitly projects only section-gated immutable snapshot fields", () => {
    const view = __sharePacket.serializePublicSnapshot(packet() as any);

    expect(view).toEqual({
      version: 1,
      candidateBrief: {
        candidateName: "Ada Lovelace",
        jobTitle: "Senior Engineer",
      },
      humanScorecards: expect.objectContaining({
        member: expect.objectContaining({ count: 1 }),
      }),
    });
    expect(JSON.stringify(view)).not.toContain("must-not-leak");
    expect(view).not.toHaveProperty("aiAssessments");
  });

  it("creates one hash-only, copy-only capability without an email side effect", async () => {
    mocks.packetFindOne.mockResolvedValueOnce(null);
    mocks.packetCreate.mockImplementation(async (rows: any[]) => [
      {
        ...rows[0],
        _id: { toString: () => IDS.packet },
        createdAt: new Date("2026-08-14T00:00:00.000Z"),
      },
    ]);
    vi.stubEnv("HIRE_PUBLIC_URL", "https://hire.example/");

    const result = await createSharePacket(ctx, {
      applicationId: IDS.application,
      allowedSections: ["candidate_brief"],
      operationId: "11111111-1111-4111-8111-111111111111",
    });

    expect(result.created).toBe(true);
    expect(result.shareUrl).toMatch(/^https:\/\/hire\.example\/share-packet\//);
    const created = mocks.packetCreate.mock.calls[0]?.[0]?.[0];
    expect(created.secretHash).toMatch(/^[a-f0-9]{64}$/);
    expect(created.secretHash).not.toBe(SECRET);
    expect(JSON.stringify(created)).not.toContain("#packet=");
    expect(mocks.buildSnapshot).toHaveBeenCalledWith(
      expect.objectContaining({ coordinates: expect.anything() }),
      ["candidate_brief"],
    );
    expect(mocks.verdictCreate).not.toHaveBeenCalled();
  });

  it("recovers a concurrent idempotent create without recreating a raw capability", async () => {
    mocks.packetFindOne
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce(packet({ allowedSections: ["candidate_brief"] }));
    mocks.packetCreate.mockRejectedValueOnce({ code: 11000 });

    const result = await createSharePacket(ctx, {
      applicationId: IDS.application,
      allowedSections: ["candidate_brief"],
      operationId: "11111111-1111-4111-8111-111111111111",
    });

    expect(result).toMatchObject({
      created: false,
      shareUrl: null,
      packet: { id: IDS.packet },
    });
    expect(mocks.packetCreate).toHaveBeenCalledOnce();
    expect(mocks.encodeCapability).not.toHaveBeenCalled();
  });

  it("returns only the immutable packet snapshot after all public fences claim the rows", async () => {
    const activePacket = packet();
    mocks.packetFindOne.mockReturnValue({
      select: vi.fn().mockResolvedValue(activePacket),
    });

    const result = await bootstrapSharePacket({
      packetId: IDS.packet,
      capability: CAPABILITY,
    });

    expect(result).toEqual({
      snapshot: expect.objectContaining({
        version: 1,
        candidateBrief: expect.anything(),
      }),
    });
    expect(mocks.claimCandidate).toHaveBeenCalledOnce();
    expect(mocks.claimApplication).toHaveBeenCalledOnce();
    expect(mocks.packetUpdateOne).toHaveBeenCalledWith(
      expect.objectContaining({ active: true, status: "active" }),
      expect.objectContaining({
        $set: expect.objectContaining({ updatedAt: expect.any(Date) }),
      }),
      expect.anything(),
    );
  });

  it("maps a lost public workspace authority race to the inactive state", async () => {
    mocks.withTransaction.mockRejectedValueOnce(
      new AppError(
        "Workspace write authority is no longer active",
        403,
        "MEMBER_REMOVED",
      ),
    );

    await expect(
      bootstrapSharePacket({
        packetId: IDS.packet,
        capability: CAPABILITY,
      }),
    ).resolves.toBeNull();
  });

  it("conditionally consumes the packet before persisting the one external verdict", async () => {
    const activePacket = packet();
    mocks.packetFindOne.mockReturnValue({
      select: vi.fn().mockResolvedValue(activePacket),
    });

    const result = await submitExternalVerdict({
      packetId: IDS.packet,
      capability: CAPABILITY,
      recommendation: "yes",
      comment: "Evidence supports a focused follow-up.",
    });

    expect(result).toEqual({ state: "submitted" });
    expect(mocks.packetUpdateOne).toHaveBeenCalledWith(
      expect.objectContaining({ active: true, status: "active" }),
      expect.objectContaining({
        $set: expect.objectContaining({
          active: false,
          status: "verdict_submitted",
        }),
      }),
      expect.anything(),
    );
    expect(mocks.verdictCreate).toHaveBeenCalledWith(
      [
        expect.objectContaining({
          packetId: activePacket._id,
          recommendation: "yes",
          comment: "Evidence supports a focused follow-up.",
        }),
      ],
      expect.anything(),
    );
    expect(mocks.packetUpdateOne.mock.invocationCallOrder[0]).toBeLessThan(
      mocks.verdictCreate.mock.invocationCallOrder[0],
    );
  });
});
