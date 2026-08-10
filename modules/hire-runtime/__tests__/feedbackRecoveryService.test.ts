import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  connect: vi.fn(),
  bindingFind: vi.fn(),
  bindingDistinct: vi.fn(),
  bindingClaim: vi.fn(),
  bindingUpdate: vi.fn(),
  sessionFindOne: vi.fn(),
  sessionExists: vi.fn(),
  encode: vi.fn(),
  fetch: vi.fn(),
}))

vi.mock('../models/HireRuntimeBinding', () => ({
  HireRuntimeBinding: {
    find: mocks.bindingFind,
    distinct: mocks.bindingDistinct,
    findOneAndUpdate: mocks.bindingClaim,
    updateOne: mocks.bindingUpdate,
  },
}))
vi.mock('@shared/db/models/InterviewSession', () => ({
  InterviewSession: {
    findOne: mocks.sessionFindOne,
    exists: mocks.sessionExists,
  },
}))
vi.mock('../services/runtimeBoundary', () => ({
  connectHireRuntimeDB: mocks.connect,
}))
vi.mock('next-auth/jwt', () => ({ encode: mocks.encode }))

import { recoverMissingRuntimeFeedback } from '../services/feedbackRecoveryService'

const PRINCIPAL_ID = 'a'.repeat(24)
const SESSION_ID = 'b'.repeat(24)
const ROUND_ID = 'c'.repeat(24)
const BINDING_ID = 'd'.repeat(24)
const WORKSPACE_ID = 'e'.repeat(24)

function objectId(value: string) {
  return { toString: () => value }
}

const candidate = {
  _id: objectId(BINDING_ID),
  workspaceId: objectId(WORKSPACE_ID),
  principalId: objectId(PRINCIPAL_ID),
  runtimeSessionId: objectId(SESSION_ID),
  roundId: objectId(ROUND_ID),
  status: 'active',
  feedbackRecoveryAttemptCount: 0,
}

const completedSession = {
  _id: objectId(SESSION_ID),
  userId: objectId(PRINCIPAL_ID),
  status: 'completed',
  config: {
    role: 'Backend engineer',
    interviewType: 'behavioral',
    experience: '3-6',
    duration: 20,
  },
  jobDescription: 'Build reliable APIs.',
  transcript: [],
  evaluations: [],
  speechMetrics: [],
  plannedQuestionCount: 5,
  answeredCount: 0,
  endReason: 'user_ended',
}

function bindingQuery(values: unknown[]) {
  return { sort: () => ({ limit: async () => values }) }
}

function sessionQuery(value: unknown) {
  return { select: () => ({ lean: async () => value }) }
}

beforeEach(() => {
  vi.clearAllMocks()
  vi.stubEnv('NODE_ENV', 'production')
  vi.stubEnv('NEXTAUTH_URL', 'https://engine.interviewprep.guru')
  vi.stubEnv(
    'HIRE_RUNTIME_NEXTAUTH_SECRET',
    'runtime-secret-at-least-32-characters',
  )
  mocks.connect.mockResolvedValue(undefined)
  mocks.bindingDistinct.mockResolvedValue([WORKSPACE_ID])
  mocks.bindingFind.mockReturnValue(bindingQuery([candidate]))
  mocks.bindingClaim.mockResolvedValue(candidate)
  mocks.bindingUpdate.mockResolvedValue({
    acknowledged: true,
    matchedCount: 1,
  })
  mocks.sessionFindOne.mockReturnValue(sessionQuery(completedSession))
  mocks.sessionExists.mockResolvedValue({ _id: SESSION_ID })
  mocks.encode.mockResolvedValue('runtime-jwt')
  mocks.fetch.mockResolvedValue(new Response('{}', { status: 200 }))
  vi.stubGlobal('fetch', mocks.fetch)
})

afterEach(() => {
  vi.unstubAllEnvs()
  vi.unstubAllGlobals()
})

describe('durable runtime base-feedback recovery', () => {
  it('reconstructs the persisted engine payload and authenticates through the host write fence', async () => {
    await expect(recoverMissingRuntimeFeedback(1)).resolves.toEqual({
      scanned: 1,
      recovered: 1,
      skipped: 0,
      failed: 0,
    })
    const [url, request] = mocks.fetch.mock.calls[0]
    expect(String(url)).toBe(
      'https://engine.interviewprep.guru/api/hire-engine/write-fence?__runtime_target=%2Fapi%2Fgenerate-feedback',
    )
    expect(request.headers.Cookie).toBe('__Secure-ipg-hire-runtime=runtime-jwt')
    expect(mocks.encode).toHaveBeenCalledWith(
      expect.objectContaining({
        secret: 'runtime-secret-at-least-32-characters',
        token: expect.objectContaining({
          sub: PRINCIPAL_ID,
          userId: PRINCIPAL_ID,
          organizationId: WORKSPACE_ID,
        }),
      }),
    )
    expect(JSON.parse(request.body)).toMatchObject({
      sessionId: SESSION_ID,
      config: {
        role: 'Backend engineer',
        jobDescription: 'Build reliable APIs.',
      },
      plannedQuestionCount: 5,
      answeredCount: 0,
      endReason: 'user_ended',
    })
  })

  it('durably releases a crashed attempt with backoff and succeeds on the next cron retry', async () => {
    mocks.fetch.mockRejectedValueOnce(new Error('connection reset'))
    await expect(recoverMissingRuntimeFeedback(1)).resolves.toEqual({
      scanned: 1,
      recovered: 0,
      skipped: 0,
      failed: 1,
    })
    expect(mocks.bindingUpdate.mock.calls.at(-1)?.[1]).toMatchObject({
      $set: {
        feedbackRecoveryAttemptCount: 1,
        feedbackRecoveryFailureCode: 'RUNTIME_FEEDBACK_RECOVERY_FAILED',
      },
      $unset: {
        feedbackRecoveryLeaseToken: 1,
        feedbackRecoveryLeaseExpiresAt: 1,
      },
    })

    mocks.fetch.mockResolvedValueOnce(new Response('{}', { status: 200 }))
    await expect(recoverMissingRuntimeFeedback(1)).resolves.toMatchObject({
      recovered: 1,
      failed: 0,
    })
    expect(mocks.fetch).toHaveBeenCalledTimes(2)
  })

  it('does not claim revoked/privacy bindings in the recovery scan', async () => {
    mocks.bindingFind.mockReturnValue(bindingQuery([]))
    await expect(recoverMissingRuntimeFeedback()).resolves.toEqual({
      scanned: 0,
      recovered: 0,
      skipped: 0,
      failed: 0,
    })
    expect(mocks.bindingFind).toHaveBeenCalledWith(
      expect.objectContaining({
        status: 'active',
        purgePersonalData: { $ne: true },
      }),
    )
    expect(mocks.fetch).not.toHaveBeenCalled()
  })
})
