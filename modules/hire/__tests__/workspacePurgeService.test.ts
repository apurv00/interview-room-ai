import mongoose from 'mongoose'
import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('../services/hireControlBoundary', () => ({
  connectHireControlDB: vi.fn().mockResolvedValue(undefined),
}))

const {
  models,
  decisionModels,
  multimodalModels,
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
  mockBrandingDelete,
  mockDeleteCommercial,
  mockDeleteCandidateActions,
  mockDeleteCandidateSelections,
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
      findOneAndUpdate: vi.fn(),
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
    multimodalModels: {
      HireMultimodalAnalysis: child(),
      HireMultimodalAnalysisIngestionEvent: child(),
      HireMultimodalObservation: child(),
      HireMultimodalObservationIngestionEvent: child(),
      HireMultimodalObservationPurgeObligation: child(),
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
    mockBrandingDelete: vi.fn(),
    mockDeleteCommercial: vi.fn(),
    mockDeleteCandidateActions: vi.fn(),
    mockDeleteCandidateSelections: vi.fn(),
  }
})

vi.mock('../models', () => models)
vi.mock('@hire-decisions/models', () => decisionModels)
vi.mock('../../hire-multimodal/models', () => multimodalModels)
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
vi.mock('@hire-branding/services/workspaceBrandingStorage', () => ({
  hireWorkspaceBrandingStorage: {
    delete: (...args: unknown[]) => mockBrandingDelete(...args),
  },
  hireWorkspaceLogoKey: (workspaceId: string) => `hire-workspace-branding/${workspaceId}/logo`,
}))
vi.mock('@hire-commercial/purge-boundary', () => ({
  deleteHireCommercialWorkspaceData: (...args: unknown[]) =>
    mockDeleteCommercial(...args),
}))
vi.mock('../../hire-candidate-actions/purge-boundary', () => ({
  deleteHireCandidateActionWorkspaceData: (...args: unknown[]) =>
    mockDeleteCandidateActions(...args),
}))
vi.mock('@hire-operations/purge-boundary', () => ({
  deleteHireCandidateSelectionWorkspaceData: (...args: unknown[]) =>
    mockDeleteCandidateSelections(...args),
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
    select: vi.fn().mockReturnValue({
      sort: vi.fn().mockReturnValue({
        limit: vi.fn().mockResolvedValue(value),
      }),
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
  models.HireMediaAsset.findOneAndUpdate.mockResolvedValue(null)
  models.HireMediaAsset.updateOne.mockResolvedValue({ matchedCount: 1, modifiedCount: 1 })
  models.HireMediaAsset.exists.mockReturnValue(sessionResult(null))
  models.HireRound.find.mockReturnValue(runtimeRoundQuery([]))
  models.HireRound.updateMany.mockResolvedValue({ modifiedCount: 0 })
  models.HireRound.exists.mockReturnValue(sessionResult(null))
  mockDeliverRuntimeRevocation.mockResolvedValue(true)
  mockCancelAssessmentExports.mockResolvedValue([])
  mockDeleteAssessmentExports.mockResolvedValue(undefined)
  mockCancelReportExports.mockResolvedValue(0)
  mockBrandingDelete.mockResolvedValue(undefined)
  mockDeleteCommercial.mockResolvedValue(undefined)
  mockDeleteCandidateActions.mockResolvedValue(undefined)
  mockDeleteCandidateSelections.mockResolvedValue(undefined)
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
      'HireMultimodalObservationIngestionEvent',
      'HireMultimodalObservation',
      'HireMultimodalObservationPurgeObligation',
      'HireMultimodalAnalysisIngestionEvent',
      'HireMultimodalAnalysis',
      'HireCommercialAccount',
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
      'HireCandidateBulkOperationItem',
      'HireCandidateBulkOperation',
      'HireCandidateSelectionSnapshot',
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
      kind: 'identity_photo' as const,
      state: 'ready',
    }
    models.HireMediaAsset.find
      .mockReturnValueOnce(mediaQuery([asset]))
      .mockReturnValueOnce(mediaQuery([]))
    models.HireMediaAsset.findOneAndUpdate.mockResolvedValue(asset)
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
    expect(mockBrandingDelete).toHaveBeenCalledWith({
      key: `hire-workspace-branding/${WORKSPACE_ID.toString()}/logo`,
    })
    const purgeClaimId = models.HireMediaAsset.findOneAndUpdate.mock.calls[0][1].$set.purgeClaimId
    expect(models.HireMediaAsset.updateOne).toHaveBeenCalledWith(
      expect.objectContaining({
        _id: ASSET_ID,
        workspaceId: WORKSPACE_ID,
        state: 'purge_claimed',
        purgeClaimId,
      }),
      expect.objectContaining({ $set: { state: 'purged', purgedAt: NOW } }),
    )
    for (const [name, model] of Object.entries(models)) {
      if (name === 'HireWorkspace' || !('deleteMany' in model)) continue
      if (name === 'HireMediaAsset') {
        expect(model.deleteMany).toHaveBeenCalledWith(
          {
            workspaceId: WORKSPACE_ID,
            state: 'purged',
            purgedAt: { $exists: true },
            ingestionLeaseId: { $exists: false },
            ingestionLeaseExpiresAt: { $exists: false },
          },
          { session },
        )
        continue
      }
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
    for (const [name, model] of Object.entries(multimodalModels)) {
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
    expect(mockDeleteCommercial).toHaveBeenCalledWith({
      workspaceId: WORKSPACE_ID,
      session,
    })
    expect(mockDeleteCandidateActions).toHaveBeenCalledWith({
      workspaceId: WORKSPACE_ID,
      session,
    })
    expect(mockDeleteCandidateSelections).toHaveBeenCalledWith({
      workspaceId: WORKSPACE_ID,
      session,
    })
    expect(mockDeleteCandidateActions.mock.invocationCallOrder[0]).toBeLessThan(
      mockDeleteCandidateSelections.mock.invocationCallOrder[0],
    )
    expect(mockDeleteCandidateSelections.mock.invocationCallOrder[0]).toBeLessThan(
      models.HireApplication.deleteMany.mock.invocationCallOrder[0],
    )
    expect(mockDeleteCommercial.mock.invocationCallOrder[0]).toBeLessThan(
      models.HireWorkspace.deleteOne.mock.invocationCallOrder[0],
    )
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
    expect(mockBrandingDelete.mock.invocationCallOrder[0]).toBeLessThan(
      models.HireWorkspace.deleteOne.mock.invocationCallOrder[0],
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
        state: 'ready',
      },
    ]))
    models.HireMediaAsset.findOneAndUpdate.mockImplementation(async (_filter, update) => ({
      _id: ASSET_ID,
      workspaceId: WORKSPACE_ID,
      applicationId: new mongoose.Types.ObjectId(),
      roundId: new mongoose.Types.ObjectId(),
      attemptId: new mongoose.Types.ObjectId(),
      objectKey: 'hire-media/private.jpg',
      state: 'purge_claimed',
      purgeClaimId: update.$set.purgeClaimId,
    }))
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

    const purgeClaimId = models.HireMediaAsset.findOneAndUpdate.mock.calls[0][1].$set.purgeClaimId
    expect(report.failed).toBe(1)
    expect(report.purged).toBe(0)
    expect(session.withTransaction).not.toHaveBeenCalled()
    expect(models.HireMediaAsset.updateOne).toHaveBeenCalledWith(
      expect.objectContaining({
        _id: ASSET_ID,
        state: 'purge_claimed',
        purgeClaimId,
      }),
      expect.objectContaining({
        $set: expect.objectContaining({ state: 'purge_failed' }),
        $unset: expect.objectContaining({ purgeClaimId: 1, purgeClaimedAt: 1 }),
      }),
    )
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

  it('waits for an active staging writer lease without deleting its object or graph', async () => {
    models.HireMediaAsset.find.mockReturnValue(mediaQuery([{
      _id: ASSET_ID,
      workspaceId: WORKSPACE_ID,
      applicationId: new mongoose.Types.ObjectId(),
      roundId: new mongoose.Types.ObjectId(),
      attemptId: new mongoose.Types.ObjectId(),
      objectKey: 'hire-media/in-flight.webm',
      kind: 'camera_recording' as const,
      state: 'staging',
      ingestionLeaseId: 'writer-lease',
      ingestionLeaseExpiresAt: new Date(NOW.getTime() + 60_000),
      createdAt: NOW,
    }]))
    const storage = { upload: vi.fn(), signRead: vi.fn(), delete: vi.fn() }

    const report = await purgeDueHireWorkspaces({
      workspaceId: WORKSPACE_ID.toString(),
      now: NOW,
      storage,
      clock: () => NOW,
    })

    expect(report).toMatchObject({ claimed: 1, purged: 0, failed: 1, mediaObjectsDeleted: 0 })
    expect(models.HireMediaAsset.findOneAndUpdate).not.toHaveBeenCalled()
    expect(storage.delete).not.toHaveBeenCalled()
    expect(session.withTransaction).not.toHaveBeenCalled()
    expect(models.HireMediaAsset.deleteMany).not.toHaveBeenCalled()
  })

  it('reclaims an expired media purge claim with an exact old-token CAS', async () => {
    const oldClaimedAt = new Date(NOW.getTime() - 16 * 60 * 1000)
    const asset = {
      _id: ASSET_ID,
      workspaceId: WORKSPACE_ID,
      applicationId: new mongoose.Types.ObjectId(),
      roundId: new mongoose.Types.ObjectId(),
      attemptId: new mongoose.Types.ObjectId(),
      objectKey: 'hire-media/stale-claim.webm',
      kind: 'camera_recording' as const,
      state: 'purge_claimed',
      purgeClaimId: 'old-purge-claim',
      purgeClaimedAt: oldClaimedAt,
    }
    models.HireMediaAsset.find
      .mockReturnValueOnce(mediaQuery([asset]))
      .mockReturnValueOnce(mediaQuery([]))
    models.HireMediaAsset.findOneAndUpdate.mockImplementation(async (_filter, update) => ({
      ...asset,
      purgeClaimId: update.$set.purgeClaimId,
      purgeClaimedAt: update.$set.purgeClaimedAt,
    }))
    const storage = { upload: vi.fn(), signRead: vi.fn(), delete: vi.fn() }

    const report = await purgeDueHireWorkspaces({
      workspaceId: WORKSPACE_ID.toString(),
      now: NOW,
      storage,
      clock: () => NOW,
    })

    const claimFilter = models.HireMediaAsset.findOneAndUpdate.mock.calls[0][0]
    const newClaimId = models.HireMediaAsset.findOneAndUpdate.mock.calls[0][1].$set.purgeClaimId
    expect(claimFilter.$or).toEqual(expect.arrayContaining([{
      state: 'purge_claimed',
      purgeClaimId: 'old-purge-claim',
      purgeClaimedAt: oldClaimedAt,
    }]))
    expect(newClaimId).not.toBe('old-purge-claim')
    expect(models.HireMediaAsset.updateOne).toHaveBeenCalledWith(
      expect.objectContaining({ state: 'purge_claimed', purgeClaimId: newClaimId }),
      expect.objectContaining({ $set: { state: 'purged', purgedAt: NOW } }),
    )
    expect(storage.delete).toHaveBeenCalledOnce()
    expect(report).toMatchObject({ purged: 1, failed: 0, mediaObjectsDeleted: 1 })
  })

  it('does not steal a fresh media purge claim and retains the graph for retry', async () => {
    const asset = {
      _id: ASSET_ID,
      workspaceId: WORKSPACE_ID,
      applicationId: new mongoose.Types.ObjectId(),
      roundId: new mongoose.Types.ObjectId(),
      attemptId: new mongoose.Types.ObjectId(),
      objectKey: 'hire-media/fresh-claim.webm',
      kind: 'camera_recording' as const,
      state: 'purge_claimed',
      purgeClaimId: 'fresh-purge-claim',
      purgeClaimedAt: new Date(NOW.getTime() - 60 * 1000),
    }
    models.HireMediaAsset.find.mockReturnValue(mediaQuery([asset]))
    const storage = { upload: vi.fn(), signRead: vi.fn(), delete: vi.fn() }

    const report = await purgeDueHireWorkspaces({
      workspaceId: WORKSPACE_ID.toString(),
      now: NOW,
      storage,
      clock: () => NOW,
    })

    const claimFilter = models.HireMediaAsset.findOneAndUpdate.mock.calls[0][0]
    expect(claimFilter.$or).not.toEqual(expect.arrayContaining([
      expect.objectContaining({ state: 'purge_claimed' }),
    ]))
    expect(storage.delete).not.toHaveBeenCalled()
    expect(models.HireMediaAsset.deleteMany).not.toHaveBeenCalled()
    expect(models.HireWorkspace.deleteOne).not.toHaveBeenCalled()
    expect(report).toMatchObject({ claimed: 1, purged: 0, failed: 1, mediaObjectsDeleted: 0 })
  })

  it('does not remove the graph for a purged row without its delete acknowledgement timestamp', async () => {
    models.HireMediaAsset.exists.mockReturnValue(sessionResult({ _id: ASSET_ID }))

    const report = await purgeDueHireWorkspaces({
      workspaceId: WORKSPACE_ID.toString(),
      now: NOW,
      storage: { upload: vi.fn(), signRead: vi.fn(), delete: vi.fn() },
      clock: () => NOW,
    })

    expect(report).toMatchObject({ claimed: 1, purged: 0, failed: 1 })
    expect(models.HireMediaAsset.exists).toHaveBeenCalledWith({
      workspaceId: WORKSPACE_ID,
      $or: [
        { state: { $ne: 'purged' } },
        { purgedAt: { $exists: false } },
        { ingestionLeaseId: { $exists: true } },
        { ingestionLeaseExpiresAt: { $exists: true } },
      ],
    })
    expect(models.HireMediaAsset.deleteMany).not.toHaveBeenCalled()
    expect(models.HireWorkspace.deleteOne).not.toHaveBeenCalled()
  })
})
