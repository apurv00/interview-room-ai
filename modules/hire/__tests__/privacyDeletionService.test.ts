import mongoose from 'mongoose'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  connect: vi.fn(),
  decodeResource: vi.fn(),
  privacyFindOneAndUpdate: vi.fn(),
  privacyFindOne: vi.fn(),
  applicationFind: vi.fn(),
  applicationUpdateMany: vi.fn(),
  roundFind: vi.fn(),
  roundUpdateMany: vi.fn(),
  candidateUpdateOne: vi.fn(),
  guestUpdateMany: vi.fn(),
  attemptUpdateMany: vi.fn(),
  handoffUpdateMany: vi.fn(),
  mediaUpdateMany: vi.fn(),
  resultUpdateMany: vi.fn(),
  intakeTaskDeleteMany: vi.fn(),
  invitationBatchItemUpdateMany: vi.fn(),
  screeningGateUpdateMany: vi.fn(),
  outboxBulkWrite: vi.fn(),
  inviteDeleteMany: vi.fn(),
  consentBulkWrite: vi.fn(),
  humanKitDeliveryDeleteMany: vi.fn(),
  interviewKitDeleteMany: vi.fn(),
  humanScorecardDeleteMany: vi.fn(),
  humanRoundDeleteMany: vi.fn(),
  sharePacketUpdateMany: vi.fn(),
  externalVerdictUpdateMany: vi.fn(),
  cancelAssessmentExports: vi.fn(),
  deleteAssessmentExportObjects: vi.fn(),
  deliverRevocation: vi.fn(),
  candidateFence: vi.fn(),
}))

vi.mock('../services/hireControlBoundary', () => ({
  connectHireControlDB: mocks.connect,
}))
vi.mock('../services/workspaceCapability', () => ({
  decodeWorkspaceCapability: vi.fn(),
  decodeWorkspaceResourceCapability: mocks.decodeResource,
  encodeWorkspaceResourceCapability: vi.fn(),
}))
vi.mock('../services/engineRevocationService', () => ({
  deliverRuntimeRevocation: mocks.deliverRevocation,
}))
vi.mock('../services/hireCandidatePrivacyWriteFence', () => ({
  claimHireCandidatePiiWriteFence: mocks.candidateFence,
}))
vi.mock('../models/HirePrivacyRequest', () => ({
  HirePrivacyRequest: {
    findOneAndUpdate: mocks.privacyFindOneAndUpdate,
    findOne: mocks.privacyFindOne,
  },
}))
vi.mock('../models/HireApplication', () => ({
  HireApplication: {
    find: mocks.applicationFind,
    updateMany: mocks.applicationUpdateMany,
  },
}))
vi.mock('../models/HireRound', () => ({
  HireRound: {
    find: mocks.roundFind,
    updateMany: mocks.roundUpdateMany,
  },
}))
vi.mock('../models/HireCandidate', () => ({
  HireCandidate: { updateOne: mocks.candidateUpdateOne },
}))
vi.mock('../models/HireGuestSession', () => ({
  HireGuestSession: { updateMany: mocks.guestUpdateMany },
}))
vi.mock('../models/HireInterviewAttempt', () => ({
  HireInterviewAttempt: { updateMany: mocks.attemptUpdateMany },
}))
vi.mock('../models/HireEngineHandoff', () => ({
  HireEngineHandoff: { updateMany: mocks.handoffUpdateMany },
}))
vi.mock('../models/HireMediaAsset', () => ({
  HireMediaAsset: { updateMany: mocks.mediaUpdateMany },
}))
vi.mock('../models/HireInterviewResult', () => ({
  HireInterviewResult: { updateMany: mocks.resultUpdateMany },
}))
vi.mock('../models/HireIntakeTask', () => ({
  HireIntakeTask: { deleteMany: mocks.intakeTaskDeleteMany },
}))
vi.mock('../models/HireInvitationBatchItem', () => ({
  HireInvitationBatchItem: { updateMany: mocks.invitationBatchItemUpdateMany },
}))
vi.mock('../models/HireScreeningGate', () => ({
  HireScreeningGate: { updateMany: mocks.screeningGateUpdateMany },
}))
vi.mock('../models/HireEmailOutbox', () => ({
  HireEmailOutbox: { bulkWrite: mocks.outboxBulkWrite },
}))
vi.mock('../models/HireAiInviteDelivery', () => ({
  HireAiInviteDelivery: { deleteMany: mocks.inviteDeleteMany },
}))
vi.mock('../models/HireConsentReceipt', () => ({
  HireConsentReceipt: { bulkWrite: mocks.consentBulkWrite },
}))
vi.mock('../models/HireHumanKitDelivery', () => ({
  HireHumanKitDelivery: { deleteMany: mocks.humanKitDeliveryDeleteMany },
}))
vi.mock('../models/HireInterviewKit', () => ({
  HireInterviewKit: { deleteMany: mocks.interviewKitDeleteMany },
}))
vi.mock('../models/HireHumanScorecard', () => ({
  HireHumanScorecard: { deleteMany: mocks.humanScorecardDeleteMany },
}))
vi.mock('../models/HireHumanRound', () => ({
  HireHumanRound: { deleteMany: mocks.humanRoundDeleteMany },
}))
vi.mock('@hire-decisions/models', () => ({
  HireSharePacket: { updateMany: mocks.sharePacketUpdateMany },
  HireExternalVerdict: { updateMany: mocks.externalVerdictUpdateMany },
}))
vi.mock('../services/assessmentExportLifecycleService', () => ({
  cancelHireAssessmentExports: (...args: unknown[]) => mocks.cancelAssessmentExports(...args),
  deleteHireAssessmentExportObjects: (...args: unknown[]) => mocks.deleteAssessmentExportObjects(...args),
}))

import { applyVerifiedHirePrivacyRequest } from '../services/privacyService'

const WORKSPACE_ID = new mongoose.Types.ObjectId('111111111111111111111111')
const OTHER_WORKSPACE_ID = new mongoose.Types.ObjectId(
  '999999999999999999999999',
)
const CANDIDATE_ID = new mongoose.Types.ObjectId('222222222222222222222222')
const APPLICATION_A = new mongoose.Types.ObjectId('333333333333333333333333')
const APPLICATION_B = new mongoose.Types.ObjectId('444444444444444444444444')
const ROUND_A = new mongoose.Types.ObjectId('555555555555555555555555')
const ROUND_B = new mongoose.Types.ObjectId('666666666666666666666666')
const REQUEST_ID = '777777777777777777777777'
const NOW = new Date('2026-08-10T12:00:00.000Z')
const CAPABILITY = `${WORKSPACE_ID.toString()}.${REQUEST_ID}.${'a'.repeat(64)}`

const dbSession = {
  withTransaction: vi.fn(async (work: () => Promise<void>) => work()),
  endSession: vi.fn().mockResolvedValue(undefined),
}

function query<T>(value: T) {
  const chain = {
    select: vi.fn(),
    session: vi.fn(),
    lean: vi.fn().mockResolvedValue(value),
  }
  chain.select.mockReturnValue(chain)
  chain.session.mockReturnValue(chain)
  return chain
}

beforeEach(() => {
  vi.clearAllMocks()
  vi.spyOn(mongoose, 'startSession').mockResolvedValue(
    dbSession as unknown as mongoose.ClientSession,
  )
  dbSession.withTransaction.mockImplementation(
    async (work: () => Promise<void>) => work(),
  )
  dbSession.endSession.mockResolvedValue(undefined)
  mocks.connect.mockResolvedValue(undefined)
  mocks.decodeResource.mockReturnValue({
    workspaceId: WORKSPACE_ID.toString(),
    resourceId: REQUEST_ID,
    secret: 'a'.repeat(64),
  })
  mocks.privacyFindOneAndUpdate.mockResolvedValue({
    _id: new mongoose.Types.ObjectId(REQUEST_ID),
    workspaceId: WORKSPACE_ID,
    candidateId: CANDIDATE_ID,
    status: 'processing',
  })
  mocks.applicationFind.mockReturnValue(
    query([{ _id: APPLICATION_A }, { _id: APPLICATION_B }]),
  )
  mocks.roundFind.mockImplementation((filter: Record<string, unknown>) =>
    query(
      'runtimePurgeRequested' in filter
        ? []
        : [
            { _id: ROUND_A, applicationId: APPLICATION_A },
            { _id: ROUND_B, applicationId: APPLICATION_B },
          ],
    ),
  )
  for (const operation of [
    mocks.applicationUpdateMany,
    mocks.roundUpdateMany,
    mocks.candidateUpdateOne,
    mocks.guestUpdateMany,
    mocks.attemptUpdateMany,
    mocks.handoffUpdateMany,
    mocks.mediaUpdateMany,
    mocks.resultUpdateMany,
    mocks.intakeTaskDeleteMany,
    mocks.invitationBatchItemUpdateMany,
    mocks.screeningGateUpdateMany,
    mocks.outboxBulkWrite,
    mocks.inviteDeleteMany,
    mocks.consentBulkWrite,
    mocks.humanKitDeliveryDeleteMany,
    mocks.interviewKitDeleteMany,
    mocks.humanScorecardDeleteMany,
    mocks.humanRoundDeleteMany,
    mocks.sharePacketUpdateMany,
    mocks.externalVerdictUpdateMany,
  ]) {
    operation.mockResolvedValue({
      acknowledged: true,
      matchedCount: 1,
      modifiedCount: 1,
    })
  }
  mocks.deliverRevocation.mockResolvedValue(undefined)
  mocks.candidateFence.mockResolvedValue(undefined)
  mocks.cancelAssessmentExports.mockResolvedValue([])
  mocks.deleteAssessmentExportObjects.mockResolvedValue(undefined)
})

describe('verified Hire candidate deletion', () => {
  it('completes local PII cleanup before returning with exact tenant coordinates', async () => {
    const assessmentExportTarget = {
      key: 'hire-assessment-exports/v1/ws/job/app/candidate/export.pdf',
      coordinate: {
        workspaceId: WORKSPACE_ID.toString(),
        jobId: APPLICATION_A.toString(),
        applicationId: APPLICATION_A.toString(),
        candidateId: CANDIDATE_ID.toString(),
        exportId: REQUEST_ID,
      },
    }
    mocks.cancelAssessmentExports.mockResolvedValueOnce([assessmentExportTarget])
    await expect(
      applyVerifiedHirePrivacyRequest({
        requestCapability: CAPABILITY,
        now: NOW,
      }),
    ).resolves.toEqual({
      workspaceId: WORKSPACE_ID.toString(),
      candidateId: CANDIDATE_ID.toString(),
    })

    expect(mocks.candidateFence).toHaveBeenCalledWith({
      workspaceId: WORKSPACE_ID,
      candidateId: CANDIDATE_ID,
      session: dbSession,
    })
    expect(mocks.candidateFence.mock.invocationCallOrder[0]).toBeLessThan(
      mocks.applicationFind.mock.invocationCallOrder[0],
    )

    expect(mocks.outboxBulkWrite).toHaveBeenCalledWith(
      [APPLICATION_A, APPLICATION_B].map((applicationId) => ({
        deleteMany: {
          filter: {
            workspaceId: WORKSPACE_ID,
            candidateId: CANDIDATE_ID,
            applicationId,
          },
        },
      })),
      { session: dbSession },
    )
    expect(mocks.inviteDeleteMany).toHaveBeenCalledWith(
      {
        workspaceId: WORKSPACE_ID,
        candidateId: CANDIDATE_ID,
        $or: [
          { applicationId: APPLICATION_A, roundId: ROUND_A },
          { applicationId: APPLICATION_B, roundId: ROUND_B },
        ],
      },
      { session: dbSession },
    )
    expect(mocks.consentBulkWrite).toHaveBeenCalledWith(
      [
        { applicationId: APPLICATION_A, roundId: ROUND_A },
        { applicationId: APPLICATION_B, roundId: ROUND_B },
      ].map(({ applicationId, roundId }) => ({
        updateMany: {
          filter: {
            workspaceId: WORKSPACE_ID,
            candidateId: CANDIDATE_ID,
            applicationId,
            roundId,
          },
          update: { $unset: { userAgent: 1, locale: 1 } },
          overwriteImmutable: true,
        },
      })),
      { session: dbSession },
    )
    expect(mocks.applicationUpdateMany).toHaveBeenCalledWith(
      { workspaceId: WORKSPACE_ID, candidateId: CANDIDATE_ID },
      {
        $unset: {
          applicantSubmissions: 1,
          'events.$[sensitiveEvent].note': 1,
        },
      },
      {
        session: dbSession,
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
            ],
          },
        }],
      },
    )
    expect(mocks.intakeTaskDeleteMany).toHaveBeenCalledWith(
      { workspaceId: WORKSPACE_ID, candidateId: CANDIDATE_ID },
      { session: dbSession },
    )
    for (const operation of [
      mocks.humanKitDeliveryDeleteMany,
      mocks.interviewKitDeleteMany,
      mocks.humanScorecardDeleteMany,
      mocks.humanRoundDeleteMany,
    ]) {
      expect(operation).toHaveBeenCalledWith(
        { workspaceId: WORKSPACE_ID, candidateId: CANDIDATE_ID },
        { session: dbSession },
      )
    }
    expect(mocks.sharePacketUpdateMany).toHaveBeenNthCalledWith(
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
          revocationReason: 'Candidate privacy deletion request',
        },
      },
      { session: dbSession },
    )
    expect(mocks.sharePacketUpdateMany).toHaveBeenNthCalledWith(
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
      { session: dbSession, overwriteImmutable: true },
    )
    expect(mocks.externalVerdictUpdateMany).toHaveBeenCalledWith(
      {
        workspaceId: WORKSPACE_ID,
        candidateId: CANDIDATE_ID,
        privacyRedactedAt: { $exists: false },
      },
      {
        $set: { privacyRedactedAt: NOW },
        $unset: { comment: 1 },
      },
      { session: dbSession, overwriteImmutable: true },
    )
    expect(mocks.cancelAssessmentExports).toHaveBeenCalledWith({
      scope: { workspaceId: WORKSPACE_ID, candidateId: CANDIDATE_ID },
      cancelledAt: NOW,
      privacyRedactedAt: NOW,
      session: dbSession,
    })
    expect(mocks.deleteAssessmentExportObjects).toHaveBeenCalledWith([assessmentExportTarget])
    expect(mocks.cancelAssessmentExports.mock.invocationCallOrder[0]).toBeLessThan(
      mocks.deleteAssessmentExportObjects.mock.invocationCallOrder[0],
    )
    expect(mocks.invitationBatchItemUpdateMany).toHaveBeenNthCalledWith(
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
      { session: dbSession },
    )
    expect(mocks.screeningGateUpdateMany).toHaveBeenNthCalledWith(
      1,
      {
        workspaceId: WORKSPACE_ID,
        $or: [
          { 'rankedApplications.candidateId': CANDIDATE_ID },
          { 'rankedApplications.applicationId': { $in: [APPLICATION_A, APPLICATION_B] } },
          { 'exceptions.applicationId': { $in: [APPLICATION_A, APPLICATION_B] } },
        ],
      },
      {
        $pull: {
          rankedApplications: {
            $or: [
              { candidateId: CANDIDATE_ID },
              { applicationId: { $in: [APPLICATION_A, APPLICATION_B] } },
            ],
          },
          exceptions: { applicationId: { $in: [APPLICATION_A, APPLICATION_B] } },
        },
      },
      { session: dbSession, overwriteImmutable: true },
    )
    expect(mocks.screeningGateUpdateMany).toHaveBeenNthCalledWith(
      2,
      {
        workspaceId: WORKSPACE_ID,
        'cutLine.applicationId': { $in: [APPLICATION_A, APPLICATION_B] },
      },
      { $unset: { 'cutLine.applicationId': 1 } },
      { session: dbSession, overwriteImmutable: true },
    )
    expect(mocks.invitationBatchItemUpdateMany).toHaveBeenNthCalledWith(
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
      { session: dbSession, overwriteImmutable: true },
    )

    const destructiveFilters = [
      ...mocks.outboxBulkWrite.mock.calls[0][0].map(
        (operation: { deleteMany: { filter: Record<string, unknown> } }) =>
          operation.deleteMany.filter,
      ),
      mocks.inviteDeleteMany.mock.calls[0][0],
      ...mocks.consentBulkWrite.mock.calls[0][0].map(
        (operation: { updateMany: { filter: Record<string, unknown> } }) =>
          operation.updateMany.filter,
      ),
      mocks.intakeTaskDeleteMany.mock.calls[0][0],
      mocks.humanKitDeliveryDeleteMany.mock.calls[0][0],
      mocks.interviewKitDeleteMany.mock.calls[0][0],
      mocks.humanScorecardDeleteMany.mock.calls[0][0],
      mocks.humanRoundDeleteMany.mock.calls[0][0],
      mocks.sharePacketUpdateMany.mock.calls[0][0],
      mocks.sharePacketUpdateMany.mock.calls[1][0],
      mocks.externalVerdictUpdateMany.mock.calls[0][0],
      mocks.invitationBatchItemUpdateMany.mock.calls[0][0],
      mocks.invitationBatchItemUpdateMany.mock.calls[1][0],
    ]
    expect(destructiveFilters).not.toContainEqual(
      expect.objectContaining({ workspaceId: OTHER_WORKSPACE_ID }),
    )
    expect(
      destructiveFilters.every(
        (filter) =>
          filter.workspaceId === WORKSPACE_ID &&
          filter.candidateId === CANDIDATE_ID,
      ),
    ).toBe(true)
    for (const [filter] of mocks.screeningGateUpdateMany.mock.calls) {
      expect(filter).toMatchObject({ workspaceId: WORKSPACE_ID })
      expect(filter).not.toMatchObject({ workspaceId: OTHER_WORKSPACE_ID })
    }
  })

  it('does not resolve until the immediate transactional PII cleanup finishes', async () => {
    let releaseOutbox!: () => void
    mocks.outboxBulkWrite.mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          releaseOutbox = resolve
        }),
    )

    let settled = false
    const deletion = applyVerifiedHirePrivacyRequest({
      requestCapability: CAPABILITY,
      now: NOW,
    }).then((value) => {
      settled = true
      return value
    })

    await vi.waitFor(() => expect(mocks.outboxBulkWrite).toHaveBeenCalledOnce())
    expect(settled).toBe(false)
    expect(mocks.consentBulkWrite).not.toHaveBeenCalled()

    releaseOutbox()
    await expect(deletion).resolves.toEqual({
      workspaceId: WORKSPACE_ID.toString(),
      candidateId: CANDIDATE_ID.toString(),
    })
    expect(mocks.consentBulkWrite).toHaveBeenCalledOnce()
    expect(mocks.sharePacketUpdateMany).toHaveBeenCalledTimes(2)
    expect(mocks.externalVerdictUpdateMany).toHaveBeenCalledOnce()
    expect(mocks.screeningGateUpdateMany).toHaveBeenCalledTimes(2)
    expect(mocks.invitationBatchItemUpdateMany).toHaveBeenCalledTimes(2)
  })

  it('does not report deletion complete before durable screening coordinates are redacted', async () => {
    let releaseRedaction!: () => void
    mocks.invitationBatchItemUpdateMany
      .mockResolvedValueOnce({ modifiedCount: 1 })
      .mockImplementationOnce(
        () =>
          new Promise<void>((resolve) => {
            releaseRedaction = resolve
          }),
      )

    let settled = false
    const deletion = applyVerifiedHirePrivacyRequest({
      requestCapability: CAPABILITY,
      now: NOW,
    }).then((value) => {
      settled = true
      return value
    })

    await vi.waitFor(() =>
      expect(mocks.invitationBatchItemUpdateMany).toHaveBeenCalledTimes(2),
    )
    expect(mocks.screeningGateUpdateMany).toHaveBeenCalledTimes(2)
    expect(settled).toBe(false)

    releaseRedaction()
    await expect(deletion).resolves.toEqual({
      workspaceId: WORKSPACE_ID.toString(),
      candidateId: CANDIDATE_ID.toString(),
    })
  })
})
