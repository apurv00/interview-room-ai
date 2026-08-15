import mongoose from 'mongoose'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { AppError } from '@shared/errors'

const IDS = {
  workspace: '1'.repeat(24),
  member: '2'.repeat(24),
  outbox: '3'.repeat(24),
}

const mocks = vi.hoisted(() => ({
  connect: vi.fn(),
  memberTransaction: vi.fn(),
  egressTransaction: vi.fn(),
  preferenceFindOne: vi.fn(),
  preferenceFindOneAndUpdate: vi.fn(),
  preferenceFind: vi.fn(),
  preferenceUpdateOne: vi.fn(),
  preferenceUpdateMany: vi.fn(),
  outboxFindOne: vi.fn(),
  outboxFindOneAndUpdate: vi.fn(),
  outboxUpdateOne: vi.fn(),
  outboxUpdateMany: vi.fn(),
  outboxFind: vi.fn(),
  jobCount: vi.fn(),
  applicationCount: vi.fn(),
  roundCount: vi.fn(),
  deliveryCount: vi.fn(),
  testDriveFind: vi.fn(),
  privacyFind: vi.fn(),
  privacyFilter: vi.fn(),
  candidateFind: vi.fn(),
  workspaceFindOne: vi.fn(),
  workspaceUpdateOne: vi.fn(),
  memberFindOne: vi.fn(),
  sendEmail: vi.fn(),
}))

function query<T>(value: T) {
  const result = {
    select: vi.fn(),
    session: vi.fn(),
    sort: vi.fn(),
    limit: vi.fn(),
    lean: vi.fn(),
  }
  result.select.mockReturnValue(result)
  result.session.mockReturnValue(result)
  result.sort.mockReturnValue(result)
  result.limit.mockReturnValue(result)
  result.lean.mockResolvedValue(value)
  return result
}

function singleQuery<T>(value: T) {
  return { select: vi.fn().mockResolvedValue(value) }
}

function privacyRequestMatchesFilter(
  filter: Record<string, any>,
  request: { status: string; verificationExpiresAt: Date },
): boolean {
  if (filter.live !== true) return false
  if (!Array.isArray(filter.$or)) return true
  return filter.$or.some((condition: Record<string, any>) => {
    if (condition.status !== request.status) return false
    if (!condition.verificationExpiresAt) return true
    return request.verificationExpiresAt > condition.verificationExpiresAt.$gt
  })
}

vi.mock('../models', () => ({
  HireDigestPreference: {
    findOne: mocks.preferenceFindOne,
    findOneAndUpdate: mocks.preferenceFindOneAndUpdate,
    find: mocks.preferenceFind,
    updateOne: mocks.preferenceUpdateOne,
    updateMany: mocks.preferenceUpdateMany,
  },
  HireDigestOutbox: {
    findOne: mocks.outboxFindOne,
    findOneAndUpdate: mocks.outboxFindOneAndUpdate,
    updateOne: mocks.outboxUpdateOne,
    updateMany: mocks.outboxUpdateMany,
    find: mocks.outboxFind,
  },
}))
vi.mock('../services/hireDigestBoundary', () => ({
  connectHireDigestDB: mocks.connect,
  withActiveHireDigestMemberTransaction: mocks.memberTransaction,
  authorizeHireDigestEgress: mocks.egressTransaction,
}))
vi.mock('@hire/models/HireApplication', () => ({
  HireApplication: { countDocuments: mocks.applicationCount },
}))
vi.mock('@hire/models/HireCandidate', () => ({
  HireCandidate: { find: mocks.candidateFind },
}))
vi.mock('@hire/models/HireHumanKitDelivery', () => ({
  HireHumanKitDelivery: { countDocuments: mocks.deliveryCount },
}))
vi.mock('@hire/models/HireHumanRound', () => ({
  HireHumanRound: { countDocuments: mocks.roundCount },
}))
vi.mock('@hire/models/HireJob', () => ({
  HireJob: { countDocuments: mocks.jobCount },
}))
vi.mock('@hire/models/HirePrivacyRequest', () => ({
  HirePrivacyRequest: { find: mocks.privacyFind },
  activeHirePrivacyRequestFilter: mocks.privacyFilter,
}))
vi.mock('@hire/models/HireWorkspace', () => ({
  HireWorkspace: { findOne: mocks.workspaceFindOne, updateOne: mocks.workspaceUpdateOne },
}))
vi.mock('@hire/models/HireWorkspaceMember', () => ({
  HireWorkspaceMember: { findOne: mocks.memberFindOne },
}))
vi.mock('@/modules/hire-onboarding/models/HireOnboardingTestDrive', () => ({
  HireOnboardingTestDrive: { find: mocks.testDriveFind },
}))
vi.mock('@shared/services/emailService', () => ({
  sendEmail: mocks.sendEmail,
}))

import {
  buildHireDigestPayload,
  cancelHireDigestOutboxesForScope,
  invalidateHireDigestAggregateSnapshotsForPrivacy,
  listDueHireDigestOutboxIds,
  processHireDailyDigest,
  scheduleHireDailyDigestsForWorkspace,
  updateHireDigestPreference,
} from '../services/hireDigestService'
import { HIRE_DIGEST_MAX_ATTEMPTS } from '../types'

function outbox(overrides: Record<string, unknown> = {}) {
  return {
    _id: new mongoose.Types.ObjectId(IDS.outbox),
    workspaceId: new mongoose.Types.ObjectId(IDS.workspace),
    memberId: new mongoose.Types.ObjectId(IDS.member),
    periodKey: '2026-08-14',
    recipientEmail: 'member@example.com',
    recipientName: 'Hiring manager',
    payload: {
      workspaceName: 'Acme',
      generatedAt: new Date('2026-08-14T09:00:00.000Z'),
      openJobs: 2,
      awaitingDecision: 1,
      pendingScorecards: 3,
      terminalKitDeliveryFailures: 0,
    },
    status: 'sending',
    sendAfter: new Date('2026-08-14T09:00:00.000Z'),
    attempts: 1,
    privacyAggregateFenceVersion: 0,
    claimToken: 'claim-token',
    leaseExpiresAt: new Date('2099-01-01T00:00:00.000Z'),
    ...overrides,
  }
}

const CTX = {
  workspace: { _id: new mongoose.Types.ObjectId(IDS.workspace) },
  membership: {
    _id: new mongoose.Types.ObjectId(IDS.member),
    name: 'Hiring manager',
    email: 'member@example.com',
  },
} as any

beforeEach(() => {
  vi.clearAllMocks()
  mocks.connect.mockResolvedValue(undefined)
  mocks.memberTransaction.mockImplementation(async (_authority: unknown, work: (session: object) => unknown) => work({}))
  mocks.egressTransaction.mockImplementation(async (input: { work: (session: object) => unknown }) => input.work({}))
  mocks.jobCount.mockResolvedValue(2)
  mocks.applicationCount.mockResolvedValue(1)
  mocks.roundCount.mockResolvedValue(3)
  mocks.deliveryCount.mockResolvedValue(0)
  mocks.testDriveFind.mockReturnValue(query([]))
  mocks.privacyFind.mockReturnValue(query([]))
  mocks.privacyFilter.mockImplementation((now: Date) => ({
    live: true,
    $or: [
      { status: 'processing' },
      { status: 'pending_verification', verificationExpiresAt: { $gt: now } },
    ],
  }))
  mocks.candidateFind.mockReturnValue(query([]))
  mocks.preferenceUpdateOne.mockResolvedValue({ matchedCount: 1 })
  mocks.preferenceUpdateMany.mockResolvedValue({ modifiedCount: 1 })
  mocks.outboxUpdateOne.mockResolvedValue({
    modifiedCount: 1,
    upsertedCount: 0,
  })
  mocks.outboxUpdateMany.mockResolvedValue({ modifiedCount: 1 })
})

describe('Hire daily digest service', () => {
  it('builds a workspace-scoped aggregate-only snapshot with no candidate data', async () => {
    const payload = await buildHireDigestPayload({
      workspaceId: new mongoose.Types.ObjectId(IDS.workspace),
      workspaceName: 'Acme',
      now: new Date('2026-08-14T09:00:00.000Z'),
    })
    expect(payload).toEqual({
      workspaceName: 'Acme',
      generatedAt: new Date('2026-08-14T09:00:00.000Z'),
      openJobs: 2,
      awaitingDecision: 1,
      pendingScorecards: 3,
      terminalKitDeliveryFailures: 0,
    })
    expect(JSON.stringify(payload)).not.toMatch(/candidateId|email|resume|capability|decisionNote/i)
    for (const fn of [mocks.jobCount, mocks.applicationCount, mocks.roundCount, mocks.deliveryCount]) {
      expect(fn).toHaveBeenCalledWith(expect.objectContaining({ workspaceId: expect.anything() }), undefined)
    }
  })

  it('excludes every retained onboarding test-drive coordinate before digest aggregation', async () => {
    const testDrive = {
      jobId: new mongoose.Types.ObjectId('4'.repeat(24)),
      candidateId: new mongoose.Types.ObjectId('5'.repeat(24)),
      applicationId: new mongoose.Types.ObjectId('6'.repeat(24)),
    }
    mocks.testDriveFind.mockReturnValue(query([testDrive]))

    await buildHireDigestPayload({
      workspaceId: new mongoose.Types.ObjectId(IDS.workspace),
      workspaceName: 'Acme',
      now: new Date('2026-08-14T09:00:00.000Z'),
    })

    expect(mocks.jobCount).toHaveBeenCalledWith(expect.objectContaining({ _id: { $nin: [testDrive.jobId] } }), undefined)
    for (const fn of [mocks.applicationCount, mocks.roundCount, mocks.deliveryCount]) {
      expect(fn).toHaveBeenCalledWith(
        expect.objectContaining({
          jobId: { $nin: [testDrive.jobId] },
          candidateId: { $nin: [testDrive.candidateId] },
          applicationId: { $nin: [testDrive.applicationId] },
        }),
        undefined,
      )
    }
  })

  it('excludes only time-active privacy and anonymized candidate coordinates before digest aggregation', async () => {
    const expiredVerificationCandidateId = new mongoose.Types.ObjectId('7'.repeat(24))
    const processingCandidateId = new mongoose.Types.ObjectId('8'.repeat(24))
    const anonymizedCandidateId = new mongoose.Types.ObjectId('9'.repeat(24))
    const now = new Date('2026-08-14T09:00:00.000Z')
    const requests = [
      {
        candidateId: expiredVerificationCandidateId,
        status: 'pending_verification',
        verificationExpiresAt: new Date('2026-08-14T08:59:59.000Z'),
      },
      {
        candidateId: processingCandidateId,
        status: 'processing',
        verificationExpiresAt: new Date('2026-08-14T09:10:00.000Z'),
      },
    ]
    mocks.privacyFind.mockImplementation((filter: Record<string, any>) => query(requests
      .filter((request) => privacyRequestMatchesFilter(filter, request))
      .map(({ candidateId }) => ({ candidateId }))))
    mocks.candidateFind.mockReturnValue(query([{ _id: anonymizedCandidateId }]))

    await buildHireDigestPayload({
      workspaceId: new mongoose.Types.ObjectId(IDS.workspace),
      workspaceName: 'Acme',
      now,
    })

    for (const fn of [mocks.applicationCount, mocks.roundCount, mocks.deliveryCount]) {
      expect(fn).toHaveBeenCalledWith(
        expect.objectContaining({
          candidateId: { $nin: [processingCandidateId, anonymizedCandidateId] },
        }),
        undefined,
      )
    }
    expect(mocks.privacyFind).toHaveBeenCalledWith({
      workspaceId: expect.anything(),
      live: true,
      $or: [
        { status: 'processing' },
        { status: 'pending_verification', verificationExpiresAt: { $gt: now } },
      ],
    })
    expect(mocks.privacyFilter).toHaveBeenCalledWith(now)
  })

  it('cancels unfinished delivery rows atomically when the member opts out', async () => {
    mocks.preferenceFindOneAndUpdate.mockResolvedValue({
      enabled: false,
      updatedAt: new Date(),
    })
    await expect(updateHireDigestPreference(CTX, { enabled: false })).resolves.toMatchObject({ enabled: false })
    expect(mocks.outboxUpdateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        workspaceId: CTX.workspace._id,
        memberId: CTX.membership._id,
        status: { $in: ['pending', 'sending', 'failed'] },
      }),
      expect.objectContaining({
        $set: expect.objectContaining({ status: 'cancelled' }),
      }),
      expect.objectContaining({ session: expect.anything() }),
    )
  })

  it('rechecks opt-in/workspace/member authority, then sends with opaque idempotency and privacy-safe logs', async () => {
    const claimed = outbox()
    const authorized = outbox({ egressFenceVersion: 1 })
    mocks.outboxFindOneAndUpdate.mockReturnValueOnce(singleQuery(claimed)).mockReturnValueOnce(singleQuery(authorized))
    mocks.sendEmail.mockResolvedValue({ ok: true, id: 'provider-id' })
    await expect(
      processHireDailyDigest({
        workspaceId: IDS.workspace,
        outboxId: IDS.outbox,
        now: new Date('2026-08-14T10:00:00.000Z'),
      }),
    ).resolves.toEqual({ processed: true, outcome: 'sent' })
    expect(mocks.preferenceUpdateOne).toHaveBeenCalledWith(
      expect.objectContaining({
        enabled: true,
        workspaceId: claimed.workspaceId,
        memberId: claimed.memberId,
      }),
      { $inc: { writeFenceVersion: 1 } },
      expect.objectContaining({ session: expect.anything() }),
    )
    expect(mocks.egressTransaction).toHaveBeenCalledWith(
      expect.objectContaining({ privacyAggregateFenceVersion: claimed.privacyAggregateFenceVersion }),
    )
    expect(mocks.sendEmail).toHaveBeenCalledWith(
      expect.objectContaining({
        to: 'member@example.com',
        idempotencyKey: `hire-digest:${IDS.outbox}`,
        privacySafeLog: true,
      }),
    )
    expect(JSON.stringify(mocks.sendEmail.mock.calls[0])).not.toContain('claim-token')
  })

  it('never calls the provider when privacy commits after scheduling and before retry egress', async () => {
    const staleRetry = outbox({ attempts: 2, privacyAggregateFenceVersion: 4 })
    mocks.outboxFindOneAndUpdate.mockReturnValueOnce(singleQuery(staleRetry))
    mocks.egressTransaction.mockImplementationOnce(async (input: { privacyAggregateFenceVersion: number }) => {
      expect(input.privacyAggregateFenceVersion).toBe(4)
      // The boundary's atomic workspace epoch match failed because the
      // privacy transaction committed after scheduling but before egress.
      return null
    })
    await expect(
      processHireDailyDigest({
        workspaceId: IDS.workspace,
        outboxId: IDS.outbox,
      }),
    ).resolves.toEqual({ processed: true, outcome: 'cancelled' })
    expect(mocks.outboxUpdateOne).toHaveBeenCalledWith(
      expect.objectContaining({
        _id: staleRetry._id,
        status: 'sending',
        claimToken: staleRetry.claimToken,
      }),
      expect.objectContaining({ $set: expect.objectContaining({ status: 'cancelled' }) }),
    )
    expect(mocks.sendEmail).not.toHaveBeenCalled()
  })

  it('prevents an already selected digest from egressing when a terminal lifecycle transaction wins the shared workspace fence', async () => {
    const now = new Date('2026-08-14T10:00:00.000Z')
    const claimed = outbox()
    const terminalSession = { owner: 'terminal-transition' }
    const egressSession = { owner: 'digest-egress' }
    mocks.outboxFindOneAndUpdate
      .mockReturnValueOnce(singleQuery(claimed))
      // The terminal transaction cancelled the selected `sending` row before
      // this exact egress claim could commit.
      .mockReturnValueOnce(singleQuery(null))
    mocks.egressTransaction.mockImplementationOnce(async (input: {
      workspaceId: mongoose.Types.ObjectId
      privacyAggregateFenceVersion: number
      work: (session: object) => Promise<unknown>
    }) => {
      // A terminal move uses the same workspace write transaction as this
      // boundary. It must not advance the privacy epoch just to cancel a
      // stale aggregate workflow snapshot.
      expect(input.workspaceId).toEqual(claimed.workspaceId)
      expect(input.privacyAggregateFenceVersion).toBe(claimed.privacyAggregateFenceVersion)
      await cancelHireDigestOutboxesForScope({
        workspaceId: claimed.workspaceId,
        now,
        session: terminalSession as never,
      })
      return input.work(egressSession)
    })

    await expect(
      processHireDailyDigest({
        workspaceId: IDS.workspace,
        outboxId: IDS.outbox,
        now,
      }),
    ).resolves.toEqual({ processed: true, outcome: 'cancelled' })

    expect(mocks.outboxUpdateMany).toHaveBeenCalledWith(
      {
        workspaceId: claimed.workspaceId,
        status: { $in: ['pending', 'sending', 'failed'] },
      },
      expect.objectContaining({ $set: expect.objectContaining({ status: 'cancelled', cancelledAt: now }) }),
      { session: terminalSession },
    )
    expect(mocks.preferenceUpdateOne).toHaveBeenCalledWith(
      expect.objectContaining({
        workspaceId: claimed.workspaceId,
        memberId: claimed.memberId,
        enabled: true,
      }),
      { $inc: { writeFenceVersion: 1 } },
      { session: egressSession, timestamps: false },
    )
    expect(mocks.outboxFindOneAndUpdate).toHaveBeenLastCalledWith(
      expect.objectContaining({
        _id: claimed._id,
        status: 'sending',
        claimToken: claimed.claimToken,
      }),
      { $inc: { egressFenceVersion: 1 } },
      { new: true, session: egressSession },
    )
    expect(mocks.sendEmail).not.toHaveBeenCalled()
  })

  it('advances the workspace privacy epoch before cancelling every unfinished aggregate snapshot', async () => {
    const session = {}
    const now = new Date('2026-08-14T11:00:00.000Z')
    await invalidateHireDigestAggregateSnapshotsForPrivacy({
      workspaceId: CTX.workspace._id,
      now,
      session: session as never,
    })

    expect(mocks.workspaceUpdateOne).toHaveBeenCalledWith(
      { _id: CTX.workspace._id },
      { $inc: { writeFenceVersion: 1, privacyAggregateFenceVersion: 1 } },
      { session },
    )
    expect(mocks.outboxUpdateMany).toHaveBeenCalledWith(
      {
        workspaceId: CTX.workspace._id,
        status: { $in: ['pending', 'sending', 'failed'] },
      },
      expect.objectContaining({ $set: expect.objectContaining({ status: 'cancelled', cancelledAt: now }) }),
      { session },
    )
    expect(mocks.outboxUpdateMany.mock.invocationCallOrder[0]).toBeGreaterThan(
      mocks.workspaceUpdateOne.mock.invocationCallOrder[0],
    )
  })

  it('captures the current workspace privacy epoch on a newly scheduled snapshot', async () => {
    const digestRow = {
      _id: new mongoose.Types.ObjectId(IDS.outbox),
      periodKey: '2026-08-14',
      status: 'pending',
    }
    mocks.preferenceFind.mockReturnValue(query([{ memberId: new mongoose.Types.ObjectId(IDS.member) }]))
    mocks.preferenceFindOne.mockResolvedValue({ enabled: true })
    mocks.memberFindOne.mockReturnValue(singleQuery({ email: 'active@example.com', name: 'Active member' }))
    mocks.workspaceFindOne.mockReturnValue(singleQuery({ name: 'Acme', privacyAggregateFenceVersion: 9 }))
    mocks.outboxUpdateOne.mockResolvedValue({ upsertedCount: 1 })
    mocks.outboxFindOne.mockResolvedValue(digestRow)

    await expect(
      scheduleHireDailyDigestsForWorkspace({
        workspaceId: IDS.workspace,
        now: new Date('2026-08-14T10:00:00.000Z'),
      }),
    ).resolves.toEqual([IDS.outbox])

    expect(mocks.outboxUpdateOne).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        $setOnInsert: expect.objectContaining({ privacyAggregateFenceVersion: 9 }),
      }),
      expect.anything(),
    )
  })

  it('recovers an expired final sending lease as a no-egress terminalization', async () => {
    const now = new Date('2026-08-14T10:00:00.000Z')
    const exhausted = outbox({
      attempts: HIRE_DIGEST_MAX_ATTEMPTS,
      leaseExpiresAt: new Date('2026-08-14T09:59:59.000Z'),
    })
    mocks.outboxFind.mockReturnValue(query([{ _id: exhausted._id }]))

    await expect(listDueHireDigestOutboxIds({ workspaceId: IDS.workspace, now })).resolves.toEqual([IDS.outbox])
    expect(mocks.outboxFind).toHaveBeenCalledWith({
      workspaceId: exhausted.workspaceId,
      $or: [
        {
          attempts: { $lt: HIRE_DIGEST_MAX_ATTEMPTS },
          sendAfter: { $lte: now },
          $or: [{ status: { $in: ['pending', 'failed'] } }, { status: 'sending', leaseExpiresAt: { $lte: now } }],
        },
        {
          status: 'sending',
          attempts: { $gte: HIRE_DIGEST_MAX_ATTEMPTS },
          leaseExpiresAt: { $lte: now },
        },
      ],
    })

    mocks.outboxUpdateOne.mockResolvedValueOnce({ modifiedCount: 1 })
    mocks.outboxFindOneAndUpdate.mockReturnValueOnce(singleQuery(null))
    await expect(
      processHireDailyDigest({
        workspaceId: IDS.workspace,
        outboxId: IDS.outbox,
        now,
      }),
    ).resolves.toEqual({ processed: false })

    expect(mocks.outboxUpdateOne).toHaveBeenCalledWith(
      expect.objectContaining({
        _id: exhausted._id,
        workspaceId: exhausted.workspaceId,
        status: 'sending',
        attempts: { $gte: HIRE_DIGEST_MAX_ATTEMPTS },
        leaseExpiresAt: { $lte: now },
      }),
      {
        $set: { status: 'failed', failureCode: 'max_attempts' },
        $unset: { claimToken: 1, leaseExpiresAt: 1 },
      },
    )
    expect(mocks.outboxFindOneAndUpdate).toHaveBeenCalledWith(
      expect.objectContaining({
        _id: exhausted._id,
        $or: expect.arrayContaining([
          expect.objectContaining({
            attempts: { $lt: HIRE_DIGEST_MAX_ATTEMPTS },
          }),
        ]),
      }),
      expect.anything(),
      expect.anything(),
    )
    expect(mocks.egressTransaction).not.toHaveBeenCalled()
    expect(mocks.sendEmail).not.toHaveBeenCalled()
  })

  it('disables a lifecycle scope before cancelling its unfinished recipient rows', async () => {
    const { disableHireDigestDeliveryForScope } = await import('../services/hireDigestService')
    const session = {}
    await disableHireDigestDeliveryForScope({
      workspaceId: CTX.workspace._id,
      memberId: CTX.membership._id,
      now: new Date('2026-08-14T11:00:00.000Z'),
      session: session as never,
    })
    expect(mocks.preferenceUpdateMany).toHaveBeenCalledWith(
      {
        workspaceId: CTX.workspace._id,
        memberId: CTX.membership._id,
        enabled: true,
      },
      { $set: { enabled: false }, $inc: { writeFenceVersion: 1 } },
      { session },
    )
    expect(mocks.outboxUpdateMany.mock.invocationCallOrder[0]).toBeGreaterThan(mocks.preferenceUpdateMany.mock.invocationCallOrder[0])
  })

  it('continues scheduling other opted-in members when one became removed after the preference scan', async () => {
    const removedMemberId = new mongoose.Types.ObjectId('4'.repeat(24))
    const activeMemberId = new mongoose.Types.ObjectId('5'.repeat(24))
    const digestRow = {
      _id: new mongoose.Types.ObjectId(IDS.outbox),
      periodKey: '2026-08-14',
      status: 'pending',
    }
    mocks.preferenceFind.mockReturnValue(query([{ memberId: removedMemberId }, { memberId: activeMemberId }]))
    mocks.memberTransaction
      .mockRejectedValueOnce(new AppError('Member access is no longer active', 403, 'MEMBER_REMOVED'))
      .mockImplementationOnce(async (_authority: unknown, work: (session: object) => unknown) => work({}))
    mocks.preferenceFindOne.mockResolvedValue({ enabled: true })
    mocks.memberFindOne.mockReturnValue(singleQuery({ email: 'active@example.com', name: 'Active member' }))
    mocks.workspaceFindOne.mockReturnValue(singleQuery({ name: 'Acme' }))
    mocks.outboxUpdateOne.mockResolvedValue({ upsertedCount: 1 })
    mocks.outboxFindOne.mockResolvedValue(digestRow)

    await expect(
      scheduleHireDailyDigestsForWorkspace({
        workspaceId: IDS.workspace,
        now: new Date('2026-08-14T10:00:00.000Z'),
      }),
    ).resolves.toEqual([IDS.outbox])
  })
})
