import { beforeEach, describe, expect, it, vi } from 'vitest'
import { NextRequest } from 'next/server'

const mocks = vi.hoisted(() => {
  class JobsAccountInactiveError extends Error {}
  class JobsAccountTransactionsRequiredError extends Error {}

  return {
    userId: '507f1f77bcf86cd799439010',
    sessionId: '507f1f77bcf86cd799439011',
    mongoSession: { id: 'landmarks-transaction' },
    connectDB: vi.fn(),
    isJobsAccountActive: vi.fn(),
    withActiveJobsAccountWrite: vi.fn(),
    JobsAccountInactiveError,
    JobsAccountTransactionsRequiredError,
    isR2Configured: vi.fn(),
    sessionExists: vi.fn(),
    sessionUpdateOne: vi.fn(),
    uploadToR2: vi.fn(),
    deleteFromR2: vi.fn(),
    loggerInfo: vi.fn(),
    loggerWarn: vi.fn(),
  }
})

vi.mock('@shared/middleware/composeApiRoute', () => ({
  composeApiRoute: (options: {
    handler: (
      req: NextRequest,
      context: {
        user: { id: string }
        body: { sessionId: string; frames: unknown[] }
        params: Record<string, string>
      },
    ) => Promise<Response>
  }) => async (req: NextRequest) => options.handler(req, {
    user: { id: mocks.userId },
    body: await req.json(),
    params: {},
  }),
}))

vi.mock('@shared/db/connection', () => ({ connectDB: mocks.connectDB }))
vi.mock('@shared/services/jobsAccountFence', () => ({
  isJobsAccountActive: mocks.isJobsAccountActive,
  withActiveJobsAccountWrite: mocks.withActiveJobsAccountWrite,
  JobsAccountInactiveError: mocks.JobsAccountInactiveError,
  JobsAccountTransactionsRequiredError: mocks.JobsAccountTransactionsRequiredError,
}))
vi.mock('@shared/db/models/InterviewSession', () => ({
  InterviewSession: {
    exists: mocks.sessionExists,
    updateOne: mocks.sessionUpdateOne,
  },
}))
vi.mock('@shared/storage/r2', () => ({
  isR2Configured: mocks.isR2Configured,
  uploadToR2: mocks.uploadToR2,
  deleteFromR2: mocks.deleteFromR2,
}))
vi.mock('@shared/logger', () => ({
  aiLogger: {
    info: mocks.loggerInfo,
    warn: mocks.loggerWarn,
  },
}))

import { POST } from '../route'

const frames = [{ timestamp: 1, faceDetected: true }]
const key = `landmarks/${mocks.userId}/${mocks.sessionId}.json`
const DELETE_AUTHORITY = {
  ownerUserId: mocks.userId,
  sessionId: mocks.sessionId,
}

function request(originUserId = mocks.userId): NextRequest {
  return new NextRequest('http://localhost/api/recordings/landmarks', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-origin-user-id': originUserId,
    },
    body: JSON.stringify({ sessionId: mocks.sessionId, frames }),
  })
}

beforeEach(() => {
  vi.clearAllMocks()
  mocks.connectDB.mockResolvedValue(undefined)
  mocks.isJobsAccountActive.mockResolvedValue(true)
  mocks.withActiveJobsAccountWrite.mockImplementation(async (
    _userId: string,
    writer: (session: typeof mocks.mongoSession) => Promise<unknown>,
  ) => writer(mocks.mongoSession))
  mocks.isR2Configured.mockReturnValue(true)
  mocks.sessionExists.mockResolvedValue({ _id: mocks.sessionId })
  mocks.sessionUpdateOne.mockResolvedValue({ matchedCount: 1 })
  mocks.uploadToR2.mockResolvedValue(key)
  mocks.deleteFromR2.mockResolvedValue(undefined)
})

describe('POST /api/recordings/landmarks account-deletion fence', () => {
  it('rejects account-switch artifacts before database or R2 work', async () => {
    const response = await POST(request('507f1f77bcf86cd799439099'))

    expect(response.status).toBe(409)
    await expect(response.json()).resolves.toMatchObject({ code: 'SESSION_CHANGED' })
    expect(mocks.connectDB).not.toHaveBeenCalled()
    expect(mocks.uploadToR2).not.toHaveBeenCalled()
  })

  it('returns exact account-unavailable before session or R2 work', async () => {
    mocks.isJobsAccountActive.mockResolvedValueOnce(false)

    const response = await POST(request())

    expect(response.status).toBe(401)
    await expect(response.json()).resolves.toEqual({
      error: 'account unavailable',
      code: 'ACCOUNT_UNAVAILABLE',
    })
    expect(mocks.sessionExists).not.toHaveBeenCalled()
    expect(mocks.uploadToR2).not.toHaveBeenCalled()
  })

  it('prefers deletion over forbidden when the owned session is swept during lookup', async () => {
    mocks.sessionExists.mockResolvedValueOnce(null)
    mocks.isJobsAccountActive
      .mockResolvedValueOnce(true)
      .mockResolvedValueOnce(false)

    const response = await POST(request())

    expect(response.status).toBe(401)
    await expect(response.json()).resolves.toMatchObject({ code: 'ACCOUNT_UNAVAILABLE' })
    expect(mocks.uploadToR2).not.toHaveBeenCalled()
  })

  it('prefers deletion when the ownership lookup throws during the session sweep', async () => {
    mocks.sessionExists.mockRejectedValueOnce(new Error('session collection changed'))
    mocks.isJobsAccountActive
      .mockResolvedValueOnce(true)
      .mockResolvedValueOnce(false)

    const response = await POST(request())

    expect(response.status).toBe(401)
    await expect(response.json()).resolves.toMatchObject({ code: 'ACCOUNT_UNAVAILABLE' })
    expect(mocks.uploadToR2).not.toHaveBeenCalled()
    expect(mocks.deleteFromR2).not.toHaveBeenCalled()
  })

  it('deletes the uploaded object when deletion wins before session association', async () => {
    mocks.isJobsAccountActive
      .mockResolvedValueOnce(true)
      .mockResolvedValueOnce(true)
      .mockResolvedValueOnce(false)

    const response = await POST(request())

    expect(response.status).toBe(401)
    await expect(response.json()).resolves.toMatchObject({ code: 'ACCOUNT_UNAVAILABLE' })
    expect(mocks.uploadToR2).toHaveBeenCalledWith(
      key,
      expect.any(Buffer),
      'application/json',
    )
    expect(mocks.deleteFromR2).toHaveBeenCalledWith(key, DELETE_AUTHORITY)
    expect(mocks.sessionUpdateOne).not.toHaveBeenCalled()
  })

  it('compensates when the session disappears after R2 upload', async () => {
    mocks.sessionUpdateOne.mockResolvedValueOnce({ matchedCount: 0 })

    const response = await POST(request())

    expect(response.status).toBe(403)
    expect(mocks.deleteFromR2).toHaveBeenCalledWith(key, DELETE_AUTHORITY)
  })

  it('compensates when deletion wins after the session association', async () => {
    mocks.isJobsAccountActive
      .mockResolvedValueOnce(true)
      .mockResolvedValueOnce(true)
      .mockResolvedValueOnce(true)
      .mockResolvedValueOnce(false)

    const response = await POST(request())

    expect(response.status).toBe(401)
    await expect(response.json()).resolves.toMatchObject({ code: 'ACCOUNT_UNAVAILABLE' })
    expect(mocks.sessionUpdateOne).toHaveBeenCalledWith(
      { _id: mocks.sessionId, userId: mocks.userId },
      { $set: { facialLandmarksR2Key: key } },
      { session: mocks.mongoSession },
    )
    expect(mocks.deleteFromR2).toHaveBeenCalledWith(key, DELETE_AUTHORITY)
  })

  it('rechecks a failed upload and compensates a possible lost-success response', async () => {
    mocks.uploadToR2.mockRejectedValueOnce(new Error('R2 response lost'))
    mocks.isJobsAccountActive
      .mockResolvedValueOnce(true)
      .mockResolvedValueOnce(true)
      .mockResolvedValueOnce(false)

    const response = await POST(request())

    expect(response.status).toBe(401)
    await expect(response.json()).resolves.toMatchObject({ code: 'ACCOUNT_UNAVAILABLE' })
    expect(mocks.deleteFromR2).toHaveBeenCalledWith(key, DELETE_AUTHORITY)
  })

  it('compensates when the transactional association sees an inactive account', async () => {
    mocks.withActiveJobsAccountWrite.mockRejectedValueOnce(
      new mocks.JobsAccountInactiveError('account unavailable'),
    )

    const response = await POST(request())

    expect(response.status).toBe(401)
    await expect(response.json()).resolves.toMatchObject({ code: 'ACCOUNT_UNAVAILABLE' })
    expect(mocks.deleteFromR2).toHaveBeenCalledWith(key, DELETE_AUTHORITY)
    expect(mocks.sessionUpdateOne).not.toHaveBeenCalled()
  })

  it('compensates and reports a transaction prerequisite failure', async () => {
    mocks.withActiveJobsAccountWrite.mockRejectedValueOnce(
      new mocks.JobsAccountTransactionsRequiredError('transactions required'),
    )

    const response = await POST(request())

    expect(response.status).toBe(503)
    await expect(response.json()).resolves.toEqual({
      error: 'Landmarks finalization requires MongoDB transactions',
      code: 'TRANSACTIONS_REQUIRED',
    })
    expect(mocks.deleteFromR2).toHaveBeenCalledWith(key, DELETE_AUTHORITY)
    expect(mocks.sessionUpdateOne).not.toHaveBeenCalled()
  })

  it('associates landmarks while the account remains active', async () => {
    const response = await POST(request())

    expect(response.status).toBe(200)
    await expect(response.json()).resolves.toEqual({
      success: true,
      key,
      frameCount: frames.length,
    })
    expect(mocks.isJobsAccountActive).toHaveBeenCalledTimes(4)
    expect(mocks.withActiveJobsAccountWrite).toHaveBeenCalledWith(
      mocks.userId,
      expect.any(Function),
    )
    expect(mocks.deleteFromR2).not.toHaveBeenCalled()
  })
})
