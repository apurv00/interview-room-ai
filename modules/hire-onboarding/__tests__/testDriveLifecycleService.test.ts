import mongoose from 'mongoose'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const IDS = {
  workspace: new mongoose.Types.ObjectId('111111111111111111111111'),
  member: new mongoose.Types.ObjectId('222222222222222222222222'),
  job: new mongoose.Types.ObjectId('333333333333333333333333'),
  candidate: new mongoose.Types.ObjectId('444444444444444444444444'),
  application: new mongoose.Types.ObjectId('555555555555555555555555'),
  round: new mongoose.Types.ObjectId('666666666666666666666666'),
  testDrive: new mongoose.Types.ObjectId('777777777777777777777777'),
}
const NOW = new Date('2026-08-15T10:00:00.000Z')

const mocks = vi.hoisted(() => ({
  connect: vi.fn(),
  inngestSend: vi.fn(),
  loggerWarn: vi.fn(),
  deliverRuntimeRevocation: vi.fn(),
  workspaceExists: vi.fn(),
  statusRevoke: vi.fn(),
  statusDeleteMany: vi.fn(),
  shareUpdateMany: vi.fn(),
  shareDeleteMany: vi.fn(),
  verdictUpdateMany: vi.fn(),
  verdictDeleteMany: vi.fn(),
  assessmentCancel: vi.fn(),
  assessmentDeleteObjects: vi.fn(),
  assessmentDeleteMany: vi.fn(),
  reportCancel: vi.fn(),
  reportDeleteMany: vi.fn(),
  testDriveFind: vi.fn(),
  testDriveFindOne: vi.fn(),
  testDriveFindOneAndUpdate: vi.fn(),
  testDriveUpdateOne: vi.fn(),
  testDriveUpdateMany: vi.fn(),
  testDriveDeleteOne: vi.fn(),
  roundFind: vi.fn(),
  roundUpdateMany: vi.fn(),
  roundExists: vi.fn(),
  roundDeleteMany: vi.fn(),
  guestUpdateMany: vi.fn(),
  guestDeleteMany: vi.fn(),
  handoffUpdateMany: vi.fn(),
  handoffDeleteMany: vi.fn(),
  ingestionDeleteMany: vi.fn(),
  attemptUpdateMany: vi.fn(),
  attemptDeleteMany: vi.fn(),
  consentDeleteMany: vi.fn(),
  emailOutboxDeleteMany: vi.fn(),
  intakeTaskExists: vi.fn(),
  humanKitDeliveryDeleteMany: vi.fn(),
  interviewKitDeleteMany: vi.fn(),
  humanScorecardDeleteMany: vi.fn(),
  humanRoundDeleteMany: vi.fn(),
  invitationBatchDeleteMany: vi.fn(),
  invitationBatchItemDeleteMany: vi.fn(),
  screeningGateDeleteMany: vi.fn(),
  privacyRequestDeleteMany: vi.fn(),
  resultDeleteMany: vi.fn(),
  deliveryDeleteMany: vi.fn(),
  mediaFind: vi.fn(),
  mediaUpdateOne: vi.fn(),
  mediaExists: vi.fn(),
  mediaDeleteMany: vi.fn(),
  applicationExists: vi.fn(),
  applicationDeleteMany: vi.fn(),
  candidateDeleteMany: vi.fn(),
  requirementDeleteMany: vi.fn(),
  jobDeleteMany: vi.fn(),
}))

vi.mock('@shared/services/inngest', () => ({
  inngest: { send: (...args: unknown[]) => mocks.inngestSend(...args) },
}))

vi.mock('@shared/logger', () => ({
  logger: { warn: (...args: unknown[]) => mocks.loggerWarn(...args) },
}))

vi.mock('../../hire/onboardingLifecycleBoundary', () => ({
  connectHireControlDB: (...args: unknown[]) => mocks.connect(...args),
  deliverRuntimeRevocation: (...args: unknown[]) => mocks.deliverRuntimeRevocation(...args),
  activeHireWorkspaceLifecycleFilter: () => ({
    $or: [{ lifecycleState: 'active' }, { lifecycleState: { $exists: false } }],
  }),
  revokeCandidateStatusLinksForScope: (...args: unknown[]) => mocks.statusRevoke(...args),
  cancelHireAssessmentExports: (...args: unknown[]) => mocks.assessmentCancel(...args),
  deleteHireAssessmentExportObjects: (...args: unknown[]) => mocks.assessmentDeleteObjects(...args),
  cancelHireReportExportsForLifecycle: (...args: unknown[]) => mocks.reportCancel(...args),
  HireWorkspace: { exists: (...args: unknown[]) => mocks.workspaceExists(...args) },
  HireCandidateStatusLink: {
    deleteMany: (...args: unknown[]) => mocks.statusDeleteMany(...args),
  },
  HireSharePacket: {
    updateMany: (...args: unknown[]) => mocks.shareUpdateMany(...args),
    deleteMany: (...args: unknown[]) => mocks.shareDeleteMany(...args),
  },
  HireExternalVerdict: {
    updateMany: (...args: unknown[]) => mocks.verdictUpdateMany(...args),
    deleteMany: (...args: unknown[]) => mocks.verdictDeleteMany(...args),
  },
  HireAssessmentExport: {
    deleteMany: (...args: unknown[]) => mocks.assessmentDeleteMany(...args),
  },
  HireReportExport: {
    deleteMany: (...args: unknown[]) => mocks.reportDeleteMany(...args),
  },
  HireAiInviteDelivery: { deleteMany: (...args: unknown[]) => mocks.deliveryDeleteMany(...args) },
  HireApplication: {
    exists: (...args: unknown[]) => mocks.applicationExists(...args),
    deleteMany: (...args: unknown[]) => mocks.applicationDeleteMany(...args),
  },
  HireCandidate: { deleteMany: (...args: unknown[]) => mocks.candidateDeleteMany(...args) },
  HireConsentReceipt: { deleteMany: (...args: unknown[]) => mocks.consentDeleteMany(...args) },
  HireEmailOutbox: { deleteMany: (...args: unknown[]) => mocks.emailOutboxDeleteMany(...args) },
  HireEngineHandoff: {
    updateMany: (...args: unknown[]) => mocks.handoffUpdateMany(...args),
    deleteMany: (...args: unknown[]) => mocks.handoffDeleteMany(...args),
  },
  HireEngineIngestionEvent: {
    deleteMany: (...args: unknown[]) => mocks.ingestionDeleteMany(...args),
  },
  HireGuestSession: {
    updateMany: (...args: unknown[]) => mocks.guestUpdateMany(...args),
    deleteMany: (...args: unknown[]) => mocks.guestDeleteMany(...args),
  },
  HireHumanKitDelivery: {
    deleteMany: (...args: unknown[]) => mocks.humanKitDeliveryDeleteMany(...args),
  },
  HireHumanRound: { deleteMany: (...args: unknown[]) => mocks.humanRoundDeleteMany(...args) },
  HireHumanScorecard: {
    deleteMany: (...args: unknown[]) => mocks.humanScorecardDeleteMany(...args),
  },
  HireInterviewAttempt: {
    updateMany: (...args: unknown[]) => mocks.attemptUpdateMany(...args),
    deleteMany: (...args: unknown[]) => mocks.attemptDeleteMany(...args),
  },
  HireInterviewKit: { deleteMany: (...args: unknown[]) => mocks.interviewKitDeleteMany(...args) },
  HireInterviewResult: { deleteMany: (...args: unknown[]) => mocks.resultDeleteMany(...args) },
  HireIntakeTask: { exists: (...args: unknown[]) => mocks.intakeTaskExists(...args) },
  HireInvitationBatch: {
    deleteMany: (...args: unknown[]) => mocks.invitationBatchDeleteMany(...args),
  },
  HireInvitationBatchItem: {
    deleteMany: (...args: unknown[]) => mocks.invitationBatchItemDeleteMany(...args),
  },
  HireJob: { deleteMany: (...args: unknown[]) => mocks.jobDeleteMany(...args) },
  HireJobRequirementVersion: {
    deleteMany: (...args: unknown[]) => mocks.requirementDeleteMany(...args),
  },
  HireMediaAsset: {
    find: (...args: unknown[]) => mocks.mediaFind(...args),
    updateOne: (...args: unknown[]) => mocks.mediaUpdateOne(...args),
    exists: (...args: unknown[]) => mocks.mediaExists(...args),
    deleteMany: (...args: unknown[]) => mocks.mediaDeleteMany(...args),
  },
  HirePrivacyRequest: {
    deleteMany: (...args: unknown[]) => mocks.privacyRequestDeleteMany(...args),
  },
  HireRound: {
    find: (...args: unknown[]) => mocks.roundFind(...args),
    updateMany: (...args: unknown[]) => mocks.roundUpdateMany(...args),
    exists: (...args: unknown[]) => mocks.roundExists(...args),
    deleteMany: (...args: unknown[]) => mocks.roundDeleteMany(...args),
  },
  HireScreeningGate: {
    deleteMany: (...args: unknown[]) => mocks.screeningGateDeleteMany(...args),
  },
  hireMediaStorage: { delete: vi.fn() },
}))

vi.mock('../models', () => ({
  HireOnboardingTestDrive: {
    find: (...args: unknown[]) => mocks.testDriveFind(...args),
    findOne: (...args: unknown[]) => mocks.testDriveFindOne(...args),
    findOneAndUpdate: (...args: unknown[]) => mocks.testDriveFindOneAndUpdate(...args),
    updateOne: (...args: unknown[]) => mocks.testDriveUpdateOne(...args),
    updateMany: (...args: unknown[]) => mocks.testDriveUpdateMany(...args),
    deleteOne: (...args: unknown[]) => mocks.testDriveDeleteOne(...args),
  },
}))

import {
  cancelHireOnboardingTestDrivesForMember,
  deliverHireOnboardingTestDriveRuntimeRevocations,
  kickHireOnboardingTestDriveCleanup,
  purgeHireOnboardingTestDrive,
} from '../services/testDriveLifecycleService'

function sessionQuery<T>(value: T) {
  const resolved = Promise.resolve(value)
  return {
    session: vi.fn().mockResolvedValue(value),
    then: resolved.then.bind(resolved),
    catch: resolved.catch.bind(resolved),
  }
}

function mediaQuery(value: unknown[]) {
  return {
    sort: vi.fn().mockReturnValue({
      limit: vi.fn().mockResolvedValue(value),
    }),
  }
}

function testDrive(overrides: Record<string, unknown> = {}) {
  return {
    _id: IDS.testDrive,
    workspaceId: IDS.workspace,
    issuedByMemberId: IDS.member,
    issuedByName: 'Hiring manager',
    operationId: '123e4567-e89b-42d3-a456-426614174000',
    label: 'Interview yourself' as const,
    state: 'ready' as const,
    active: true,
    excludeFromAggregates: true as const,
    jobId: IDS.job,
    candidateId: IDS.candidate,
    applicationId: IDS.application,
    roundId: IDS.round,
    cleanupAfter: NOW,
    createdAt: NOW,
    ...overrides,
  }
}

const transactionSession = {
  withTransaction: vi.fn(async (work: () => Promise<unknown>) => work()),
  endSession: vi.fn(),
}

beforeEach(() => {
  vi.clearAllMocks()
  vi.spyOn(mongoose, 'startSession').mockResolvedValue(transactionSession as never)
  transactionSession.withTransaction.mockImplementation(async (work: () => Promise<unknown>) => work())
  transactionSession.endSession.mockResolvedValue(undefined)
  mocks.connect.mockResolvedValue(undefined)
  mocks.inngestSend.mockResolvedValue(undefined)
  mocks.deliverRuntimeRevocation.mockResolvedValue(true)
  mocks.workspaceExists.mockReturnValue(sessionQuery({ _id: IDS.workspace }))
  mocks.statusRevoke.mockResolvedValue(undefined)
  mocks.statusDeleteMany.mockResolvedValue({ deletedCount: 1 })
  mocks.shareUpdateMany.mockResolvedValue({ modifiedCount: 1 })
  mocks.shareDeleteMany.mockResolvedValue({ deletedCount: 1 })
  mocks.verdictUpdateMany.mockResolvedValue({ modifiedCount: 1 })
  mocks.verdictDeleteMany.mockResolvedValue({ deletedCount: 1 })
  mocks.assessmentCancel.mockResolvedValue([])
  mocks.assessmentDeleteObjects.mockResolvedValue(undefined)
  mocks.assessmentDeleteMany.mockResolvedValue({ deletedCount: 1 })
  mocks.reportCancel.mockResolvedValue(0)
  mocks.reportDeleteMany.mockResolvedValue({ deletedCount: 1 })
  mocks.testDriveFind.mockReturnValue(sessionQuery([]))
  mocks.testDriveFindOne.mockReturnValue(sessionQuery(testDrive()))
  mocks.testDriveFindOneAndUpdate.mockResolvedValue(testDrive())
  mocks.testDriveUpdateOne.mockResolvedValue({ matchedCount: 1 })
  mocks.testDriveUpdateMany.mockResolvedValue({ modifiedCount: 1 })
  mocks.testDriveDeleteOne.mockResolvedValue({ deletedCount: 1 })
  mocks.roundFind.mockReturnValue(sessionQuery([{ _id: IDS.round }]))
  mocks.roundUpdateMany.mockResolvedValue({ modifiedCount: 1 })
  mocks.roundExists.mockReturnValue(sessionQuery(null))
  mocks.roundDeleteMany.mockResolvedValue({ deletedCount: 1 })
  mocks.guestUpdateMany.mockResolvedValue({ modifiedCount: 1 })
  mocks.guestDeleteMany.mockResolvedValue({ deletedCount: 1 })
  mocks.handoffUpdateMany.mockResolvedValue({ modifiedCount: 1 })
  mocks.handoffDeleteMany.mockResolvedValue({ deletedCount: 1 })
  mocks.ingestionDeleteMany.mockResolvedValue({ deletedCount: 1 })
  mocks.attemptUpdateMany.mockResolvedValue({ modifiedCount: 1 })
  mocks.attemptDeleteMany.mockResolvedValue({ deletedCount: 1 })
  mocks.consentDeleteMany.mockResolvedValue({ deletedCount: 1 })
  mocks.emailOutboxDeleteMany.mockResolvedValue({ deletedCount: 1 })
  mocks.intakeTaskExists.mockReturnValue(sessionQuery(null))
  mocks.humanKitDeliveryDeleteMany.mockResolvedValue({ deletedCount: 1 })
  mocks.interviewKitDeleteMany.mockResolvedValue({ deletedCount: 1 })
  mocks.humanScorecardDeleteMany.mockResolvedValue({ deletedCount: 1 })
  mocks.humanRoundDeleteMany.mockResolvedValue({ deletedCount: 1 })
  mocks.invitationBatchDeleteMany.mockResolvedValue({ deletedCount: 1 })
  mocks.invitationBatchItemDeleteMany.mockResolvedValue({ deletedCount: 1 })
  mocks.screeningGateDeleteMany.mockResolvedValue({ deletedCount: 1 })
  mocks.privacyRequestDeleteMany.mockResolvedValue({ deletedCount: 1 })
  mocks.resultDeleteMany.mockResolvedValue({ deletedCount: 1 })
  mocks.deliveryDeleteMany.mockResolvedValue({ deletedCount: 1 })
  mocks.mediaFind.mockReturnValue(mediaQuery([]))
  mocks.mediaUpdateOne.mockResolvedValue({ matchedCount: 1 })
  mocks.mediaExists.mockReturnValue(sessionQuery(null))
  mocks.mediaDeleteMany.mockResolvedValue({ deletedCount: 1 })
  mocks.applicationExists.mockReturnValue(sessionQuery(null))
  mocks.applicationDeleteMany.mockResolvedValue({ deletedCount: 1 })
  mocks.candidateDeleteMany.mockResolvedValue({ deletedCount: 1 })
  mocks.requirementDeleteMany.mockResolvedValue({ deletedCount: 1 })
  mocks.jobDeleteMany.mockResolvedValue({ deletedCount: 1 })
})

describe('Hire onboarding test-drive lifecycle', () => {
  it('dispatches an opaque cleanup wakeup and leaves durable recovery as the failure backstop', async () => {
    await expect(kickHireOnboardingTestDriveCleanup({
      workspaceId: IDS.workspace.toString(),
      testDriveId: IDS.testDrive.toString(),
    })).resolves.toBe(true)

    expect(mocks.inngestSend).toHaveBeenCalledWith({
      name: 'hire/onboarding-test-drive.cleanup-requested',
      data: {
        workspaceId: IDS.workspace.toString(),
        testDriveId: IDS.testDrive.toString(),
      },
    })

    mocks.inngestSend.mockRejectedValueOnce(new Error('event transport unavailable'))
    await expect(kickHireOnboardingTestDriveCleanup({
      workspaceId: IDS.workspace.toString(),
      testDriveId: IDS.testDrive.toString(),
    })).resolves.toBe(false)
    expect(mocks.loggerWarn).toHaveBeenCalledWith(
      expect.objectContaining({
        workspaceId: IDS.workspace.toString(),
        testDriveId: IDS.testDrive.toString(),
      }),
      expect.stringContaining('durable recovery'),
    )
  })

  it('marks only the removed member marker, cancels its live practice round, and defers runtime delivery', async () => {
    mocks.testDriveFind.mockReturnValue(sessionQuery([testDrive()]))
    mocks.roundFind.mockReturnValue(sessionQuery([{ _id: IDS.round }]))

    const result = await cancelHireOnboardingTestDrivesForMember({
      workspaceId: IDS.workspace,
      memberId: IDS.member,
      at: NOW,
      cleanupAfter: NOW,
      reason: 'Workspace member removed',
      actor: { memberId: IDS.member, name: 'Hiring manager' },
      session: transactionSession as never,
    })

    expect(result).toEqual({ marked: 1, runtimeRoundIds: [IDS.round.toString()] })
    expect(mocks.testDriveFind).toHaveBeenCalledWith({
      workspaceId: IDS.workspace,
      active: true,
      issuedByMemberId: IDS.member,
    })
    expect(mocks.testDriveUpdateMany).toHaveBeenCalledWith(
      expect.objectContaining({ workspaceId: IDS.workspace, active: true }),
      expect.objectContaining({
        $set: expect.objectContaining({
          state: 'removed',
          active: false,
          cleanupAfter: NOW,
          removedByMemberId: IDS.member,
        }),
      }),
      { session: transactionSession },
    )
    expect(mocks.roundUpdateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        workspaceId: IDS.workspace,
        applicationId: { $in: [IDS.application] },
        revokedAt: { $exists: false },
      }),
      expect.objectContaining({
        $set: expect.objectContaining({
          status: 'revoked',
          revocationState: 'pending',
          revokedByMemberId: IDS.member,
        }),
      }),
      { session: transactionSession },
    )
    expect(mocks.deliverRuntimeRevocation).not.toHaveBeenCalled()

    await deliverHireOnboardingTestDriveRuntimeRevocations({
      workspaceId: IDS.workspace.toString(),
      roundIds: result.runtimeRoundIds,
    })
    expect(mocks.deliverRuntimeRevocation).toHaveBeenCalledWith(
      IDS.workspace.toString(),
      IDS.round.toString(),
    )
  })

  it('keeps the marker through acknowledged runtime/media cleanup, then deletes the synthetic graph in strict parent order', async () => {
    const result = await purgeHireOnboardingTestDrive({
      workspaceId: IDS.workspace.toString(),
      testDriveId: IDS.testDrive.toString(),
      now: NOW,
      clock: () => NOW,
    })

    expect(result).toEqual({
      claimed: true,
      purged: true,
      failed: false,
      skipped: false,
      mediaObjectsDeleted: 0,
    })
    expect(mocks.deliverRuntimeRevocation).toHaveBeenCalledWith(
      IDS.workspace.toString(),
      IDS.round.toString(),
    )
    const scope = {
      workspaceId: IDS.workspace,
      applicationId: IDS.application,
      jobId: IDS.job,
      candidateId: IDS.candidate,
    }
    expect(mocks.statusRevoke).toHaveBeenCalledWith({
      workspaceId: IDS.workspace,
      applicationId: IDS.application,
      candidateId: IDS.candidate,
      reason: 'Practice test-drive retention elapsed',
      at: NOW,
      session: transactionSession,
    })
    expect(mocks.shareUpdateMany).toHaveBeenNthCalledWith(
      1,
      {
        ...scope,
        active: true,
        status: 'active',
        revokedAt: { $exists: false },
      },
      expect.objectContaining({
        $set: expect.objectContaining({
          active: false,
          status: 'revoked',
          revocationReason: 'Practice test-drive retention elapsed',
        }),
      }),
      { session: transactionSession },
    )
    expect(mocks.shareUpdateMany).toHaveBeenNthCalledWith(
      2,
      { ...scope, privacyRedactedAt: { $exists: false } },
      {
        $set: { privacyRedactedAt: NOW },
        $unset: { secretHash: 1, snapshot: 1 },
      },
      { session: transactionSession, overwriteImmutable: true },
    )
    expect(mocks.verdictUpdateMany).toHaveBeenCalledWith(
      { ...scope, privacyRedactedAt: { $exists: false } },
      {
        $set: { privacyRedactedAt: NOW },
        $unset: { comment: 1 },
      },
      { session: transactionSession, overwriteImmutable: true },
    )
    expect(mocks.assessmentCancel).toHaveBeenCalledWith({
      scope,
      cancelledAt: NOW,
      privacyRedactedAt: NOW,
      session: transactionSession,
    })
    expect(mocks.assessmentDeleteObjects).toHaveBeenCalledWith([])
    expect(mocks.reportCancel).toHaveBeenNthCalledWith(1, {
      scope: { workspaceId: IDS.workspace, candidateId: IDS.candidate },
      cancelledAt: NOW,
      session: transactionSession,
    })
    expect(mocks.reportCancel).toHaveBeenNthCalledWith(2, {
      scope: { workspaceId: IDS.workspace, jobId: IDS.job },
      cancelledAt: NOW,
      session: transactionSession,
    })
    const deletionOrder = [
      mocks.ingestionDeleteMany,
      mocks.statusDeleteMany,
      mocks.verdictDeleteMany,
      mocks.shareDeleteMany,
      mocks.assessmentDeleteMany,
      mocks.reportDeleteMany,
      mocks.roundDeleteMany,
      mocks.applicationDeleteMany,
      mocks.candidateDeleteMany,
      mocks.requirementDeleteMany,
      mocks.jobDeleteMany,
      mocks.testDriveDeleteOne,
    ].map((fn) => fn.mock.invocationCallOrder[0])
    expect(deletionOrder).toEqual([...deletionOrder].sort((left, right) => left - right))
    expect(mocks.testDriveDeleteOne).toHaveBeenCalledWith(
      expect.objectContaining({
        _id: IDS.testDrive,
        workspaceId: IDS.workspace,
        cleanupClaimToken: expect.any(String),
      }),
      { session: transactionSession },
    )
    expect(mocks.statusDeleteMany).toHaveBeenCalledWith(scope, { session: transactionSession })
    expect(mocks.reportDeleteMany).toHaveBeenCalledWith(
      { workspaceId: IDS.workspace, jobId: IDS.job },
      { session: transactionSession },
    )
    expect(mocks.emailOutboxDeleteMany).toHaveBeenCalledWith(scope, { session: transactionSession })
    expect(mocks.humanKitDeliveryDeleteMany).toHaveBeenCalledWith(scope, {
      session: transactionSession,
    })
    expect(mocks.invitationBatchItemDeleteMany).toHaveBeenCalledWith(scope, {
      session: transactionSession,
    })
    expect(mocks.invitationBatchDeleteMany).toHaveBeenCalledWith(
      { workspaceId: IDS.workspace, jobId: IDS.job },
      { session: transactionSession },
    )
    expect(mocks.privacyRequestDeleteMany).toHaveBeenCalledWith(
      { workspaceId: IDS.workspace, candidateId: IDS.candidate },
      { session: transactionSession },
    )
  })

  it('redacts practice artifacts even when the synthetic graph has no AI round', async () => {
    mocks.roundFind.mockReturnValue(sessionQuery([]))

    await expect(
      purgeHireOnboardingTestDrive({
        workspaceId: IDS.workspace.toString(),
        testDriveId: IDS.testDrive.toString(),
        now: NOW,
      }),
    ).resolves.toMatchObject({ purged: true })

    expect(mocks.statusRevoke).toHaveBeenCalledOnce()
    expect(mocks.shareUpdateMany).toHaveBeenCalledTimes(2)
    expect(mocks.verdictUpdateMany).toHaveBeenCalledOnce()
    expect(mocks.assessmentCancel).toHaveBeenCalledOnce()
    expect(mocks.reportCancel).toHaveBeenCalledTimes(2)
    expect(mocks.deliverRuntimeRevocation).not.toHaveBeenCalled()
  })

  it('runs practice artifact revocation and redaction serially on the cleanup transaction session', async () => {
    let resolveStatusRevocation: (() => void) | undefined
    mocks.statusRevoke.mockImplementationOnce(
      () => new Promise<void>((resolve) => { resolveStatusRevocation = resolve }),
    )

    const pending = purgeHireOnboardingTestDrive({
      workspaceId: IDS.workspace.toString(),
      testDriveId: IDS.testDrive.toString(),
      now: NOW,
    })
    await vi.waitFor(() => expect(mocks.statusRevoke).toHaveBeenCalledOnce())
    expect(mocks.shareUpdateMany).not.toHaveBeenCalled()
    resolveStatusRevocation?.()

    await expect(pending).resolves.toMatchObject({ purged: true })
    expect(mocks.shareUpdateMany).toHaveBeenCalled()
  })

  it('runs the two graph-isolation checks sequentially on the cleanup transaction session', async () => {
    let resolveCandidateCheck: ((value: null) => void) | undefined
    const candidateSession = vi.fn(
      () => new Promise<null>((resolve) => { resolveCandidateCheck = resolve }),
    )
    const jobSession = vi.fn().mockResolvedValue(null)
    mocks.applicationExists
      .mockReturnValueOnce({ session: candidateSession })
      .mockReturnValueOnce({ session: jobSession })

    const pending = purgeHireOnboardingTestDrive({
      workspaceId: IDS.workspace.toString(),
      testDriveId: IDS.testDrive.toString(),
      now: NOW,
    })
    await vi.waitFor(() => expect(candidateSession).toHaveBeenCalledOnce())
    expect(jobSession).not.toHaveBeenCalled()
    resolveCandidateCheck?.(null)

    await expect(pending).resolves.toMatchObject({ purged: true })
    expect(jobSession).toHaveBeenCalledOnce()
  })

  it('fails closed on an unexpected legacy intake task and retains the marker plus synthetic graph', async () => {
    mocks.intakeTaskExists.mockReturnValue(sessionQuery({ _id: new mongoose.Types.ObjectId() }))

    const result = await purgeHireOnboardingTestDrive({
      workspaceId: IDS.workspace.toString(),
      testDriveId: IDS.testDrive.toString(),
      now: NOW,
    })

    expect(result).toMatchObject({ claimed: true, purged: false, failed: true })
    expect(mocks.intakeTaskExists).toHaveBeenCalledWith({
      workspaceId: IDS.workspace,
      jobId: IDS.job,
    })
    expect(mocks.emailOutboxDeleteMany).not.toHaveBeenCalled()
    expect(mocks.applicationDeleteMany).not.toHaveBeenCalled()
    expect(mocks.candidateDeleteMany).not.toHaveBeenCalled()
    expect(mocks.jobDeleteMany).not.toHaveBeenCalled()
    expect(mocks.testDriveDeleteOne).not.toHaveBeenCalled()
    expect(mocks.testDriveUpdateOne).toHaveBeenLastCalledWith(
      expect.objectContaining({ _id: IDS.testDrive, workspaceId: IDS.workspace }),
      expect.objectContaining({
        $set: expect.objectContaining({ cleanupLastError: 'Error' }),
        $unset: expect.objectContaining({ cleanupClaimToken: 1 }),
      }),
    )
  })

  it('retains the durable marker and graph when runtime personal-data deletion is not acknowledged', async () => {
    mocks.deliverRuntimeRevocation.mockResolvedValue(false)

    const result = await purgeHireOnboardingTestDrive({
      workspaceId: IDS.workspace.toString(),
      testDriveId: IDS.testDrive.toString(),
      now: NOW,
    })

    expect(result).toMatchObject({ claimed: true, purged: false, failed: true })
    expect(mocks.roundDeleteMany).not.toHaveBeenCalled()
    expect(mocks.testDriveDeleteOne).not.toHaveBeenCalled()
    expect(mocks.testDriveUpdateOne).toHaveBeenLastCalledWith(
      expect.objectContaining({ _id: IDS.testDrive, workspaceId: IDS.workspace }),
      expect.objectContaining({
        $set: expect.objectContaining({ cleanupLastError: 'Error' }),
        $unset: expect.objectContaining({ cleanupClaimToken: 1 }),
      }),
    )
  })

  it('uses only the narrow lifecycle facade, never the Hire root, B2C, or an engine/runtime implementation', () => {
    const source = readFileSync(
      resolve(process.cwd(), 'modules/hire-onboarding/services/testDriveLifecycleService.ts'),
      'utf8',
    )
    expect(source).toContain("from '../../hire/onboardingLifecycleBoundary'")
    expect(source).not.toMatch(/from ['"]@hire['"]/)
    expect(source).not.toMatch(/from ['"][^'"]*(?:b2c|engine|runtime)[^'"]*['"]/i)
  })
})
