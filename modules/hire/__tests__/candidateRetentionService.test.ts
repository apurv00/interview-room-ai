import mongoose from 'mongoose'
import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('../services/hireControlBoundary', () => ({
  connectHireControlDB: vi.fn().mockResolvedValue(undefined),
}))

const { models, session } = vi.hoisted(() => {
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
      HireEngineIngestionEvent: latestModel('hireengineingestionevents'),
      HireEmailOutbox: { deleteMany: vi.fn() },
      HireReengagementOptOut: { deleteMany: vi.fn() },
      HireIntakeTask: { deleteMany: vi.fn() },
      HireInvitationBatchItem: { updateMany: vi.fn() },
      HireScreeningGate: { updateMany: vi.fn() },
      HirePrivacyRequest: {
        exists: vi.fn(),
        deleteMany: vi.fn(),
      },
    },
    session: {
      withTransaction: vi.fn(async (work: () => Promise<void>) => work()),
      endSession: vi.fn().mockResolvedValue(undefined),
    },
  }
})

vi.mock('../models', () => models)

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
    models.HireMediaAsset,
    models.HireConsentReceipt,
    models.HireEngineIngestionEvent,
  ]) {
    model.findOne.mockReturnValue(findLatest(null))
  }
  models.HireApplication.updateMany.mockResolvedValue({ modifiedCount: 1 })
  models.HireRound.updateMany.mockResolvedValue({ modifiedCount: 1 })
  models.HireInterviewResult.updateMany.mockResolvedValue({ modifiedCount: 1 })
  models.HireConsentReceipt.updateMany.mockResolvedValue({ modifiedCount: 1 })
  models.HireEmailOutbox.deleteMany.mockResolvedValue({ deletedCount: 1 })
  models.HireReengagementOptOut.deleteMany.mockResolvedValue({ deletedCount: 1 })
  models.HireIntakeTask.deleteMany.mockResolvedValue({ deletedCount: 1 })
  models.HireInvitationBatchItem.updateMany.mockResolvedValue({ modifiedCount: 1 })
  models.HireScreeningGate.updateMany.mockResolvedValue({ modifiedCount: 1 })
  models.HirePrivacyRequest.deleteMany.mockResolvedValue({ deletedCount: 0 })
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
  })

  it('scrubs identity, resumes, invitation coordinates, and textual evidence while retaining aggregates', async () => {
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
    expect(models.HireApplication.updateMany).toHaveBeenCalledWith(
      { workspaceId: WORKSPACE_ID, candidateId: CANDIDATE_ID },
      {
        $unset: {
          applicantSubmissions: 1,
          'events.$[inviteEvent].note': 1,
        },
      },
      {
        session,
        arrayFilters: [{ 'inviteEvent.type': 'ai_round_sent' }],
      },
    )
    expect(models.HireInterviewResult.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({ workspaceId: WORKSPACE_ID, candidateId: CANDIDATE_ID }),
      expect.objectContaining({
        $set: { piiPurgedAt: NOW },
        $unset: { rawEngineOutput: 1, projection: 1, evidenceIndex: 1 },
      }),
      { session },
    )
    expect(models.HireEmailOutbox.deleteMany).toHaveBeenCalledWith(
      { workspaceId: WORKSPACE_ID, candidateId: CANDIDATE_ID },
      { session },
    )
    expect(models.HireReengagementOptOut.deleteMany).toHaveBeenCalledWith(
      { workspaceId: WORKSPACE_ID, candidateId: CANDIDATE_ID },
      { session },
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
