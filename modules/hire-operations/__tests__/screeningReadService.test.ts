import mongoose from 'mongoose'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  connect: vi.fn(),
  job: { findOne: vi.fn() },
  batch: { findOne: vi.fn() },
  application: { find: vi.fn() },
  candidate: { find: vi.fn() },
  item: { find: vi.fn() },
  privacy: { find: vi.fn() },
}))

vi.mock('@hire-operations-boundary', async () => {
  const actual = await vi.importActual<typeof import('@hire-operations-boundary')>(
    '@hire-operations-boundary',
  )
  return {
    ...actual,
    connectHireControlDB: mocks.connect,
    HireJob: mocks.job,
    HireInvitationBatch: mocks.batch,
    HireApplication: mocks.application,
    HireCandidate: mocks.candidate,
    HireInvitationBatchItem: mocks.item,
    HirePrivacyRequest: mocks.privacy,
  }
})

import {
  getJobScreeningMemberReadProjection,
  HIRE_SCREENING_RECIPIENT_MAX_LIMIT,
  readJobScreeningBatchRecipients,
} from '../services/screeningReadService'

const WORKSPACE_ID = new mongoose.Types.ObjectId('111111111111111111111111')
const OTHER_WORKSPACE_ID = new mongoose.Types.ObjectId('121212121212121212121212')
const JOB_ID = new mongoose.Types.ObjectId('222222222222222222222222')
const APPLICATION_ID = new mongoose.Types.ObjectId('333333333333333333333333')
const SECOND_APPLICATION_ID = new mongoose.Types.ObjectId('343434343434343434343434')
const CANDIDATE_ID = new mongoose.Types.ObjectId('444444444444444444444444')
const SECOND_CANDIDATE_ID = new mongoose.Types.ObjectId('454545454545454545454545')
const BATCH_ID = new mongoose.Types.ObjectId('555555555555555555555555')
const OTHER_BATCH_ID = new mongoose.Types.ObjectId('565656565656565656565656')
const ITEM_ID = new mongoose.Types.ObjectId('666666666666666666666666')
const NEXT_ITEM_ID = new mongoose.Types.ObjectId('676767676767676767676767')
const REDACTED_ITEM_ID = new mongoose.Types.ObjectId('686868686868686868686868')
const NOW = new Date('2026-08-23T09:00:00.000Z')

const ctx = {
  workspace: { _id: WORKSPACE_ID, name: 'Acme' },
  membership: {
    _id: new mongoose.Types.ObjectId('777777777777777777777777'),
    name: 'Ava Recruiter',
    email: 'ava@acme.example',
  },
} as never

function leanOne<T>(value: T) {
  return {
    select: vi.fn().mockReturnValue({ lean: vi.fn().mockResolvedValue(value) }),
  }
}

function leanMany<T>(value: T) {
  return {
    select: vi.fn().mockReturnValue({ lean: vi.fn().mockResolvedValue(value) }),
  }
}

function pagedLeanMany<T>(value: T) {
  const lean = vi.fn().mockResolvedValue(value)
  const limit = vi.fn().mockReturnValue({ lean })
  const sort = vi.fn().mockReturnValue({ limit })
  const select = vi.fn().mockReturnValue({ sort })
  return { query: { select }, select, sort, limit, lean }
}

function item(overrides: Record<string, unknown> = {}) {
  return {
    _id: ITEM_ID,
    invitationBatchId: BATCH_ID,
    applicationId: APPLICATION_ID,
    candidateId: CANDIDATE_ID,
    rank: 1,
    score: 92,
    scoreState: 'scored',
    selectionReason: 'top_n',
    sendAfter: NOW,
    status: 'pending',
    deliveryStatus: 'pending',
    attempts: 0,
    ...overrides,
  }
}

beforeEach(() => {
  vi.clearAllMocks()
  mocks.connect.mockResolvedValue(undefined)
  mocks.job.findOne.mockReturnValue(leanOne({ _id: JOB_ID }))
  mocks.batch.findOne.mockReturnValue(leanOne({ _id: BATCH_ID }))
  mocks.item.find.mockReturnValue(pagedLeanMany([]).query)
  mocks.application.find.mockReturnValue(leanMany([]))
  mocks.candidate.find.mockReturnValue(leanMany([]))
  mocks.privacy.find.mockReturnValue(leanMany([]))
})

describe('screening member read projection', () => {
  it('joins preview identity only through exact workspace, job, application, and candidate coordinates', async () => {
    mocks.application.find.mockReturnValue(leanMany([
      { _id: APPLICATION_ID, candidateId: CANDIDATE_ID },
    ]))
    mocks.candidate.find.mockReturnValue(leanMany([
      { _id: CANDIDATE_ID, name: 'Ada Lovelace', email: 'ada@example.com' },
    ]))

    const result = await getJobScreeningMemberReadProjection(ctx, JOB_ID.toString(), {
      candidateCoordinates: [
        {
          applicationId: APPLICATION_ID.toString(),
          candidateId: CANDIDATE_ID.toString(),
        },
        {
          applicationId: SECOND_APPLICATION_ID.toString(),
          candidateId: SECOND_CANDIDATE_ID.toString(),
        },
      ],
      now: NOW,
    })

    expect(mocks.job.findOne).toHaveBeenCalledWith({
      _id: JOB_ID,
      workspaceId: WORKSPACE_ID,
    })
    expect(mocks.application.find).toHaveBeenCalledWith({
      _id: { $in: [APPLICATION_ID, SECOND_APPLICATION_ID] },
      workspaceId: WORKSPACE_ID,
      jobId: JOB_ID,
    })
    expect(mocks.item.find).not.toHaveBeenCalled()
    expect(result.candidates).toEqual([
      {
        applicationId: APPLICATION_ID.toString(),
        candidateId: CANDIDATE_ID.toString(),
        identityState: 'available',
        displayName: 'Ada Lovelace',
        email: 'ada@example.com',
        applicationUrl: `/workspace/applications/${APPLICATION_ID.toString()}`,
      },
      {
        applicationId: SECOND_APPLICATION_ID.toString(),
        candidateId: SECOND_CANDIDATE_ID.toString(),
        identityState: 'unavailable',
        displayName: null,
        email: null,
        applicationUrl: null,
      },
    ])
  })

  it('fails closed at the job boundary before reading another workspace', async () => {
    mocks.job.findOne.mockReturnValue(leanOne(null))

    await expect(
      getJobScreeningMemberReadProjection(
        {
          ...ctx,
          workspace: { _id: OTHER_WORKSPACE_ID, name: 'Other workspace' },
        } as never,
        JOB_ID.toString(),
        {
          candidateCoordinates: [{
            applicationId: APPLICATION_ID.toString(),
            candidateId: CANDIDATE_ID.toString(),
          }],
        },
      ),
    ).rejects.toMatchObject({ statusCode: 404 })

    expect(mocks.application.find).not.toHaveBeenCalled()
    expect(mocks.candidate.find).not.toHaveBeenCalled()
  })
})

describe('screening recipient delivery pages', () => {
  it('uses a stable bounded page and a tenant/job/batch-scoped cursor', async () => {
    const firstQuery = pagedLeanMany([
      item({
        status: 'failed',
        deliveryStatus: 'failed',
        attempts: 3,
        lastError: 'SMTP password=do-not-expose provider stack',
      }),
      item({ _id: NEXT_ITEM_ID }),
    ])
    mocks.item.find.mockReturnValueOnce(firstQuery.query)
    mocks.application.find.mockReturnValue(leanMany([
      { _id: APPLICATION_ID, candidateId: CANDIDATE_ID },
    ]))
    mocks.candidate.find.mockReturnValue(leanMany([
      { _id: CANDIDATE_ID, name: 'Ada Lovelace', email: 'ada@example.com' },
    ]))

    const first = await readJobScreeningBatchRecipients(
      ctx,
      JOB_ID.toString(),
      BATCH_ID.toString(),
      { limit: 1, now: NOW },
    )

    expect(mocks.batch.findOne).toHaveBeenCalledWith({
      _id: BATCH_ID,
      workspaceId: WORKSPACE_ID,
      jobId: JOB_ID,
    })
    expect(mocks.item.find).toHaveBeenCalledWith({
      workspaceId: WORKSPACE_ID,
      jobId: JOB_ID,
      invitationBatchId: BATCH_ID,
    })
    expect(firstQuery.sort).toHaveBeenCalledWith({ _id: 1 })
    expect(firstQuery.limit).toHaveBeenCalledWith(2)
    expect(first).toMatchObject({
      hasMore: true,
      nextCursor: expect.any(String),
      recipients: [{
        id: ITEM_ID.toString(),
        status: 'failed',
        attempts: 3,
        candidate: {
          displayName: 'Ada Lovelace',
          email: 'ada@example.com',
          applicationUrl: `/workspace/applications/${APPLICATION_ID.toString()}`,
        },
        issue: { code: 'delivery_failed' },
      }],
    })
    expect(JSON.stringify(first)).not.toContain('do-not-expose')

    const decoded = JSON.parse(
      Buffer.from(first.nextCursor!, 'base64url').toString('utf8'),
    )
    expect(decoded).toEqual({
      v: 1,
      workspaceId: WORKSPACE_ID.toString(),
      jobId: JOB_ID.toString(),
      batchId: BATCH_ID.toString(),
      itemId: ITEM_ID.toString(),
    })

    const nextQuery = pagedLeanMany([])
    mocks.item.find.mockReturnValueOnce(nextQuery.query)
    const second = await readJobScreeningBatchRecipients(
      ctx,
      JOB_ID.toString(),
      BATCH_ID.toString(),
      { cursor: first.nextCursor!, limit: 1, now: NOW },
    )
    expect(mocks.item.find).toHaveBeenLastCalledWith({
      workspaceId: WORKSPACE_ID,
      jobId: JOB_ID,
      invitationBatchId: BATCH_ID,
      _id: { $gt: ITEM_ID },
    })
    expect(second).toEqual({ recipients: [], hasMore: false, nextCursor: null })

    const wrongScopeCursor = Buffer.from(JSON.stringify({
      ...decoded,
      batchId: OTHER_BATCH_ID.toString(),
    })).toString('base64url')
    mocks.item.find.mockClear()
    await expect(
      readJobScreeningBatchRecipients(
        ctx,
        JOB_ID.toString(),
        BATCH_ID.toString(),
        { cursor: wrongScopeCursor, limit: 1, now: NOW },
      ),
    ).rejects.toMatchObject({ statusCode: 400, code: 'INVALID_CURSOR' })
    expect(mocks.item.find).not.toHaveBeenCalled()
  })

  it('rejects unbounded pages before database access', async () => {
    await expect(
      readJobScreeningBatchRecipients(
        ctx,
        JOB_ID.toString(),
        BATCH_ID.toString(),
        { limit: HIRE_SCREENING_RECIPIENT_MAX_LIMIT + 1 },
      ),
    ).rejects.toMatchObject({ statusCode: 400, code: 'INVALID_LIMIT' })
    expect(mocks.connect).not.toHaveBeenCalled()
    expect(mocks.item.find).not.toHaveBeenCalled()
  })

  it('suppresses privacy-protected, missing, and redacted identities while retaining safe status', async () => {
    const pageQuery = pagedLeanMany([
      item({
        status: 'pending',
        attempts: 1,
        lastError: 'raw provider secret detail',
      }),
      item({
        _id: NEXT_ITEM_ID,
        applicationId: SECOND_APPLICATION_ID,
        candidateId: SECOND_CANDIDATE_ID,
        rank: 2,
        status: 'sent',
        attempts: 1,
        sentAt: NOW,
      }),
      item({
        _id: REDACTED_ITEM_ID,
        applicationId: undefined,
        candidateId: undefined,
        privacyRedactedAt: NOW,
        rank: undefined,
        status: 'skipped',
        attempts: 0,
      }),
    ])
    mocks.item.find.mockReturnValue(pageQuery.query)
    mocks.application.find.mockReturnValue(leanMany([
      { _id: APPLICATION_ID, candidateId: CANDIDATE_ID },
      { _id: SECOND_APPLICATION_ID, candidateId: SECOND_CANDIDATE_ID },
    ]))
    mocks.candidate.find.mockReturnValue(leanMany([
      { _id: CANDIDATE_ID, name: 'Private Candidate', email: 'private@example.com' },
    ]))
    mocks.privacy.find.mockReturnValue(leanMany([{ candidateId: CANDIDATE_ID }]))

    const result = await readJobScreeningBatchRecipients(
      ctx,
      JOB_ID.toString(),
      BATCH_ID.toString(),
      { now: NOW },
    )

    expect(result.recipients.map((recipient) => recipient.identityState)).toEqual([
      'privacy_protected',
      'unavailable',
      'privacy_redacted',
    ])
    expect(result.recipients[0].issue).toEqual({
      code: 'retry_scheduled',
      message: 'The last delivery attempt failed; an automatic retry is scheduled.',
    })
    expect(result.recipients[2]).toMatchObject({
      applicationId: null,
      candidate: null,
      issue: { code: 'privacy_redacted' },
    })
    expect(JSON.stringify(result)).not.toContain('Private Candidate')
    expect(JSON.stringify(result)).not.toContain('private@example.com')
    expect(JSON.stringify(result)).not.toContain('raw provider secret detail')
  })
})
