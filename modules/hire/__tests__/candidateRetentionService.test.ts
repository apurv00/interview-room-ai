import mongoose from 'mongoose'
import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('../services/hireControlBoundary', () => ({
  connectHireControlDB: vi.fn().mockResolvedValue(undefined),
}))

const {
  models,
  decisionModels,
  multimodalModels,
  session,
  lifecycle,
  statusLifecycle,
} = vi.hoisted(() => {
  const collection = (name: string) => ({ name })
  const latestModel = (name: string) => ({ collection: collection(name), findOne: vi.fn() })
  return {
    models: {
      TERMINAL_STAGES: ['hired', 'rejected', 'withdrawn'],
      HireWorkspace: { collection: collection('hireworkspaces') },
      HireCandidate: {
        collection: collection('hirecandidates'),
        aggregate: vi.fn(),
        updateOne: vi.fn(),
        findOne: vi.fn(),
      },
      HireApplication: {
        collection: collection('hireapplications'),
        find: vi.fn(),
        updateMany: vi.fn(),
      },
      HireJob: { collection: collection('hirejobs'), find: vi.fn() },
      HireRound: {
        ...latestModel('hirerounds'),
        updateMany: vi.fn(),
      },
      HireHumanRound: {
        ...latestModel('hirehumanrounds'),
        exists: vi.fn(),
        deleteMany: vi.fn(),
      },
      HireInterviewKit: {
        ...latestModel('hireinterviewkits'),
        exists: vi.fn(),
        deleteMany: vi.fn(),
      },
      HireHumanScorecard: {
        ...latestModel('hirehumanscorecards'),
        deleteMany: vi.fn(),
      },
      HireHumanKitDelivery: {
        ...latestModel('hirehumankitdeliveries'),
        deleteMany: vi.fn(),
      },
      HireInterviewAttempt: latestModel('hireinterviewattempts'),
      HireInterviewResult: {
        ...latestModel('hireinterviewresults'),
        updateMany: vi.fn(),
      },
      HireMediaAsset: latestModel('hiremediaassets'),
      HireConsentReceipt: {
        ...latestModel('hireconsentreceipts'),
        updateMany: vi.fn(),
      },
      HireEngineIngestionEvent: {
        ...latestModel('hireengineingestionevents'),
        updateMany: vi.fn(),
      },
      HireEmailOutbox: { deleteMany: vi.fn() },
      HireIntakeTask: { deleteMany: vi.fn() },
      HireInvitationBatchItem: { updateMany: vi.fn() },
      HireScreeningGate: { updateMany: vi.fn() },
      HirePrivacyRequest: {
        exists: vi.fn(),
        deleteMany: vi.fn(),
      },
    },
    decisionModels: {
      HireSharePacket: {
        ...latestModel('hiresharepackets'),
        exists: vi.fn(),
        updateMany: vi.fn(),
      },
      HireExternalVerdict: {
        ...latestModel('hireexternalverdicts'),
        updateMany: vi.fn(),
      },
      HireAssessmentExport: {
        ...latestModel('hireassessmentexports'),
        exists: vi.fn(),
        updateMany: vi.fn(),
      },
    },
    multimodalModels: {
      HireMultimodalObservation: {
        ...latestModel('hiremultimodalobservations'),
        deleteMany: vi.fn(),
      },
      HireMultimodalObservationIngestionEvent: { deleteMany: vi.fn() },
      HireMultimodalObservationPurgeObligation: {
        deleteMany: vi.fn(),
        updateMany: vi.fn(),
      },
    },
    session: {
      withTransaction: vi.fn(async (work: () => Promise<void>) => work()),
      endSession: vi.fn().mockResolvedValue(undefined),
    },
    lifecycle: {
      cancelAssessmentExports: vi.fn(),
      deleteAssessmentExportObjects: vi.fn(),
      cancelReportExports: vi.fn(),
      invalidateDigestSnapshots: vi.fn(),
      redactCandidateActions: vi.fn(),
    },
    statusLifecycle: {
      revokeStatusLinks: vi.fn(),
    },
  }
})

vi.mock('../models', () => models)
vi.mock('@hire-decisions/models', () => decisionModels)
vi.mock('../../hire-multimodal/models', () => multimodalModels)
vi.mock('../services/assessmentExportLifecycleService', () => ({
  cancelHireAssessmentExports: (...args: unknown[]) => lifecycle.cancelAssessmentExports(...args),
  deleteHireAssessmentExportObjects: (...args: unknown[]) => lifecycle.deleteAssessmentExportObjects(...args),
}))
vi.mock('../../hire-reports/services/hireReportLifecycleService', () => ({
  cancelHireReportExportsForLifecycle: (...args: unknown[]) => lifecycle.cancelReportExports(...args),
}))
vi.mock('../../hire-digest/services/hireDigestService', () => ({
  invalidateHireDigestAggregateSnapshotsForPrivacy: (...args: unknown[]) => lifecycle.invalidateDigestSnapshots(...args),
}))
vi.mock('../../hire-candidate-actions/subject-lifecycle-boundary', () => ({
  redactHireCandidateActionSubjectData: (...args: unknown[]) =>
    lifecycle.redactCandidateActions(...args),
}))
vi.mock('../../hire-status/services/candidateStatusLinkService', () => ({
  revokeCandidateStatusLinksForScope: (...args: unknown[]) =>
    statusLifecycle.revokeStatusLinks(...args),
}))

import {
  HIRE_CANDIDATE_RETENTION_MONTHS,
  anonymizeDueHireCandidates,
  buildHireCandidateRetentionPipeline,
} from '../services/candidateRetentionService'
import { addCalendarMonths } from '../services/mediaLifecycleService'

const CANDIDATE_ID = new mongoose.Types.ObjectId('111111111111111111111111')
const WORKSPACE_ID = new mongoose.Types.ObjectId('222222222222222222222222')
const OTHER_WORKSPACE_ID = new mongoose.Types.ObjectId('aaaaaaaaaaaaaaaaaaaaaaaa')
const JOB_ID = new mongoose.Types.ObjectId('333333333333333333333333')
const APPLICATION_ID = new mongoose.Types.ObjectId('444444444444444444444444')
const LAST_ACTIVITY = new Date('2024-02-29T10:30:00.000Z')
const NOW = new Date('2025-02-28T10:30:00.000Z')

function sessionValue<T>(value: T) {
  return { session: vi.fn().mockResolvedValue(value) }
}

function findMany<T>(value: T) {
  return {
    select: vi.fn().mockReturnValue({
      session: vi.fn().mockReturnValue({ lean: vi.fn().mockResolvedValue(value) }),
    }),
  }
}

function findLatest(value: unknown) {
  return {
    sort: vi.fn().mockReturnValue({
      select: vi.fn().mockReturnValue({
        session: vi.fn().mockReturnValue({ lean: vi.fn().mockResolvedValue(value) }),
      }),
    }),
  }
}

beforeEach(() => {
  vi.clearAllMocks()
  vi.spyOn(mongoose, 'startSession').mockResolvedValue(
    session as unknown as mongoose.ClientSession,
  )
  session.withTransaction.mockImplementation(async (work: () => Promise<void>) => work())
  session.endSession.mockResolvedValue(undefined)
  models.HireCandidate.aggregate.mockResolvedValue([
    {
      _id: CANDIDATE_ID,
      workspaceId: WORKSPACE_ID,
      lastActivityAt: LAST_ACTIVITY,
      retentionEligibleAt: NOW,
    },
  ])
  models.HireCandidate.updateOne.mockResolvedValue({ matchedCount: 1 })
  models.HireCandidate.findOne.mockReturnValue(sessionValue({
    _id: CANDIDATE_ID,
    workspaceId: WORKSPACE_ID,
    updatedAt: LAST_ACTIVITY,
  }))
  models.HirePrivacyRequest.exists.mockReturnValue(sessionValue(null))
  models.HireHumanRound.exists.mockReturnValue(sessionValue(null))
  models.HireInterviewKit.exists.mockReturnValue(sessionValue(null))
  decisionModels.HireSharePacket.exists.mockReturnValue(sessionValue(null))
  decisionModels.HireAssessmentExport.exists.mockReturnValue(sessionValue(null))
  models.HireApplication.find.mockReturnValue(findMany([
    { _id: APPLICATION_ID, jobId: JOB_ID, stage: 'rejected', updatedAt: LAST_ACTIVITY },
  ]))
  models.HireJob.find.mockReturnValue(findMany([
    { _id: JOB_ID, status: 'closed', closedAt: LAST_ACTIVITY },
  ]))
  for (const model of [
    models.HireRound,
    models.HireInterviewAttempt,
    models.HireInterviewResult,
    multimodalModels.HireMultimodalObservation,
    models.HireMediaAsset,
    models.HireConsentReceipt,
    models.HireEngineIngestionEvent,
    models.HireHumanRound,
    models.HireInterviewKit,
    models.HireHumanScorecard,
    models.HireHumanKitDelivery,
    decisionModels.HireSharePacket,
    decisionModels.HireExternalVerdict,
    decisionModels.HireAssessmentExport,
  ]) {
    model.findOne.mockReturnValue(findLatest(null))
  }
  models.HireApplication.updateMany.mockResolvedValue({ modifiedCount: 1 })
  models.HireRound.updateMany.mockResolvedValue({ modifiedCount: 1 })
  models.HireInterviewResult.updateMany.mockResolvedValue({ modifiedCount: 1 })
  models.HireEngineIngestionEvent.updateMany.mockResolvedValue({ modifiedCount: 1 })
  multimodalModels.HireMultimodalObservation.deleteMany.mockResolvedValue({ deletedCount: 1 })
  multimodalModels.HireMultimodalObservationIngestionEvent.deleteMany.mockResolvedValue({
    deletedCount: 1,
  })
  multimodalModels.HireMultimodalObservationPurgeObligation.deleteMany.mockResolvedValue({
    deletedCount: 1,
  })
  multimodalModels.HireMultimodalObservationPurgeObligation.updateMany.mockResolvedValue({
    modifiedCount: 1,
  })
  models.HireConsentReceipt.updateMany.mockResolvedValue({ modifiedCount: 1 })
  models.HireEmailOutbox.deleteMany.mockResolvedValue({ deletedCount: 1 })
  models.HireHumanRound.deleteMany.mockResolvedValue({ deletedCount: 1 })
  models.HireInterviewKit.deleteMany.mockResolvedValue({ deletedCount: 1 })
  models.HireHumanScorecard.deleteMany.mockResolvedValue({ deletedCount: 1 })
  models.HireHumanKitDelivery.deleteMany.mockResolvedValue({ deletedCount: 1 })
  models.HireIntakeTask.deleteMany.mockResolvedValue({ deletedCount: 1 })
  models.HireInvitationBatchItem.updateMany.mockResolvedValue({ modifiedCount: 1 })
  models.HireScreeningGate.updateMany.mockResolvedValue({ modifiedCount: 1 })
  models.HirePrivacyRequest.deleteMany.mockResolvedValue({ deletedCount: 0 })
  decisionModels.HireSharePacket.updateMany.mockResolvedValue({ modifiedCount: 1 })
  decisionModels.HireExternalVerdict.updateMany.mockResolvedValue({ modifiedCount: 1 })
  decisionModels.HireAssessmentExport.updateMany.mockResolvedValue({ modifiedCount: 1 })
  lifecycle.cancelAssessmentExports.mockResolvedValue([])
  lifecycle.deleteAssessmentExportObjects.mockResolvedValue(undefined)
  lifecycle.cancelReportExports.mockResolvedValue(0)
  lifecycle.invalidateDigestSnapshots.mockResolvedValue(undefined)
  statusLifecycle.revokeStatusLinks.mockResolvedValue(undefined)
})

describe('candidate PII retention', () => {
  it('uses calendar-month arithmetic for the 12-month clock, including leap day', () => {
    expect(HIRE_CANDIDATE_RETENTION_MONTHS).toBe(12)
    expect(addCalendarMonths(LAST_ACTIVITY, 12).toISOString()).toBe(NOW.toISOString())
  })

  it('builds a non-starving eligibility pipeline requiring terminal applications and closed jobs', () => {
    const pipeline = buildHireCandidateRetentionPipeline(WORKSPACE_ID, NOW, 25)
    expect(pipeline[0]).toEqual(expect.objectContaining({
      $match: expect.objectContaining({ workspaceId: WORKSPACE_ID }),
    }))
    expect(pipeline).toEqual(expect.arrayContaining([
      expect.objectContaining({
        $match: expect.objectContaining({
          'applications.0': { $exists: true },
          applications: {
            $not: {
              $elemMatch: { stage: { $nin: ['hired', 'rejected', 'withdrawn'] } },
            },
          },
        }),
      }),
      expect.objectContaining({
        $set: {
          retentionEligibleAt: {
            $dateAdd: { startDate: '$lastActivityAt', unit: 'month', amount: 12 },
          },
        },
      }),
      { $limit: 25 },
    ]))
    expect(pipeline).toEqual(expect.arrayContaining([
      expect.objectContaining({ $lookup: expect.objectContaining({ from: 'hirehumanrounds' }) }),
      expect.objectContaining({ $lookup: expect.objectContaining({ from: 'hireinterviewkits' }) }),
      expect.objectContaining({ $lookup: expect.objectContaining({ from: 'hirehumanscorecards' }) }),
      expect.objectContaining({ $lookup: expect.objectContaining({ from: 'hirehumankitdeliveries' }) }),
      expect.objectContaining({ $lookup: expect.objectContaining({ from: 'hiresharepackets' }) }),
      expect.objectContaining({ $lookup: expect.objectContaining({ from: 'hireexternalverdicts' }) }),
      expect.objectContaining({ $lookup: expect.objectContaining({ from: 'hireassessmentexports' }) }),
      expect.objectContaining({ $lookup: expect.objectContaining({ from: 'hiremultimodalobservations' }) }),
    ]))
  })

  it('scrubs identity, resumes, invitation coordinates, and textual evidence while retaining aggregates', async () => {
    const assessmentExportTarget = {
      key: 'hire-assessment-exports/v1/ws/job/app/candidate/export.pdf',
      coordinate: {
        workspaceId: WORKSPACE_ID.toString(),
        jobId: JOB_ID.toString(),
        applicationId: APPLICATION_ID.toString(),
        candidateId: CANDIDATE_ID.toString(),
        exportId: '555555555555555555555555',
      },
    }
    lifecycle.cancelAssessmentExports.mockResolvedValueOnce([assessmentExportTarget])
    const report = await anonymizeDueHireCandidates({
      workspaceId: WORKSPACE_ID.toString(),
      now: NOW,
      batchSize: 1,
    })

    expect(report).toEqual({ scanned: 1, claimed: 1, anonymized: 1, skipped: 0, failed: 0 })
    expect(models.HireCandidate.updateOne).toHaveBeenCalledWith(
      expect.objectContaining({
        _id: CANDIDATE_ID,
        workspaceId: WORKSPACE_ID,
        piiAnonymizedAt: { $exists: false },
      }),
      expect.objectContaining({
        $set: expect.objectContaining({
          name: 'Anonymized candidate',
          email: `retained-${CANDIDATE_ID.toString()}@privacy.invalid`,
          piiAnonymizedAt: NOW,
          piiAnonymizationReason: 'retention',
        }),
        $unset: expect.objectContaining({ phone: 1, resumeText: 1, resumeFileName: 1 }),
      }),
      { session },
    )
    expect(lifecycle.invalidateDigestSnapshots).toHaveBeenCalledWith({
      workspaceId: WORKSPACE_ID,
      now: NOW,
      session,
    })
    expect(lifecycle.invalidateDigestSnapshots.mock.invocationCallOrder[0]).toBeLessThan(
      models.HireCandidate.updateOne.mock.invocationCallOrder[1],
    )
    expect(models.HireApplication.updateMany).toHaveBeenCalledWith(
      { workspaceId: WORKSPACE_ID, candidateId: CANDIDATE_ID },
      {
        $unset: {
          applicantSubmissions: 1,
          decisionNote: 1,
          'offerDecision.note': 1,
          'events.$[sensitiveEvent].note': 1,
        },
      },
      {
        session,
        arrayFilters: [{
          'sensitiveEvent.type': {
            $in: [
              'ai_round_sent',
              'human_round_logged',
              'human_kit_sent',
              'human_kit_delivery_failed',
              'human_kit_reminded',
              'human_kit_revoked',
              'human_scorecard_submitted',
              'stage_move',
            ],
          },
        }],
      },
    )
    expect(lifecycle.redactCandidateActions).toHaveBeenCalledWith({
      workspaceId: WORKSPACE_ID,
      applicationIds: [APPLICATION_ID],
      at: NOW,
      session,
    })
    expect(models.HireInterviewResult.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({ workspaceId: WORKSPACE_ID, candidateId: CANDIDATE_ID }),
      expect.objectContaining({
        $set: { piiPurgedAt: NOW },
        $unset: { rawEngineOutput: 1, projection: 1, evidenceIndex: 1 },
      }),
      { session },
    )
    expect(models.HireEngineIngestionEvent.updateMany).toHaveBeenCalledWith(
      {
        workspaceId: WORKSPACE_ID,
        applicationId: { $in: [APPLICATION_ID] },
      },
      { $set: { media: [] } },
      { session },
    )
    for (const model of [
      multimodalModels.HireMultimodalObservationIngestionEvent,
      multimodalModels.HireMultimodalObservation,
    ]) {
      expect(model.deleteMany).toHaveBeenCalledWith(
        { workspaceId: WORKSPACE_ID, candidateId: CANDIDATE_ID },
        { session },
      )
    }
    expect(
      multimodalModels.HireMultimodalObservationPurgeObligation.deleteMany,
    ).toHaveBeenCalledWith(
      {
        workspaceId: WORKSPACE_ID,
        candidateId: CANDIDATE_ID,
        runtimePurgedAt: { $exists: true },
      },
      { session },
    )
    expect(
      multimodalModels.HireMultimodalObservationPurgeObligation.updateMany,
    ).toHaveBeenCalledWith(
      {
        workspaceId: WORKSPACE_ID,
        candidateId: CANDIDATE_ID,
        runtimePurgedAt: { $exists: false },
      },
      { $unset: { candidateId: 1 } },
      { session, overwriteImmutable: true },
    )
    expect(models.HireEmailOutbox.deleteMany).toHaveBeenCalledWith(
      { workspaceId: WORKSPACE_ID, candidateId: CANDIDATE_ID },
      { session },
    )
    for (const model of [
      models.HireHumanKitDelivery,
      models.HireInterviewKit,
      models.HireHumanScorecard,
      models.HireHumanRound,
    ]) {
      expect(model.deleteMany).toHaveBeenCalledWith(
        { workspaceId: WORKSPACE_ID, candidateId: CANDIDATE_ID },
        { session },
      )
    }
    expect(statusLifecycle.revokeStatusLinks).toHaveBeenCalledWith({
      workspaceId: WORKSPACE_ID,
      candidateId: CANDIDATE_ID,
      reason: 'Candidate retained and anonymized',
      at: NOW,
      session,
    })
    expect(statusLifecycle.revokeStatusLinks.mock.invocationCallOrder[0]).toBeLessThan(
      decisionModels.HireSharePacket.updateMany.mock.invocationCallOrder[0],
    )
    expect(decisionModels.HireSharePacket.updateMany).toHaveBeenNthCalledWith(
      1,
      {
        workspaceId: WORKSPACE_ID,
        candidateId: CANDIDATE_ID,
        active: true,
        status: 'active',
        revokedAt: { $exists: false },
      },
      {
        $set: {
          active: false,
          status: 'revoked',
          revokedAt: NOW,
          revocationReason: 'Candidate retained and anonymized',
        },
      },
      { session },
    )
    expect(decisionModels.HireSharePacket.updateMany).toHaveBeenNthCalledWith(
      2,
      {
        workspaceId: WORKSPACE_ID,
        candidateId: CANDIDATE_ID,
        privacyRedactedAt: { $exists: false },
      },
      {
        $set: { privacyRedactedAt: NOW },
        $unset: { secretHash: 1, snapshot: 1 },
      },
      { session, overwriteImmutable: true },
    )
    expect(decisionModels.HireExternalVerdict.updateMany).toHaveBeenCalledWith(
      {
        workspaceId: WORKSPACE_ID,
        candidateId: CANDIDATE_ID,
        privacyRedactedAt: { $exists: false },
      },
      {
        $set: { privacyRedactedAt: NOW },
        $unset: { comment: 1 },
      },
      { session, overwriteImmutable: true },
    )
    expect(lifecycle.cancelAssessmentExports).toHaveBeenCalledWith({
      scope: { workspaceId: WORKSPACE_ID, candidateId: CANDIDATE_ID },
      cancelledAt: NOW,
      privacyRedactedAt: NOW,
      session,
    })
    expect(lifecycle.cancelReportExports).toHaveBeenCalledWith({
      scope: { workspaceId: WORKSPACE_ID, candidateId: CANDIDATE_ID },
      cancelledAt: NOW,
      session,
    })
    expect(lifecycle.cancelAssessmentExports.mock.invocationCallOrder[0]).toBeLessThan(
      lifecycle.cancelReportExports.mock.invocationCallOrder[0],
    )
    expect(lifecycle.deleteAssessmentExportObjects).toHaveBeenCalledWith([assessmentExportTarget])
    expect(lifecycle.cancelAssessmentExports.mock.invocationCallOrder[0]).toBeLessThan(
      lifecycle.deleteAssessmentExportObjects.mock.invocationCallOrder[0],
    )
    expect(models.HireIntakeTask.deleteMany).toHaveBeenCalledWith(
      { workspaceId: WORKSPACE_ID, candidateId: CANDIDATE_ID },
      { session },
    )
    expect(models.HireInvitationBatchItem.updateMany).toHaveBeenNthCalledWith(
      1,
      {
        workspaceId: WORKSPACE_ID,
        candidateId: CANDIDATE_ID,
        status: { $in: ['pending', 'sending', 'failed'] },
      },
      {
        $set: { status: 'cancelled', cancelledAt: NOW },
        $unset: { claimToken: 1, leaseExpiresAt: 1 },
      },
      { session },
    )
    expect(models.HireScreeningGate.updateMany).toHaveBeenNthCalledWith(
      1,
      {
        workspaceId: WORKSPACE_ID,
        $or: [
          { 'rankedApplications.candidateId': CANDIDATE_ID },
          { 'rankedApplications.applicationId': { $in: [APPLICATION_ID] } },
          { 'exceptions.applicationId': { $in: [APPLICATION_ID] } },
        ],
      },
      {
        $pull: {
          rankedApplications: {
            $or: [
              { candidateId: CANDIDATE_ID },
              { applicationId: { $in: [APPLICATION_ID] } },
            ],
          },
          exceptions: { applicationId: { $in: [APPLICATION_ID] } },
        },
        $unset: { selectionHandoff: 1 },
      },
      { session, overwriteImmutable: true },
    )
    expect(models.HireScreeningGate.updateMany).toHaveBeenNthCalledWith(
      2,
      {
        workspaceId: WORKSPACE_ID,
        'cutLine.applicationId': { $in: [APPLICATION_ID] },
      },
      { $unset: { 'cutLine.applicationId': 1 } },
      { session, overwriteImmutable: true },
    )
    expect(models.HireInvitationBatchItem.updateMany).toHaveBeenNthCalledWith(
      2,
      {
        workspaceId: WORKSPACE_ID,
        candidateId: CANDIDATE_ID,
        privacyRedactedAt: { $exists: false },
      },
      {
        $set: { privacyRedactedAt: NOW },
        $unset: {
          applicationId: 1,
          candidateId: 1,
          roundId: 1,
          inviteDeliveryId: 1,
          deliveryStatus: 1,
          providerMessageId: 1,
          lastError: 1,
          skipReason: 1,
          claimToken: 1,
          leaseExpiresAt: 1,
        },
      },
      { session, overwriteImmutable: true },
    )
    for (const [filter] of models.HireScreeningGate.updateMany.mock.calls) {
      expect(filter).toMatchObject({ workspaceId: WORKSPACE_ID })
      expect(filter).not.toMatchObject({ workspaceId: OTHER_WORKSPACE_ID })
    }
    for (const [filter] of models.HireInvitationBatchItem.updateMany.mock.calls) {
      expect(filter).toMatchObject({
        workspaceId: WORKSPACE_ID,
        candidateId: CANDIDATE_ID,
      })
    }
  })

  it('lets an in-flight verified deletion request win and releases the retention claim', async () => {
    models.HirePrivacyRequest.exists.mockReturnValue(sessionValue({ _id: 'privacy' }))

    const report = await anonymizeDueHireCandidates({
      workspaceId: WORKSPACE_ID.toString(),
      now: NOW,
    })

    expect(report).toEqual({ scanned: 1, claimed: 1, anonymized: 0, skipped: 1, failed: 0 })
    expect(models.HireApplication.updateMany).not.toHaveBeenCalled()
    expect(statusLifecycle.revokeStatusLinks).not.toHaveBeenCalled()
    expect(models.HireCandidate.updateOne).toHaveBeenLastCalledWith(
      expect.objectContaining({ anonymizationClaimToken: expect.any(String) }),
      expect.objectContaining({
        $unset: expect.objectContaining({
          anonymizationClaimToken: 1,
          anonymizationLeaseExpiresAt: 1,
        }),
      }),
      { timestamps: false },
    )
  })

  it('does not anonymize while a pending human round or active kit can still expose a brief', async () => {
    models.HireHumanRound.exists.mockReturnValue(sessionValue({ _id: 'human-round' }))

    const report = await anonymizeDueHireCandidates({
      workspaceId: WORKSPACE_ID.toString(),
      now: NOW,
    })

    expect(report).toEqual({ scanned: 1, claimed: 1, anonymized: 0, skipped: 1, failed: 0 })
    expect(models.HireInterviewKit.exists).not.toHaveBeenCalled()
    expect(models.HireHumanKitDelivery.deleteMany).not.toHaveBeenCalled()
    expect(models.HireCandidate.updateOne).toHaveBeenLastCalledWith(
      expect.objectContaining({ anonymizationClaimToken: expect.any(String) }),
      expect.objectContaining({
        $unset: expect.objectContaining({
          anonymizationClaimToken: 1,
          anonymizationLeaseExpiresAt: 1,
        }),
      }),
      { timestamps: false },
    )
  })

  it('requires a currently active kit before treating it as a retention fence', async () => {
    models.HireInterviewKit.exists.mockReturnValue(sessionValue({ _id: 'active-kit' }))

    const report = await anonymizeDueHireCandidates({
      workspaceId: WORKSPACE_ID.toString(),
      now: NOW,
    })

    expect(report).toEqual({ scanned: 1, claimed: 1, anonymized: 0, skipped: 1, failed: 0 })
    expect(models.HireInterviewKit.exists).toHaveBeenCalledWith({
      workspaceId: WORKSPACE_ID,
      candidateId: CANDIDATE_ID,
      active: true,
      status: 'active',
      revokedAt: { $exists: false },
      expiresAt: { $gt: NOW },
    })
    expect(models.HireHumanKitDelivery.deleteMany).not.toHaveBeenCalled()
  })

  it('fences an unexpired active share packet before candidate data is anonymized', async () => {
    decisionModels.HireSharePacket.exists.mockReturnValue(sessionValue({ _id: 'packet' }))

    const report = await anonymizeDueHireCandidates({
      workspaceId: WORKSPACE_ID.toString(),
      now: NOW,
    })

    expect(report).toEqual({ scanned: 1, claimed: 1, anonymized: 0, skipped: 1, failed: 0 })
    expect(decisionModels.HireSharePacket.exists).toHaveBeenCalledWith({
      workspaceId: WORKSPACE_ID,
      candidateId: CANDIDATE_ID,
      active: true,
      status: 'active',
      revokedAt: { $exists: false },
      expiresAt: { $gt: NOW },
    })
    expect(decisionModels.HireSharePacket.updateMany).not.toHaveBeenCalled()
    expect(decisionModels.HireExternalVerdict.updateMany).not.toHaveBeenCalled()
  })

  it('fences a live assessment export before candidate data is anonymized', async () => {
    decisionModels.HireAssessmentExport.exists.mockReturnValue(sessionValue({ _id: 'export' }))

    const report = await anonymizeDueHireCandidates({
      workspaceId: WORKSPACE_ID.toString(),
      now: NOW,
    })

    expect(report).toEqual({ scanned: 1, claimed: 1, anonymized: 0, skipped: 1, failed: 0 })
    expect(decisionModels.HireAssessmentExport.exists).toHaveBeenCalledWith({
      workspaceId: WORKSPACE_ID,
      candidateId: CANDIDATE_ID,
      status: { $ne: 'cancelled' },
      expiresAt: { $gt: NOW },
    })
    expect(lifecycle.cancelAssessmentExports).not.toHaveBeenCalled()
  })

  it('records a retryable failure without marking the candidate anonymized', async () => {
    models.HireApplication.updateMany.mockRejectedValueOnce(new Error('write conflict'))

    const report = await anonymizeDueHireCandidates({
      workspaceId: WORKSPACE_ID.toString(),
      now: NOW,
    })

    expect(report).toEqual({ scanned: 1, claimed: 1, anonymized: 0, skipped: 0, failed: 1 })
    expect(models.HireCandidate.updateOne).toHaveBeenLastCalledWith(
      expect.objectContaining({ anonymizationClaimToken: expect.any(String) }),
      expect.objectContaining({
        $set: { anonymizationLastError: 'Error: write conflict' },
        $unset: expect.objectContaining({
          anonymizationClaimToken: 1,
          anonymizationLeaseExpiresAt: 1,
        }),
      }),
      { timestamps: false },
    )
  })

  it('reports a live claim as retryable instead of silently skipping the due candidate', async () => {
    models.HireCandidate.updateOne.mockResolvedValueOnce({ matchedCount: 0 })

    const report = await anonymizeDueHireCandidates({
      workspaceId: WORKSPACE_ID.toString(),
      now: NOW,
    })

    expect(report).toEqual({ scanned: 1, claimed: 0, anonymized: 0, skipped: 0, failed: 1 })
    expect(session.withTransaction).not.toHaveBeenCalled()
  })
})
