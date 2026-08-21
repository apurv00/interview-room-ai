import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  connect: vi.fn(),
  withWorkspaceTransaction: vi.fn(),
  candidateFence: vi.fn(),
  analysisFindOne: vi.fn(),
  analysisUpdateOne: vi.fn(),
  applicationExists: vi.fn(),
  jobExists: vi.fn(),
  roundExists: vi.fn(),
  assetExists: vi.fn(),
  privacyExists: vi.fn(),
  send: vi.fn(),
  warn: vi.fn(),
}))

vi.mock('@hire', () => {
  class HireCandidatePiiTombstoneError extends Error {}
  return {
    HireApplication: { exists: mocks.applicationExists },
    HireJob: { exists: mocks.jobExists },
    HireRound: { exists: mocks.roundExists },
    HireMediaAsset: { exists: mocks.assetExists },
    HirePrivacyRequest: { exists: mocks.privacyExists },
    activeHirePrivacyRequestFilter: () => ({ live: true }),
    claimHireCandidatePiiWriteFence: mocks.candidateFence,
    connectHireControlDB: mocks.connect,
    HireCandidatePiiTombstoneError,
  }
})
vi.mock('@hire-multimodal-boundary', () => ({
  withActiveHireWorkspaceWriteTransaction: mocks.withWorkspaceTransaction,
}))
vi.mock('../models', () => ({
  HIRE_MULTIMODAL_ANALYSIS_MAX_RETRY_ATTEMPTS: 3,
  HireMultimodalAnalysis: {
    findOne: mocks.analysisFindOne,
    updateOne: mocks.analysisUpdateOne,
  },
}))
vi.mock('@shared/services/inngest', () => ({
  inngest: { send: mocks.send },
}))
vi.mock('@shared/logger', () => ({ aiLogger: { warn: mocks.warn } }))

import { retryFailedHireMultimodalAnalysis } from '../services/analysisRecoveryService'

const WORKSPACE_ID = '1'.repeat(24)
const MEMBER_ID = '2'.repeat(24)
const APPLICATION_ID = '3'.repeat(24)
const ANALYSIS_ID = '4'.repeat(24)
const JOB_ID = '5'.repeat(24)
const CANDIDATE_ID = '6'.repeat(24)
const ROUND_ID = '7'.repeat(24)
const ATTEMPT_ID = '8'.repeat(24)
const ASSET_ID = '9'.repeat(24)

function sessionQuery<T>(value: T) {
  return { session: vi.fn().mockResolvedValue(value) }
}

function analysisQuery<T>(value: T) {
  const query = {
    select: vi.fn(),
    sort: vi.fn(),
    session: vi.fn(),
    lean: vi.fn().mockResolvedValue(value),
  }
  query.select.mockReturnValue(query)
  query.sort.mockReturnValue(query)
  query.session.mockReturnValue(query)
  return query
}

function analysis(overrides: Record<string, unknown> = {}) {
  return {
    _id: ANALYSIS_ID,
    applicationId: APPLICATION_ID,
    jobId: JOB_ID,
    candidateId: CANDIDATE_ID,
    roundId: ROUND_ID,
    attemptId: ATTEMPT_ID,
    landmarksAssetId: ASSET_ID,
    status: 'failed',
    retryAttemptCount: 3,
    ...overrides,
  }
}

async function retry() {
  return retryFailedHireMultimodalAnalysis({
    workspaceId: WORKSPACE_ID,
    authorityMemberId: MEMBER_ID,
    applicationId: APPLICATION_ID,
    analysisId: ANALYSIS_ID,
    now: new Date('2026-08-21T12:00:00.000Z'),
  })
}

beforeEach(() => {
  vi.clearAllMocks()
  const session = { id: 'session' }
  mocks.withWorkspaceTransaction.mockImplementation(
    async (_workspaceId, _memberId, work) => work(session),
  )
  mocks.analysisFindOne.mockReturnValue(analysisQuery(analysis()))
  mocks.analysisUpdateOne.mockResolvedValue({ matchedCount: 1 })
  mocks.applicationExists.mockReturnValue(sessionQuery(true))
  mocks.jobExists.mockReturnValue(sessionQuery(true))
  mocks.roundExists.mockReturnValue(sessionQuery(true))
  mocks.assetExists.mockReturnValue(sessionQuery(true))
  mocks.privacyExists.mockReturnValue(sessionQuery(false))
  mocks.candidateFence.mockResolvedValue(undefined)
  mocks.connect.mockResolvedValue(undefined)
  mocks.send.mockResolvedValue(undefined)
})

describe('manual Hire multimodal analysis recovery', () => {
  it('requeues one exhausted analysis under the exact member and candidate fences', async () => {
    await expect(retry()).resolves.toEqual({ outcome: 'requeued', dispatch: 'sent' })

    expect(mocks.withWorkspaceTransaction).toHaveBeenCalledWith(
      expect.objectContaining({ toString: expect.any(Function) }),
      expect.objectContaining({ toString: expect.any(Function) }),
      expect.any(Function),
    )
    expect(mocks.candidateFence).toHaveBeenCalledWith(expect.objectContaining({
      candidateId: CANDIDATE_ID,
    }))
    const [filter, update, options] = mocks.analysisUpdateOne.mock.calls[0]
    expect(filter).toEqual(expect.objectContaining({
      status: 'failed',
      retryAttemptCount: { $gte: 3 },
    }))
    expect(filter._id.toString()).toBe(ANALYSIS_ID)
    expect(filter.applicationId.toString()).toBe(APPLICATION_ID)
    expect(update).toEqual(expect.objectContaining({
      $set: { status: 'pending', retryAttemptCount: 0 },
      $unset: expect.objectContaining({ retryAt: 1, errorCode: 1 }),
    }))
    expect(options).toEqual({ session: expect.anything() })
    expect(mocks.send).toHaveBeenCalledWith({
      name: 'hire/multimodal-analysis.requested',
      data: { workspaceId: WORKSPACE_ID, analysisId: ANALYSIS_ID },
    })
  })

  it('is idempotent when the same analysis is already queued', async () => {
    mocks.analysisFindOne.mockReturnValue(analysisQuery(analysis({ status: 'pending' })))

    await expect(retry()).resolves.toEqual({
      outcome: 'already_queued',
      dispatch: 'sent',
    })
    expect(mocks.analysisUpdateOne).not.toHaveBeenCalled()
  })

  it('rejects an automatic retry that has not exhausted its bounded attempts', async () => {
    mocks.analysisFindOne.mockReturnValue(analysisQuery(analysis({ retryAttemptCount: 2 })))

    await expect(retry()).rejects.toMatchObject({
      code: 'HIRE_MULTIMODAL_ANALYSIS_NOT_RETRYABLE',
      statusCode: 409,
    })
    expect(mocks.analysisUpdateOne).not.toHaveBeenCalled()
    expect(mocks.send).not.toHaveBeenCalled()
  })

  it('cannot requeue a failed revision after a newer round analysis exists', async () => {
    mocks.analysisFindOne
      .mockReturnValueOnce(analysisQuery(analysis()))
      .mockReturnValueOnce(analysisQuery({ _id: 'a'.repeat(24) }))

    await expect(retry()).rejects.toMatchObject({
      code: 'HIRE_MULTIMODAL_ANALYSIS_NOT_CURRENT',
      statusCode: 409,
    })
    expect(mocks.analysisUpdateOne).not.toHaveBeenCalled()
    expect(mocks.send).not.toHaveBeenCalled()
  })

  it('fails closed for a live privacy request or missing retained landmark asset', async () => {
    mocks.privacyExists.mockReturnValueOnce(sessionQuery(true))
    await expect(retry()).rejects.toMatchObject({
      code: 'HIRE_CANDIDATE_PRIVACY_PENDING',
      statusCode: 410,
    })

    mocks.privacyExists.mockReturnValue(sessionQuery(false))
    mocks.assetExists.mockReturnValue(sessionQuery(false))
    await expect(retry()).rejects.toMatchObject({
      code: 'HIRE_MULTIMODAL_ANALYSIS_INPUT_UNAVAILABLE',
      statusCode: 410,
    })
    expect(mocks.analysisUpdateOne).not.toHaveBeenCalled()
    expect(mocks.send).not.toHaveBeenCalled()
  })

  it('leaves the durable pending row for the hourly sweep when dispatch is unavailable', async () => {
    mocks.send.mockRejectedValueOnce(new Error('inngest unavailable'))

    await expect(retry()).resolves.toEqual({
      outcome: 'requeued',
      dispatch: 'recovery_pending',
    })
    expect(mocks.warn).toHaveBeenCalledTimes(1)
  })
})
