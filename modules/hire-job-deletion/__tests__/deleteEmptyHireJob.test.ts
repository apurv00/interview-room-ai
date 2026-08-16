import mongoose from "mongoose";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { AppError } from "@shared/errors";

const { activity, mocks, session } = vi.hoisted(() => {
  const activity = () => ({ exists: vi.fn() });
  const session = { id: "job-delete-session" };
  return {
    session,
    activity: {
      onboarding: activity(),
      intake: activity(),
      application: activity(),
      screeningGate: activity(),
      invitationBatch: activity(),
      invitationBatchItem: activity(),
      round: activity(),
      attempt: activity(),
      result: activity(),
      guestSession: activity(),
      consent: activity(),
      aiDelivery: activity(),
      humanRound: activity(),
      interviewKit: activity(),
      humanKitDelivery: activity(),
      scorecard: activity(),
      emailOutbox: activity(),
      statusLink: activity(),
      sharePacket: activity(),
      externalVerdict: activity(),
      media: activity(),
      assessmentExport: activity(),
      assessmentCleanup: activity(),
      reportExport: activity(),
      reportCleanup: activity(),
    },
    mocks: {
      fence: vi.fn(),
      member: { exists: vi.fn() },
      job: { findOne: vi.fn(), deleteOne: vi.fn() },
      requirements: { deleteMany: vi.fn() },
    },
  };
});

vi.mock("../../hire/services/hireWorkspaceWriteFence", () => ({
  withActiveHireWorkspaceWriteTransaction: (...args: unknown[]) =>
    mocks.fence(...args),
}));
vi.mock("../../hire/models/HireJob", () => ({ HireJob: mocks.job }));
vi.mock("../../hire/models/HireJobRequirementVersion", () => ({
  HireJobRequirementVersion: mocks.requirements,
}));
vi.mock("../../hire/models/HireWorkspaceMember", () => ({
  HireWorkspaceMember: mocks.member,
}));
vi.mock("../../hire-onboarding/models/HireOnboardingTestDrive", () => ({
  HireOnboardingTestDrive: activity.onboarding,
}));
vi.mock("../../hire/models/HireIntakeTask", () => ({
  HireIntakeTask: activity.intake,
}));
vi.mock("../../hire/models/HireApplication", () => ({
  HireApplication: activity.application,
}));
vi.mock("../../hire/models/HireScreeningGate", () => ({
  HireScreeningGate: activity.screeningGate,
}));
vi.mock("../../hire/models/HireInvitationBatch", () => ({
  HireInvitationBatch: activity.invitationBatch,
}));
vi.mock("../../hire/models/HireInvitationBatchItem", () => ({
  HireInvitationBatchItem: activity.invitationBatchItem,
}));
vi.mock("../../hire/models/HireRound", () => ({ HireRound: activity.round }));
vi.mock("../../hire/models/HireInterviewAttempt", () => ({
  HireInterviewAttempt: activity.attempt,
}));
vi.mock("../../hire/models/HireInterviewResult", () => ({
  HireInterviewResult: activity.result,
}));
vi.mock("../../hire/models/HireGuestSession", () => ({
  HireGuestSession: activity.guestSession,
}));
vi.mock("../../hire/models/HireConsentReceipt", () => ({
  HireConsentReceipt: activity.consent,
}));
vi.mock("../../hire/models/HireAiInviteDelivery", () => ({
  HireAiInviteDelivery: activity.aiDelivery,
}));
vi.mock("../../hire/models/HireHumanRound", () => ({
  HireHumanRound: activity.humanRound,
}));
vi.mock("../../hire/models/HireInterviewKit", () => ({
  HireInterviewKit: activity.interviewKit,
}));
vi.mock("../../hire/models/HireHumanKitDelivery", () => ({
  HireHumanKitDelivery: activity.humanKitDelivery,
}));
vi.mock("../../hire/models/HireHumanScorecard", () => ({
  HireHumanScorecard: activity.scorecard,
}));
vi.mock("../../hire/models/HireEmailOutbox", () => ({
  HireEmailOutbox: activity.emailOutbox,
}));
vi.mock("../../hire-status/models/HireCandidateStatusLink", () => ({
  HireCandidateStatusLink: activity.statusLink,
}));
vi.mock("../../hire-decisions/models/HireSharePacket", () => ({
  HireSharePacket: activity.sharePacket,
}));
vi.mock("../../hire-decisions/models/HireExternalVerdict", () => ({
  HireExternalVerdict: activity.externalVerdict,
}));
vi.mock("../../hire/models/HireMediaAsset", () => ({
  HireMediaAsset: activity.media,
}));
vi.mock("../../hire-decisions/models/HireAssessmentExport", () => ({
  HireAssessmentExport: activity.assessmentExport,
}));
vi.mock("../../hire-decisions/models/HireAssessmentExportCleanup", () => ({
  HireAssessmentExportCleanup: activity.assessmentCleanup,
}));
vi.mock("../../hire-reports/models/HireReportExport", () => ({
  HireReportExport: activity.reportExport,
}));
vi.mock("../../hire-reports/models/HireReportExportCleanup", () => ({
  HireReportExportCleanup: activity.reportCleanup,
}));

import { deleteEmptyHireJob } from "../services/deleteEmptyHireJob";

const WORKSPACE_ID = new mongoose.Types.ObjectId("111111111111111111111111");
const MEMBER_ID = new mongoose.Types.ObjectId("222222222222222222222222");
const JOB_ID = new mongoose.Types.ObjectId("333333333333333333333333");
const INPUT = {
  confirmationTitle: "Backend Engineer",
  acknowledgeEmptyJobDeletion: true as const,
};

const ADMIN = {
  workspace: { _id: WORKSPACE_ID },
  membership: {
    _id: MEMBER_ID,
    role: "admin",
    name: "HR Admin",
    email: "admin@example.com",
  },
} as never;

function sessionQuery(value: unknown) {
  return { session: vi.fn().mockResolvedValue(value) };
}

function job(overrides: Record<string, unknown> = {}) {
  return {
    _id: JOB_ID,
    workspaceId: WORKSPACE_ID,
    title: "Backend Engineer",
    status: "open",
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.fence.mockImplementation(
    async (
      _workspaceId: unknown,
      _memberId: unknown,
      work: (transactionSession: unknown) => Promise<unknown>,
    ) => work(session),
  );
  mocks.member.exists.mockReturnValue(sessionQuery({ _id: MEMBER_ID }));
  mocks.job.findOne.mockReturnValue(sessionQuery(job()));
  mocks.job.deleteOne.mockResolvedValue({ deletedCount: 1 });
  mocks.requirements.deleteMany.mockResolvedValue({ deletedCount: 1 });
  for (const model of Object.values(activity)) {
    model.exists.mockReturnValue(sessionQuery(null));
  }
});

describe("deleteEmptyHireJob", () => {
  it("removes only job-owned requirement versions before the pristine job root", async () => {
    await expect(
      deleteEmptyHireJob(ADMIN, JOB_ID.toString(), INPUT),
    ).resolves.toEqual({
      jobId: JOB_ID.toString(),
    });

    expect(mocks.fence).toHaveBeenCalledWith(
      WORKSPACE_ID,
      MEMBER_ID,
      expect.any(Function),
    );
    expect(mocks.job.findOne).toHaveBeenCalledWith({
      _id: JOB_ID,
      workspaceId: WORKSPACE_ID,
    });
    expect(mocks.member.exists).toHaveBeenCalledWith({
      _id: MEMBER_ID,
      workspaceId: WORKSPACE_ID,
      authState: "active",
      role: "admin",
    });
    expect(mocks.requirements.deleteMany).toHaveBeenCalledWith(
      { workspaceId: WORKSPACE_ID, jobId: JOB_ID },
      { session },
    );
    expect(mocks.job.deleteOne).toHaveBeenCalledWith(
      { _id: JOB_ID, workspaceId: WORKSPACE_ID, status: "open" },
      { session },
    );
    expect(
      mocks.requirements.deleteMany.mock.invocationCallOrder[0],
    ).toBeLessThan(mocks.job.deleteOne.mock.invocationCallOrder[0]);
  });

  it("uses a workspace-leading scope for every downstream activity check", async () => {
    await deleteEmptyHireJob(ADMIN, JOB_ID.toString(), INPUT);

    for (const model of Object.values(activity)) {
      expect(model.exists).toHaveBeenCalledWith({
        workspaceId: WORKSPACE_ID,
        jobId: JOB_ID,
      });
    }
  });

  it("runs dependency checks serially on the transaction session", async () => {
    let releaseFirstCheck: (() => void) | undefined;
    const firstCheck = new Promise<null>((resolve) => {
      releaseFirstCheck = () => resolve(null);
    });
    activity.onboarding.exists.mockReturnValueOnce({
      session: vi.fn().mockReturnValue(firstCheck),
    });

    const deletion = deleteEmptyHireJob(ADMIN, JOB_ID.toString(), INPUT);
    await Promise.resolve();
    expect(activity.intake.exists).not.toHaveBeenCalled();

    releaseFirstCheck?.();
    await expect(deletion).resolves.toEqual({ jobId: JOB_ID.toString() });
  });

  it.each(Object.keys(activity))(
    "fails closed without deleting anything when %s exists",
    async (name) => {
      const model = activity[name as keyof typeof activity];
      model.exists.mockReturnValueOnce(sessionQuery({ _id: `${name}-row` }));

      await expect(
        deleteEmptyHireJob(ADMIN, JOB_ID.toString(), INPUT),
      ).rejects.toMatchObject({
        code: "JOB_HAS_ACTIVITY",
      });
      expect(mocks.requirements.deleteMany).not.toHaveBeenCalled();
      expect(mocks.job.deleteOne).not.toHaveBeenCalled();
    },
  );

  it("requires an active workspace admin before entering the write transaction", async () => {
    const member = {
      ...ADMIN,
      membership: { ...ADMIN.membership, role: "member" },
    };

    await expect(
      deleteEmptyHireJob(member, JOB_ID.toString(), INPUT),
    ).rejects.toBeInstanceOf(AppError);
    expect(mocks.fence).not.toHaveBeenCalled();
  });

  it("rechecks admin authority inside the write transaction", async () => {
    mocks.member.exists.mockReturnValueOnce(sessionQuery(null));

    await expect(
      deleteEmptyHireJob(ADMIN, JOB_ID.toString(), INPUT),
    ).rejects.toMatchObject({ statusCode: 403 });
    expect(mocks.job.findOne).not.toHaveBeenCalled();
    expect(mocks.requirements.deleteMany).not.toHaveBeenCalled();
    expect(mocks.job.deleteOne).not.toHaveBeenCalled();
  });

  it("does not use an approximate or stale confirmation title", async () => {
    await expect(
      deleteEmptyHireJob(ADMIN, JOB_ID.toString(), {
        ...INPUT,
        confirmationTitle: "Backend engineer",
      }),
    ).rejects.toMatchObject({ code: "JOB_DELETE_CONFIRMATION_MISMATCH" });
    expect(mocks.requirements.deleteMany).not.toHaveBeenCalled();
  });

  it("retains terminal job history instead of deleting a closed job", async () => {
    mocks.job.findOne.mockReturnValueOnce(
      sessionQuery(job({ status: "closed" })),
    );

    await expect(
      deleteEmptyHireJob(ADMIN, JOB_ID.toString(), INPUT),
    ).rejects.toMatchObject({
      code: "JOB_DELETE_CLOSED",
    });
    expect(mocks.requirements.deleteMany).not.toHaveBeenCalled();
  });

  it("requires the public apply link to be disabled before deletion", async () => {
    mocks.job.findOne.mockReturnValueOnce(
      sessionQuery(
        job({
          applyPageEnabled: true,
          applyTokenHash: "a".repeat(64),
        }),
      ),
    );

    await expect(
      deleteEmptyHireJob(ADMIN, JOB_ID.toString(), INPUT),
    ).rejects.toMatchObject({ code: "JOB_DELETE_APPLY_LINK_ACTIVE" });
    expect(activity.onboarding.exists).not.toHaveBeenCalled();
    expect(mocks.requirements.deleteMany).not.toHaveBeenCalled();
    expect(mocks.job.deleteOne).not.toHaveBeenCalled();
  });

  it("does not reveal or delete a job outside the current workspace", async () => {
    mocks.job.findOne.mockReturnValueOnce(sessionQuery(null));

    await expect(
      deleteEmptyHireJob(ADMIN, JOB_ID.toString(), INPUT),
    ).rejects.toMatchObject({
      statusCode: 404,
    });
    expect(mocks.requirements.deleteMany).not.toHaveBeenCalled();
  });

  it("fails safely when the root changes before deletion", async () => {
    mocks.job.deleteOne.mockResolvedValueOnce({ deletedCount: 0 });

    await expect(
      deleteEmptyHireJob(ADMIN, JOB_ID.toString(), INPUT),
    ).rejects.toMatchObject({
      code: "JOB_DELETE_RACE",
    });
  });

  it("rejects malformed ids before opening a transaction", async () => {
    await expect(
      deleteEmptyHireJob(ADMIN, "not-a-job-id", INPUT),
    ).rejects.toMatchObject({
      code: "INVALID_JOB_ID",
    });
    expect(mocks.fence).not.toHaveBeenCalled();
  });
});
