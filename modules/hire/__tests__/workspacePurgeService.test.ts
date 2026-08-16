import mongoose from 'mongoose'
import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('../services/hireControlBoundary', () => ({
  connectHireControlDB: vi.fn().mockResolvedValue(undefined),
}))

const {
  models,
  decisionModels,
  digestModels,
  statusModels,
  onboardingModels,
  departmentModels,
  reportModels,
  session,
  mockDeliverRuntimeRevocation,
  mockCancelAssessmentExports,
  mockDeleteAssessmentExports,
  mockCancelReportExports,
} = vi.hoisted(() => {
  const child = () => ({ deleteMany: vi.fn().mockResolvedValue({ deletedCount: 1 }) })
  const modelMap = {
    HireApplication: child(),
    HireAiInviteDelivery: child(),
    HireCandidate: child(),
    HireConsentReceipt: child(),
    HireEmailOutbox: child(),
    HireEngineHandoff: child(),
    HireEngineIngestionEvent: child(),
    HireGuestSession: child(),
    HireInterviewAttempt: child(),
    HireInterviewResult: child(),
    HireHumanKitDelivery: child(),
    HireHumanRound: child(),
    HireHumanScorecard: child(),
    HireInterviewKit: child(),
    HireIntakeTask: child(),
    HireInvitationBatch: child(),
    HireInvitationBatchItem: child(),
    HireJob: child(),
    HireJobRequirementVersion: child(),
    HireMemberSession: child(),
    HireMemberSetup: child(),
    HirePrivacyRequest: child(),
    HireRound: {
      ...child(),
      find: vi.fn(),
      updateMany: vi.fn(),
      exists: vi.fn(),
    },
    HireScreeningGate: child(),
    HireWorkspaceMember: child(),
    HireMediaAsset: {
      ...child(),
      find: vi.fn(),
      updateOne: vi.fn(),
      exists: vi.fn(),
    },
    HireWorkspace: {
      find: vi.fn(),
      findOneAndUpdate: vi.fn(),
      updateOne: vi.fn(),
      exists: vi.fn(),
      deleteOne: vi.fn(),
    },
  }
  return {
    models: modelMap,
    decisionModels: {
      HireAssessmentExport: child(),
      HireExternalVerdict: child(),
      HireSharePacket: child(),
    },
    digestModels: {
      HireDigestOutbox: child(),
      HireDigestPreference: child(),
    },
    statusModels: {
      HireCandidateStatusLink: child(),
    },
    onboardingModels: {
      HireOnboardingTestDrive: child(),
    },
    departmentModels: {
      HireDepartment: child(),
    },
    reportModels: {
      HireReportExport: child(),
    },
    session: {
      withTransaction: vi.fn(async (work: () => Promise<void>) => work()),
      endSession: vi.fn().mockResolvedValue(undefined),
    },
    mockDeliverRuntimeRevocation: vi.fn(),
    mockCancelAssessmentExports: vi.fn(),
    mockDeleteAssessmentExports: vi.fn(),
    mockCancelReportExports: vi.fn(),
  }
})

vi.mock('../models', () => models)
vi.mock('@hire-decisions/models', () => decisionModels)
vi.mock('../../hire-digest/models', () => digestModels)
vi.mock('../../hire-status/models', () => statusModels)
vi.mock('../../hire-onboarding/models', () => onboardingModels)
vi.mock('@hire-departments/models', () => departmentModels)
vi.mock('../services/engineRevocationService', () => ({
  deliverRuntimeRevocation: (...args: unknown[]) => mockDeliverRuntimeRevocation(...args),
}))
vi.mock('../services/assessmentExportLifecycleService', () => ({
  cancelHireAssessmentExports: (...args: unknown[]) => mockCancelAssessmentExports(...args),
  deleteHireAssessmentExportObjects: (...args: unknown[]) => mockDeleteAssessmentExports(...args),
}))
vi.mock('../../hire-reports/models/HireReportExport', () => reportModels)
vi.mock('../../hire-reports/services/hireReportLifecycleService', () => ({
  cancelHireReportExportsForLifecycle: (...args: unknown[]) => mockCancelReportExports(...args),
}))

import {
  HIRE_WORKSPACE_PURGE_COLLECTIONS,
  purgeDueHireWorkspaces,
} from '../services/workspacePurgeService'

const WORKSPACE_ID = new mongoose.Types.ObjectId('111111111111111111111111')
const ASSET_ID = new mongoose.Types.ObjectId('222222222222222222222222')
const NOW = new Date('2026-08-10T12:00:00.000Z')

function queryResult<T>(value: T) {
  return {
    sort: vi.fn().mockReturnValue({
      limit: vi.fn().mockReturnValue({
        select: vi.fn().mockResolvedValue(value),
      }),
    }),
  }
}

function mediaQuery(value: unknown[]) {
  return {
    sort: vi.fn().mockReturnValue({
      limit: vi.fn().mockResolvedValue(value),
    }),
  }
}

function runtimeRoundQuery(value: unknown[]) {
  return {
    sort: vi.fn().mockReturnValue({
      select: vi.fn().mockReturnValue({
        lean: vi.fn().mockResolvedValue(value),
      }),
    }),
  }
}

function sessionResult(value: unknown) {
  return { session: vi.fn().mockResolvedValue(value) }
}

beforeEach(() => {
  vi.clearAllMocks()
  vi.spyOn(mongoose, 'startSession').mockResolvedValue(
    session as unknown as mongoose.ClientSession,
  )
  session.withTransaction.mockImplementation(async (work: () => Promise<void>) => work())
  session.endSession.mockResolvedValue(undefined)
  models.HireWorkspace.find.mockReturnValue(queryResult([{ _id: WORKSPACE_ID }]))
  models.HireWorkspace.findOneAndUpdate.mockResolvedValue({ _id: WORKSPACE_ID })
  models.HireWorkspace.updateOne.mockResolvedValue({ matchedCount: 1 })
  models.HireWorkspace.exists.mockReturnValue(sessionResult({ _id: WORKSPACE_ID }))
  models.HireWorkspace.deleteOne.mockResolvedValue({ deletedCount: 1 })
  models.HireMediaAsset.find.mockReturnValue(mediaQuery([]))
  models.HireMediaAsset.updateOne.mockResolvedValue({ matchedCount: 1 })
  models.HireMediaAsset.exists.mockReturnValue(sessionResult(null))
  models.HireRound.find.mockReturnValue(runtimeRoundQuery([]))
  models.HireRound.updateMany.mockResolvedValue({ modifiedCount: 0 })
  models.HireRound.exists.mockReturnValue(sessionResult(null))
  mockDeliverRuntimeRevocation.mockResolvedValue(true)
  mockCancelAssessmentExports.mockResolvedValue([])
  mockDeleteAssessmentExports.mockResolvedValue(undefined)
  mockCancelReportExports.mockResolvedValue(0)
  reportModels.HireReportExport.deleteMany.mockResolvedValue({ deletedCount: 1 })
  statusModels.HireCandidateStatusLink.deleteMany.mockResolvedValue({ deletedCount: 1 })
  onboardingModels.HireOnboardingTestDrive.deleteMany.mockResolvedValue({ deletedCount: 1 })
  departmentModels.HireDepartment.deleteMany.mockResolvedValue({ deletedCount: 1 })
  for (const model of Object.values(models)) {
    if ('deleteMany' in model) {
      model.deleteMany.mockResolvedValue({ deletedCount: 1 })
    }
  }
})

describe('workspace hard purge', () => {
  it('inventories every Hire control collection and excludes isolated runtime models', () => {
    expect(HIRE_WORKSPACE_PURGE_COLLECTIONS).toEqual([
      'HireMemberSetup',
      'HireMemberSession',
      'HireGuestSession',
      'HireConsentReceipt',
      'HireEngineHandoff',
      'HireEngineIngestionEvent',
      'HireInterviewResult',
      'HireInterviewAttempt',
      'HireMediaAsset',
      'HirePrivacyRequest',
      'HireEmailOutbox',
      'HireDigestOutbox',
      'HireDigestPreference',
      'HireAiInviteDelivery',
      'HireHumanKitDelivery',
      'HireInterviewKit',
      'HireHumanScorecard',
      'HireHumanRound',
      'HireRound',
      'HireIntakeTask',
      'HireInvitationBatchItem',
      'HireInvitationBatch',
      'HireScreeningGate',
      'HireAssessmentExport',
      'HireReportExport',
      'HireExternalVerdict',
      'HireSharePacket',
      'HireCandidateStatusLink',
      'HireApplication',
      'HireCandidate',
      'HireJobRequirementVersion',
      'HireJob',
      'HireDepartment',
      'HireOnboardingTestDrive',
      'HireWorkspaceMember',
      'HireWorkspace',
    ])
    expect(HIRE_WORKSPACE_PURGE_COLLECTIONS.join(' ')).not.toMatch(/Runtime/)
    expect(HIRE_WORKSPACE_PURGE_COLLECTIONS).not.toContain('HireReportExportCleanup')
  })

  it('acknowledges private object deletion before removing the full graph', async () => {
    const asset = {
      _id: ASSET_ID,
      workspaceId: WORKSPACE_ID,
      applicationId: new mongoose.Types.ObjectId(),
      roundId: new mongoose.Types.ObjectId(),
      attemptId: new mongoose.Types.ObjectId(),
      objectKey: 'hire-media/ws/app/round/attempt/asset/photo.jpg',
    }
    models.HireMediaAsset.find
      .mockReturnValueOnce(mediaQuery([asset]))
      .mockReturnValueOnce(mediaQuery([]))
    const storage = { upload: vi.fn(), signRead: vi.fn(), delete: vi.fn().mockResolvedValue(undefined) }
    const assessmentExportTarget = {
      key: 'hire-assessment-exports/v1/ws/job/app/candidate/export.pdf',
      coordinate: {
        workspaceId: WORKSPACE_ID.toString(),
        jobId: '222222222222222222222222',
        applicationId: '333333333333333333333333',
        candidateId: '444444444444444444444444',
        exportId: '555555555555555555555555',
      },
    }
    mockCancelAssessmentExports.mockResolvedValueOnce([assessmentExportTarget])

    const report = await purgeDueHireWorkspaces({
      workspaceId: WORKSPACE_ID.toString(),
      now: NOW,
      storage,
      clock: () => NOW,
    })

    expect(report).toEqual({
      scanned: 1,
      claimed: 1,
      purged: 1,
      failed: 0,
      mediaObjectsDeleted: 1,
    })
    expect(models.HireWorkspace.find).toHaveBeenCalledWith(
      expect.objectContaining({ _id: WORKSPACE_ID }),
    )
    expect(storage.delete).toHaveBeenCalledOnce()
    expect(models.HireMediaAsset.updateOne).toHaveBeenCalledWith(
      expect.objectContaining({ _id: ASSET_ID, workspaceId: WORKSPACE_ID }),
      expect.objectContaining({ $set: { state: 'purged', purgedAt: NOW } }),
    )
    for (const [name, model] of Object.entries(models)) {
      if (name === 'HireWorkspace' || !('deleteMany' in model)) continue
      expect(model.deleteMany, name).toHaveBeenCalledWith(
        { workspaceId: WORKSPACE_ID },
        { session },
      )
    }
    for (const [name, model] of Object.entries(decisionModels)) {
      expect(model.deleteMany, name).toHaveBeenCalledWith(
        { workspaceId: WORKSPACE_ID },
        { session },
      )
    }
    expect(reportModels.HireReportExport.deleteMany).toHaveBeenCalledWith(
      { workspaceId: WORKSPACE_ID },
      { session },
    )
    for (const [name, model] of Object.entries(digestModels)) {
      expect(model.deleteMany, name).toHaveBeenCalledWith(
        { workspaceId: WORKSPACE_ID },
        { session },
      )
    }
    expect(statusModels.HireCandidateStatusLink.deleteMany).toHaveBeenCalledWith(
      { workspaceId: WORKSPACE_ID },
      { session },
    )
    expect(onboardingModels.HireOnboardingTestDrive.deleteMany).toHaveBeenCalledWith(
      { workspaceId: WORKSPACE_ID },
      { session },
    )
    expect(departmentModels.HireDepartment.deleteMany).toHaveBeenCalledWith(
      { workspaceId: WORKSPACE_ID },
      { session },
    )
    expect(mockCancelAssessmentExports).toHaveBeenCalledWith({
      scope: { workspaceId: WORKSPACE_ID },
      cancelledAt: NOW,
      session,
    })
    expect(mockCancelReportExports).toHaveBeenCalledWith({
      scope: { workspaceId: WORKSPACE_ID },
      cancelledAt: NOW,
      session,
    })
    expect(mockDeleteAssessmentExports).toHaveBeenCalledWith([assessmentExportTarget])
    expect(mockCancelAssessmentExports.mock.invocationCallOrder[0]).toBeLessThan(
      decisionModels.HireAssessmentExport.deleteMany.mock.invocationCallOrder[0],
    )
    expect(mockCancelReportExports.mock.invocationCallOrder[0]).toBeLessThan(
      reportModels.HireReportExport.deleteMany.mock.invocationCallOrder[0],
    )
    expect(decisionModels.HireAssessmentExport.deleteMany.mock.invocationCallOrder[0]).toBeLessThan(
      mockDeleteAssessmentExports.mock.invocationCallOrder[0],
    )
    expect(
      decisionModels.HireExternalVerdict.deleteMany.mock.invocationCallOrder[0],
    ).toBeLessThan(decisionModels.HireSharePacket.deleteMany.mock.invocationCallOrder[0])
    expect(
      decisionModels.HireSharePacket.deleteMany.mock.invocationCallOrder[0],
    ).toBeLessThan(statusModels.HireCandidateStatusLink.deleteMany.mock.invocationCallOrder[0])
    expect(
      statusModels.HireCandidateStatusLink.deleteMany.mock.invocationCallOrder[0],
    ).toBeLessThan(models.HireApplication.deleteMany.mock.invocationCallOrder[0])
    expect(models.HireRound.deleteMany.mock.invocationCallOrder[0]).toBeLessThan(
      models.HireApplication.deleteMany.mock.invocationCallOrder[0],
    )
    expect(models.HireApplication.deleteMany.mock.invocationCallOrder[0]).toBeLessThan(
      models.HireCandidate.deleteMany.mock.invocationCallOrder[0],
    )
    expect(models.HireCandidate.deleteMany.mock.invocationCallOrder[0]).toBeLessThan(
      models.HireJobRequirementVersion.deleteMany.mock.invocationCallOrder[0],
    )
    expect(models.HireJobRequirementVersion.deleteMany.mock.invocationCallOrder[0]).toBeLessThan(
      models.HireJob.deleteMany.mock.invocationCallOrder[0],
    )
    expect(models.HireJob.deleteMany.mock.invocationCallOrder[0]).toBeLessThan(
      departmentModels.HireDepartment.deleteMany.mock.invocationCallOrder[0],
    )
    expect(departmentModels.HireDepartment.deleteMany.mock.invocationCallOrder[0]).toBeLessThan(
      onboardingModels.HireOnboardingTestDrive.deleteMany.mock.invocationCallOrder[0],
    )
    expect(onboardingModels.HireOnboardingTestDrive.deleteMany.mock.invocationCallOrder[0]).toBeLessThan(
      models.HireWorkspaceMember.deleteMany.mock.invocationCallOrder[0],
    )
    expect(models.HireWorkspace.deleteOne).toHaveBeenCalledWith(
      expect.objectContaining({
        _id: WORKSPACE_ID,
        purgeState: 'claimed',
        purgeAfter: { $lte: NOW },
      }),
      { session },
    )
  })

  it('retains the graph and releases a retryable failed claim when object deletion fails', async () => {
    models.HireMediaAsset.find.mockReturnValue(mediaQuery([
      {
        _id: ASSET_ID,
        workspaceId: WORKSPACE_ID,
        applicationId: new mongoose.Types.ObjectId(),
        roundId: new mongoose.Types.ObjectId(),
        attemptId: new mongoose.Types.ObjectId(),
        objectKey: 'hire-media/private.jpg',
      },
    ]))
    const storage = {
      upload: vi.fn(),
      signRead: vi.fn(),
      delete: vi.fn().mockRejectedValue(new Error('R2 unavailable')),
    }

    const report = await purgeDueHireWorkspaces({
      workspaceId: WORKSPACE_ID.toString(),
      now: NOW,
      storage,
      clock: () => NOW,
    })

    expect(report.failed).toBe(1)
    expect(report.purged).toBe(0)
    expect(session.withTransaction).not.toHaveBeenCalled()
    expect(models.HireWorkspace.updateOne).toHaveBeenLastCalledWith(
      expect.objectContaining({ _id: WORKSPACE_ID, purgeState: 'claimed' }),
      expect.objectContaining({
        $set: expect.objectContaining({ purgeState: 'failed' }),
        $unset: { purgeClaimToken: 1, purgeLeaseExpiresAt: 1 },
      }),
      { timestamps: false },
    )
  })

  it('durably requests and awaits personal-data purge for every control round before deletion', async () => {
    models.HireRound.find.mockReturnValue(runtimeRoundQuery([
      { _id: new mongoose.Types.ObjectId('333333333333333333333333') },
      { _id: new mongoose.Types.ObjectId('444444444444444444444444') },
    ]))

    const report = await purgeDueHireWorkspaces({
      workspaceId: WORKSPACE_ID.toString(),
      now: NOW,
      storage: { upload: vi.fn(), signRead: vi.fn(), delete: vi.fn() },
      clock: () => NOW,
    })

    expect(report).toMatchObject({ claimed: 1, purged: 1, failed: 0 })
    expect(models.HireRound.updateMany).toHaveBeenNthCalledWith(
      1,
      {
        workspaceId: WORKSPACE_ID,
        runtimePurgedAt: { $exists: false },
        revokedAt: { $exists: false },
      },
      expect.objectContaining({
        $set: expect.objectContaining({ revokedAt: NOW }),
      }),
    )
    expect(models.HireRound.updateMany).toHaveBeenNthCalledWith(
      2,
      { workspaceId: WORKSPACE_ID, runtimePurgedAt: { $exists: false } },
      expect.objectContaining({
        $set: {
          runtimePurgeRequested: true,
          revocationState: 'pending',
        },
      }),
    )
    expect(mockDeliverRuntimeRevocation.mock.calls).toEqual([
      [WORKSPACE_ID.toString(), '333333333333333333333333'],
      [WORKSPACE_ID.toString(), '444444444444444444444444'],
    ])
    expect(models.HireRound.exists).toHaveBeenCalledWith({
      workspaceId: WORKSPACE_ID,
      runtimePurgedAt: { $exists: false },
    })
    expect(models.HireWorkspace.deleteOne).toHaveBeenCalledOnce()
  })

  it('keeps the control graph and durable coordinates when a runtime purge is incomplete', async () => {
    const roundId = new mongoose.Types.ObjectId('333333333333333333333333')
    models.HireRound.find.mockReturnValue(runtimeRoundQuery([{ _id: roundId }]))
    mockDeliverRuntimeRevocation.mockResolvedValue(false)

    const report = await purgeDueHireWorkspaces({
      workspaceId: WORKSPACE_ID.toString(),
      now: NOW,
      storage: { upload: vi.fn(), signRead: vi.fn(), delete: vi.fn() },
      clock: () => NOW,
    })

    expect(report).toMatchObject({ claimed: 1, purged: 0, failed: 1 })
    expect(models.HireRound.updateMany).toHaveBeenCalledWith(
      { workspaceId: WORKSPACE_ID, runtimePurgedAt: { $exists: false } },
      expect.objectContaining({
        $set: expect.objectContaining({ runtimePurgeRequested: true }),
      }),
    )
    expect(session.withTransaction).not.toHaveBeenCalled()
    expect(models.HireRound.deleteMany).not.toHaveBeenCalled()
    expect(models.HireWorkspace.deleteOne).not.toHaveBeenCalled()
  })

  it('retries an incomplete runtime purge and deletes only after the later acknowledgement', async () => {
    const roundId = new mongoose.Types.ObjectId('333333333333333333333333')
    models.HireRound.find.mockReturnValue(runtimeRoundQuery([{ _id: roundId }]))
    mockDeliverRuntimeRevocation
      .mockResolvedValueOnce(false)
      .mockResolvedValueOnce(true)

    const first = await purgeDueHireWorkspaces({
      workspaceId: WORKSPACE_ID.toString(),
      now: NOW,
      storage: { upload: vi.fn(), signRead: vi.fn(), delete: vi.fn() },
      clock: () => NOW,
    })
    const second = await purgeDueHireWorkspaces({
      workspaceId: WORKSPACE_ID.toString(),
      now: NOW,
      storage: { upload: vi.fn(), signRead: vi.fn(), delete: vi.fn() },
      clock: () => NOW,
    })

    expect(first).toMatchObject({ purged: 0, failed: 1 })
    expect(second).toMatchObject({ purged: 1, failed: 0 })
    expect(mockDeliverRuntimeRevocation).toHaveBeenCalledTimes(2)
    expect(models.HireWorkspace.deleteOne).toHaveBeenCalledTimes(1)
  })

  it('does not erase durable runtime retry coordinates while revocation is pending', async () => {
    models.HireRound.exists.mockReturnValue(sessionResult({ _id: 'round' }))

    const report = await purgeDueHireWorkspaces({
      workspaceId: WORKSPACE_ID.toString(),
      now: NOW,
      storage: { upload: vi.fn(), signRead: vi.fn(), delete: vi.fn() },
    })

    expect(report).toMatchObject({ failed: 1, purged: 0 })
    expect(models.HireRound.deleteMany).not.toHaveBeenCalled()
    expect(models.HireWorkspace.deleteOne).not.toHaveBeenCalled()
  })

  it('reports an unexpired competing lease as retryable instead of false success', async () => {
    models.HireWorkspace.findOneAndUpdate.mockResolvedValue(null)

    const report = await purgeDueHireWorkspaces({
      workspaceId: WORKSPACE_ID.toString(),
      now: NOW,
      storage: { upload: vi.fn(), signRead: vi.fn(), delete: vi.fn() },
    })

    expect(report).toMatchObject({ scanned: 1, claimed: 0, failed: 1, purged: 0 })
    expect(models.HireMediaAsset.find).not.toHaveBeenCalled()
  })
})
