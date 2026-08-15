import mongoose from 'mongoose'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { AppError } from '@shared/errors'

const mocks = vi.hoisted(() => ({
  connect: vi.fn(),
  writeFence: vi.fn(),
  candidateFence: vi.fn(),
  onboardingFence: vi.fn(),
  isOnboardingTestDriveCoordinate: vi.fn(),
  eventSend: vi.fn(),
  loggerWarn: vi.fn(),
  sendAiRound: vi.fn(),
  deliverAiInvite: vi.fn(),
  workspaceFindOne: vi.fn(),
  batchFindOne: vi.fn(),
  batchFind: vi.fn(),
  batchUpdateOne: vi.fn(),
  itemFind: vi.fn(),
  itemFindOneAndUpdate: vi.fn(),
  itemUpdateOne: vi.fn(),
  itemExists: vi.fn(),
  itemCreate: vi.fn(),
  batchCreate: vi.fn(),
  jobFindOne: vi.fn(),
  jobExists: vi.fn(),
  jobUpdateOne: vi.fn(),
  applicationFindOne: vi.fn(),
  applicationFind: vi.fn(),
  candidateFindOne: vi.fn(),
  candidateFind: vi.fn(),
  privacyExists: vi.fn(),
  memberFindOne: vi.fn(),
  gateFindOne: vi.fn(),
  roundFindOne: vi.fn(),
  deliveryFindOne: vi.fn(),
}))

vi.mock('../services/hireControlBoundary', () => ({
  connectHireControlDB: mocks.connect,
}))
vi.mock('../services/hireWorkspaceWriteFence', () => ({
  withActiveHireWorkspaceWriteTransaction: mocks.writeFence,
}))
vi.mock('../services/hireCandidatePrivacyWriteFence', () => ({
  claimHireCandidatePiiWriteFence: mocks.candidateFence,
}))
vi.mock('@hire-onboarding-boundary', () => ({
  assertHireOnboardingTestDriveWriteIsolation: (...args: unknown[]) =>
    mocks.onboardingFence(...args),
  isHireOnboardingTestDriveCoordinate: (...args: unknown[]) =>
    mocks.isOnboardingTestDriveCoordinate(...args),
}))
vi.mock('../services/workspaceService', () => ({
  activeHireWorkspaceLifecycleFilter: () => ({ lifecycleState: 'active' }),
}))
vi.mock('@shared/services/inngest', () => ({
  inngest: { send: mocks.eventSend },
}))
vi.mock('@shared/logger', () => ({ logger: { warn: mocks.loggerWarn } }))
vi.mock('../services/aiRoundService', () => ({ sendAiRound: mocks.sendAiRound }))
vi.mock('../services/aiInviteDeliveryService', () => ({ deliverAiInvite: mocks.deliverAiInvite }))
vi.mock('../models', () => ({
  TERMINAL_STAGES: ['hired', 'rejected', 'withdrawn'],
  HireAiInviteDelivery: { findOne: mocks.deliveryFindOne },
  HireInvitationBatchItem: {
    find: mocks.itemFind,
    findOneAndUpdate: mocks.itemFindOneAndUpdate,
    updateOne: mocks.itemUpdateOne,
    exists: mocks.itemExists,
    create: mocks.itemCreate,
  },
  HireJob: { findOne: mocks.jobFindOne, exists: mocks.jobExists, updateOne: mocks.jobUpdateOne },
  HireApplication: { findOne: mocks.applicationFindOne, find: mocks.applicationFind },
  HireCandidate: { findOne: mocks.candidateFindOne, find: mocks.candidateFind },
  HireInvitationBatch: {
    find: mocks.batchFind,
    findOne: mocks.batchFindOne,
    updateOne: mocks.batchUpdateOne,
    create: mocks.batchCreate,
  },
  HirePrivacyRequest: { exists: mocks.privacyExists },
  HireRound: { findOne: mocks.roundFindOne },
  HireScreeningGate: { findOne: mocks.gateFindOne },
  HireWorkspace: { findOne: mocks.workspaceFindOne },
  HireWorkspaceMember: { findOne: mocks.memberFindOne },
}))

import {
  createHireScreeningInvitationWaterfall,
  listDueHireScreeningInvitationItemIds,
  processHireScreeningInvitationItem,
  retryFailedHireScreeningInvitationBatch,
} from '../services/screeningInvitationService'

const IDS = {
  workspace: '111111111111111111111111',
  job: '222222222222222222222222',
  batch: '333333333333333333333333',
  item: '444444444444444444444444',
  secondItem: '454545454545454545454545',
  application: '555555555555555555555555',
  candidate: '666666666666666666666666',
  secondApplication: 'bbbbbbbbbbbbbbbbbbbbbbbb',
  secondCandidate: 'cccccccccccccccccccccccc',
  gate: '777777777777777777777777',
  member: '888888888888888888888888',
  round: '999999999999999999999999',
  delivery: 'aaaaaaaaaaaaaaaaaaaaaaaa',
}
const NOW = new Date('2026-08-13T10:00:00.000Z')
const SESSION = { id: 'screening-invitation-test-session' }
const id = (value: keyof typeof IDS) => new mongoose.Types.ObjectId(IDS[value])
const CTX = {
  workspace: { _id: id('workspace'), name: 'Acme' },
  membership: { _id: id('member'), name: 'Ava Recruiter', email: 'ava@acme.example' },
} as never

function query<T>(value: T) {
  const result = {
    select: vi.fn(),
    sort: vi.fn(),
    limit: vi.fn(),
    lean: vi.fn(),
    session: vi.fn(),
    then: (
      resolve: (resolved: T) => unknown,
      reject?: (reason: unknown) => unknown,
    ) => Promise.resolve(value).then(resolve, reject),
  }
  result.select.mockReturnValue(result)
  result.sort.mockReturnValue(result)
  result.limit.mockReturnValue(result)
  result.lean.mockReturnValue(result)
  result.session.mockReturnValue(result)
  return result
}

function invitationItem(overrides: Record<string, unknown> = {}) {
  return {
    _id: id('item'),
    workspaceId: id('workspace'),
    jobId: id('job'),
    screeningGateId: id('gate'),
    invitationBatchId: id('batch'),
    applicationId: id('application'),
    candidateId: id('candidate'),
    score: 92,
    scoreState: 'scored',
    selectionReason: 'top_n',
    sendAfter: NOW,
    status: 'sending',
    attempts: 1,
    manualRetryCount: 0,
    createdAt: NOW,
    updatedAt: NOW,
    ...overrides,
  }
}

function dispatchPrerequisites() {
  mocks.workspaceFindOne.mockReturnValue(query({ _id: id('workspace') }))
  mocks.batchFindOne.mockReturnValue(query({
    _id: id('batch'),
    createdByMemberId: id('member'),
  }))
  mocks.gateFindOne.mockReturnValue(query({ _id: id('gate') }))
  mocks.jobFindOne.mockReturnValue(query({ _id: id('job') }))
  mocks.applicationFindOne.mockReturnValue(query({ _id: id('application') }))
  mocks.candidateFindOne.mockReturnValue(query({ _id: id('candidate') }))
  mocks.privacyExists.mockReturnValue(query(null))
  mocks.memberFindOne.mockReturnValue(query({ _id: id('member') }))
  mocks.itemExists.mockReturnValue(query(true))
  mocks.roundFindOne.mockReturnValue(query(null))
}

beforeEach(() => {
  vi.clearAllMocks()
  mocks.connect.mockResolvedValue(undefined)
  mocks.writeFence.mockImplementation(
    async (_workspaceId: unknown, _memberId: unknown, work: (session: unknown) => unknown) => work(SESSION),
  )
  mocks.onboardingFence.mockResolvedValue(undefined)
  mocks.isOnboardingTestDriveCoordinate.mockResolvedValue(false)
  mocks.eventSend.mockResolvedValue(undefined)
  mocks.itemUpdateOne.mockResolvedValue({ matchedCount: 1 })
  mocks.batchUpdateOne.mockResolvedValue({ matchedCount: 1 })
  mocks.jobUpdateOne.mockResolvedValue({ matchedCount: 1 })
  mocks.itemFind.mockReturnValue(query([]))
  mocks.batchFind.mockReturnValue(query([]))
  mocks.applicationFind.mockReturnValue(query([]))
  mocks.candidateFind.mockReturnValue(query([]))
  mocks.batchCreate.mockResolvedValue([])
  mocks.itemCreate.mockResolvedValue([])
})

describe('screening invitation dispatch', () => {
  it('uses a bounded, tenant-scoped due query and excludes privacy-redacted rows', async () => {
    mocks.itemFind.mockReturnValue(query([{ _id: id('item') }, { _id: id('secondItem') }]))

    await expect(
      listDueHireScreeningInvitationItemIds({ workspaceId: IDS.workspace, limit: 999, now: NOW }),
    ).resolves.toEqual([IDS.item, IDS.secondItem])

    expect(mocks.itemFind).toHaveBeenCalledWith({
      workspaceId: id('workspace'),
      privacyRedactedAt: { $exists: false },
      $or: [
        {
          status: 'pending',
          attempts: { $lt: 5 },
          sendAfter: { $lte: NOW },
        },
        {
          status: 'sending',
          $or: [
            { leaseExpiresAt: { $lte: NOW } },
            { leaseExpiresAt: { $exists: false } },
          ],
        },
      ],
    })
    expect(mocks.itemFind.mock.results[0].value.limit).toHaveBeenCalledWith(10)
  })

  it('treats a guessed item id in another tenant as a no-op before any provider access', async () => {
    mocks.itemFindOneAndUpdate.mockResolvedValue(null)

    await expect(
      processHireScreeningInvitationItem({ workspaceId: IDS.workspace, itemId: IDS.item, now: NOW }),
    ).resolves.toEqual({ outcome: 'skipped', itemId: IDS.item })

    expect(mocks.itemFindOneAndUpdate).toHaveBeenCalledWith(
      expect.objectContaining({ _id: id('item'), workspaceId: id('workspace') }),
      expect.any(Object),
      { new: true },
    )
    expect(mocks.sendAiRound).not.toHaveBeenCalled()
    expect(mocks.deliverAiInvite).not.toHaveBeenCalled()
  })

  it('does not dereference or send a redacted item even if a legacy claim races migration', async () => {
    mocks.itemFindOneAndUpdate.mockResolvedValue(
      invitationItem({
        applicationId: undefined,
        candidateId: undefined,
        privacyRedactedAt: NOW,
      }),
    )

    await expect(
      processHireScreeningInvitationItem({ workspaceId: IDS.workspace, itemId: IDS.item, now: NOW }),
    ).resolves.toMatchObject({
      outcome: 'skipped',
      itemId: IDS.item,
      reason: 'Candidate personal data was deleted before invitation delivery',
    })

    expect(mocks.workspaceFindOne).not.toHaveBeenCalled()
    expect(mocks.sendAiRound).not.toHaveBeenCalled()
    expect(mocks.deliverAiInvite).not.toHaveBeenCalled()
    expect(mocks.itemUpdateOne).toHaveBeenCalledWith(
      expect.objectContaining({ workspaceId: id('workspace'), status: 'sending' }),
      expect.objectContaining({ $set: expect.objectContaining({ status: 'skipped' }) }),
    )
  })

  it('skips a legacy synthetic item before it can create or deliver an AI invite', async () => {
    mocks.itemFindOneAndUpdate.mockResolvedValue(invitationItem())
    mocks.isOnboardingTestDriveCoordinate.mockResolvedValue(true)
    mocks.itemFind.mockReturnValue(query([]))

    await expect(
      processHireScreeningInvitationItem({ workspaceId: IDS.workspace, itemId: IDS.item, now: NOW }),
    ).resolves.toMatchObject({
      outcome: 'skipped',
      itemId: IDS.item,
      reason: 'Practice interview data is isolated from screening delivery',
    })

    expect(mocks.workspaceFindOne).not.toHaveBeenCalled()
    expect(mocks.sendAiRound).not.toHaveBeenCalled()
    expect(mocks.deliverAiInvite).not.toHaveBeenCalled()
    expect(mocks.itemUpdateOne).toHaveBeenCalledWith(
      expect.objectContaining({ workspaceId: id('workspace'), status: 'sending' }),
      expect.objectContaining({ $set: expect.objectContaining({ status: 'skipped' }) }),
    )
  })

  it('links a failed durable delivery to one leased item and schedules a bounded retry without a duplicate claim', async () => {
    const claimed = invitationItem()
    mocks.itemFindOneAndUpdate
      .mockResolvedValueOnce(claimed)
      .mockResolvedValueOnce(null)
    dispatchPrerequisites()
    mocks.sendAiRound.mockResolvedValue({ round: { _id: id('round') } })
    mocks.deliveryFindOne.mockReturnValue(query({
      _id: id('delivery'),
      status: 'failed',
      lastError: 'Provider timeout',
    }))
    mocks.itemFind.mockReturnValue(query([{ status: 'pending' }]))

    await expect(
      processHireScreeningInvitationItem({ workspaceId: IDS.workspace, itemId: IDS.item, now: NOW }),
    ).resolves.toEqual({
      outcome: 'retry_scheduled',
      itemId: IDS.item,
      roundId: IDS.round,
    })
    await expect(
      processHireScreeningInvitationItem({ workspaceId: IDS.workspace, itemId: IDS.item, now: NOW }),
    ).resolves.toEqual({ outcome: 'skipped', itemId: IDS.item })

    expect(mocks.sendAiRound).toHaveBeenCalledTimes(1)
    expect(mocks.itemUpdateOne).toHaveBeenCalledWith(
      expect.objectContaining({
        _id: id('item'),
        workspaceId: id('workspace'),
        status: 'sending',
        claimToken: expect.any(String),
      }),
      expect.objectContaining({
        $set: expect.objectContaining({
          status: 'pending',
          roundId: id('round'),
          inviteDeliveryId: id('delivery'),
          deliveryStatus: 'failed',
          sendAfter: new Date(NOW.getTime() + 60_000),
        }),
      }),
    )
  })

  it('records a terminal-stage race as skipped instead of retrying or delivering an invite', async () => {
    mocks.itemFindOneAndUpdate.mockResolvedValue(invitationItem())
    dispatchPrerequisites()
    mocks.sendAiRound.mockRejectedValueOnce(new AppError(
      'The application is no longer eligible for an interview invitation',
      409,
      'APPLICATION_NOT_ELIGIBLE',
    ))
    mocks.itemFind.mockReturnValue(query([]))

    await expect(
      processHireScreeningInvitationItem({ workspaceId: IDS.workspace, itemId: IDS.item, now: NOW }),
    ).resolves.toEqual({
      outcome: 'skipped',
      itemId: IDS.item,
      reason: 'The application is no longer eligible for screening',
    })

    expect(mocks.sendAiRound).toHaveBeenCalledOnce()
    expect(mocks.deliverAiInvite).not.toHaveBeenCalled()
    expect(mocks.itemUpdateOne).toHaveBeenCalledWith(
      expect.objectContaining({
        _id: id('item'),
        workspaceId: id('workspace'),
        status: 'sending',
        claimToken: expect.any(String),
      }),
      expect.objectContaining({
        $set: expect.objectContaining({
          status: 'skipped',
          skipReason: 'The application is no longer eligible for screening',
        }),
      }),
    )
  })

  it('requeues only non-redacted failures on a one-minute manual-retry cadence and kicks only the first item', async () => {
    mocks.jobFindOne.mockReturnValue(query({ _id: id('job') }))
    mocks.batchFindOne.mockReturnValue(query({ _id: id('batch') }))
    mocks.itemFind.mockReturnValue(query([{ _id: id('item') }, { _id: id('secondItem') }]))
    mocks.itemUpdateOne.mockResolvedValue({ matchedCount: 1 })

    await expect(
      retryFailedHireScreeningInvitationBatch(CTX, {
        jobId: IDS.job,
        batchId: IDS.batch,
        now: NOW,
      }),
    ).resolves.toEqual({ requeued: 2, itemIds: [IDS.item, IDS.secondItem] })

    expect(mocks.itemFind).toHaveBeenCalledWith({
      workspaceId: id('workspace'),
      invitationBatchId: id('batch'),
      jobId: id('job'),
      status: 'failed',
      privacyRedactedAt: { $exists: false },
    })
    expect(mocks.itemUpdateOne).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({ _id: id('item'), privacyRedactedAt: { $exists: false } }),
      expect.objectContaining({ $set: expect.objectContaining({ sendAfter: NOW }) }),
      { session: SESSION },
    )
    expect(mocks.itemUpdateOne).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({ _id: id('secondItem'), privacyRedactedAt: { $exists: false } }),
      expect.objectContaining({
        $set: expect.objectContaining({ sendAfter: new Date(NOW.getTime() + 60_000) }),
      }),
      { session: SESSION },
    )
    expect(mocks.eventSend).toHaveBeenCalledWith({
      name: 'hire/screening-invitation.requested',
      data: { workspaceId: IDS.workspace, itemId: IDS.item },
    })
    expect(mocks.eventSend).toHaveBeenCalledTimes(1)
  })

  it('does not requeue or waterfall a synthetic screening job', async () => {
    mocks.onboardingFence.mockRejectedValue(
      new AppError('Practice interviews are isolated', 409, 'ONBOARDING_TEST_DRIVE_ISOLATED'),
    )

    await expect(
      retryFailedHireScreeningInvitationBatch(CTX, {
        jobId: IDS.job,
        batchId: IDS.batch,
        now: NOW,
      }),
    ).rejects.toMatchObject({ code: 'ONBOARDING_TEST_DRIVE_ISOLATED' })
    await expect(
      createHireScreeningInvitationWaterfall(CTX, {
        jobId: IDS.job,
        gateId: IDS.gate,
        count: 1,
        now: NOW,
      }),
    ).rejects.toMatchObject({ code: 'ONBOARDING_TEST_DRIVE_ISOLATED' })

    expect(mocks.itemUpdateOne).not.toHaveBeenCalled()
    expect(mocks.itemCreate).not.toHaveBeenCalled()
    expect(mocks.eventSend).not.toHaveBeenCalled()
  })

  it('never lets waterfall undo a documented manual exclusion', async () => {
    const manuallyExcluded = {
      applicationId: id('application'),
      candidateId: id('candidate'),
      rank: 1,
      score: 99,
      scoreState: 'scored',
      knockoutReasons: [],
      selectionReason: 'manual_exclude',
    }
    const nextEligible = {
      applicationId: id('secondApplication'),
      candidateId: id('secondCandidate'),
      rank: 2,
      score: 95,
      scoreState: 'scored',
      knockoutReasons: [],
      selectionReason: 'below_cut_line',
    }
    mocks.gateFindOne.mockReturnValue(query({
      _id: id('gate'),
      rankedApplications: [manuallyExcluded, nextEligible],
    }))
    mocks.applicationFind.mockReturnValue(query([{
      _id: id('secondApplication'),
      candidateId: id('secondCandidate'),
    }]))
    mocks.candidateFind.mockReturnValue(query([{ _id: id('secondCandidate') }]))
    mocks.privacyExists.mockReturnValue(query(null))
    mocks.candidateFence.mockResolvedValue(undefined)

    await expect(
      createHireScreeningInvitationWaterfall(CTX, {
        jobId: IDS.job,
        gateId: IDS.gate,
        count: 1,
        now: NOW,
      }),
    ).resolves.toMatchObject({ count: 1, itemIds: [expect.any(String)] })

    const createdItem = mocks.itemCreate.mock.calls[0][0][0]
    expect(createdItem).toMatchObject({
      applicationId: id('secondApplication'),
      candidateId: id('secondCandidate'),
      selectionReason: 'waterfall',
      sendAfter: NOW,
    })
    expect(mocks.applicationFind).toHaveBeenCalledWith({
      workspaceId: id('workspace'),
      jobId: id('job'),
      _id: { $in: [id('secondApplication')] },
      stage: { $nin: ['hired', 'rejected', 'withdrawn'] },
    })
  })
})
