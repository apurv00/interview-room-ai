import { beforeEach, describe, expect, it, vi } from 'vitest'
import { NextRequest } from 'next/server'

const mocks = vi.hoisted(() => {
  class MockJobsAccountInactiveError extends Error {}
  class MockJobsAccountTransactionsRequiredError extends Error {}
  class MockRecordingArtifactKeyRejectedError extends Error {}
  class MockRecordingArtifactSessionNotFoundError extends Error {}
  return {
    userId: '507f1f77bcf86cd799439010',
    foreignUserId: '507f1f77bcf86cd799439011',
    sessionId: '507f1f77bcf86cd799439012',
    getServerSession: vi.fn(),
    connectDB: vi.fn(),
    isJobsAccountActive: vi.fn(),
    deleteFromR2: vi.fn(),
    associateRecordingArtifact: vi.fn(),
    cleanupSupersededRecordingArtifact: vi.fn(),
    loggerWarn: vi.fn(),
    loggerError: vi.fn(),
    MockJobsAccountInactiveError,
    MockJobsAccountTransactionsRequiredError,
    MockRecordingArtifactKeyRejectedError,
    MockRecordingArtifactSessionNotFoundError,
  }
})

vi.mock('next-auth', () => ({
  getServerSession: mocks.getServerSession,
}))

vi.mock('@shared/auth/authOptions', () => ({ authOptions: {} }))
vi.mock('@shared/db/connection', () => ({ connectDB: mocks.connectDB }))
vi.mock('@shared/services/jobsAccountFence', () => ({
  isJobsAccountActive: mocks.isJobsAccountActive,
  JobsAccountInactiveError: mocks.MockJobsAccountInactiveError,
  JobsAccountTransactionsRequiredError: mocks.MockJobsAccountTransactionsRequiredError,
}))
vi.mock('@shared/storage/r2', () => ({ deleteFromR2: mocks.deleteFromR2 }))
vi.mock('@shared/logger', () => ({
  aiLogger: { warn: mocks.loggerWarn, error: mocks.loggerError },
}))
vi.mock('@interview/services/core/recordingArtifactService', () => ({
  associateRecordingArtifact: mocks.associateRecordingArtifact,
  cleanupSupersededRecordingArtifact: mocks.cleanupSupersededRecordingArtifact,
  RecordingArtifactKeyRejectedError: mocks.MockRecordingArtifactKeyRejectedError,
  RecordingArtifactSessionNotFoundError: mocks.MockRecordingArtifactSessionNotFoundError,
}))

import { POST } from '../route'

const CAMERA_KEY = `recordings/${mocks.userId}/${mocks.sessionId}-1700000000000.webm`
const FOREIGN_KEY = `recordings/${mocks.foreignUserId}/${mocks.sessionId}-1700000000000.webm`
const DELETE_AUTHORITY = {
  ownerUserId: mocks.userId,
  sessionId: mocks.sessionId,
}

function request(
  body: Record<string, unknown> = {
    type: 'recording',
    sessionId: mocks.sessionId,
    key: CAMERA_KEY,
    sizeBytes: 1_024,
    durationSeconds: 42,
  },
  originUserId: string | null = mocks.userId,
) {
  return new NextRequest('http://localhost/api/recordings/finalize', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      ...(originUserId !== null ? { 'x-origin-user-id': originUserId } : {}),
    },
    body: JSON.stringify(body),
  })
}

beforeEach(() => {
  vi.clearAllMocks()
  mocks.getServerSession.mockResolvedValue({ user: { id: mocks.userId } })
  mocks.connectDB.mockResolvedValue(undefined)
  mocks.isJobsAccountActive.mockResolvedValue(true)
  mocks.associateRecordingArtifact.mockResolvedValue({
    accepted: true,
    previousKey: undefined,
  })
  mocks.cleanupSupersededRecordingArtifact.mockResolvedValue(undefined)
  mocks.deleteFromR2.mockResolvedValue(undefined)
})

describe('POST /api/recordings/finalize', () => {
  it('rejects a stale or missing origin identity before database work', async () => {
    for (const originUserId of [mocks.foreignUserId, null]) {
      vi.clearAllMocks()
      mocks.getServerSession.mockResolvedValue({ user: { id: mocks.userId } })

      const response = await POST(request(undefined, originUserId))

      expect(response.status).toBe(409)
      await expect(response.json()).resolves.toEqual({
        error: 'sign-in session changed',
        code: 'SESSION_CHANGED',
      })
      expect(mocks.connectDB).not.toHaveBeenCalled()
      expect(mocks.associateRecordingArtifact).not.toHaveBeenCalled()
    }
  })

  it('associates an owned canonical artifact and returns private no-store output', async () => {
    const previousKey = `recordings/${mocks.userId}/${mocks.sessionId}-1699999999999.webm`
    mocks.associateRecordingArtifact.mockResolvedValueOnce({
      accepted: true,
      previousKey,
    })

    const response = await POST(request())

    expect(response.status).toBe(200)
    await expect(response.json()).resolves.toEqual({ success: true })
    expect(response.headers.get('cache-control')).toBe('private, no-store')
    expect(mocks.associateRecordingArtifact).toHaveBeenCalledWith({
      userId: mocks.userId,
      type: 'recording',
      sessionId: mocks.sessionId,
      key: CAMERA_KEY,
      sizeBytes: 1_024,
      durationSeconds: 42,
    })
    expect(mocks.cleanupSupersededRecordingArtifact).toHaveBeenCalledWith(
      previousKey,
      CAMERA_KEY,
      mocks.userId,
      mocks.sessionId,
    )
    expect(mocks.deleteFromR2).not.toHaveBeenCalled()
  })

  it('returns exact account-unavailable before parsing or association', async () => {
    mocks.isJobsAccountActive.mockResolvedValueOnce(false)

    const response = await POST(request())

    expect(response.status).toBe(401)
    await expect(response.json()).resolves.toEqual({
      error: 'account unavailable',
      code: 'ACCOUNT_UNAVAILABLE',
    })
    expect(mocks.associateRecordingArtifact).not.toHaveBeenCalled()
    expect(mocks.deleteFromR2).not.toHaveBeenCalled()
  })

  it.each([
    ['arbitrary', `recordings/${mocks.userId}/not-a-recording.webm`],
    ['foreign-user', FOREIGN_KEY],
    ['wrong-session', `recordings/${mocks.userId}/507f1f77bcf86cd799439099-1700000000000.webm`],
  ])('returns 403 without deleting a potentially unrelated %s key', async (_label, key) => {
    mocks.associateRecordingArtifact.mockRejectedValueOnce(
      new mocks.MockRecordingArtifactKeyRejectedError(),
    )

    const response = await POST(request({
      type: 'recording',
      sessionId: mocks.sessionId,
      key,
      sizeBytes: 1_024,
    }))

    expect(response.status).toBe(403)
    await expect(response.json()).resolves.toEqual({ error: 'Forbidden' })
    expect(mocks.deleteFromR2).not.toHaveBeenCalled()
  })

  it('deletes the uploaded object when deletion wins the association transaction', async () => {
    mocks.associateRecordingArtifact.mockRejectedValueOnce(
      new mocks.MockJobsAccountInactiveError(),
    )

    const response = await POST(request())

    expect(response.status).toBe(401)
    await expect(response.json()).resolves.toEqual({
      error: 'account unavailable',
      code: 'ACCOUNT_UNAVAILABLE',
    })
    expect(mocks.deleteFromR2).toHaveBeenCalledWith(CAMERA_KEY, DELETE_AUTHORITY)
  })

  it('returns transactions-required and compensates the uploaded object', async () => {
    mocks.associateRecordingArtifact.mockRejectedValueOnce(
      new mocks.MockJobsAccountTransactionsRequiredError(),
    )

    const response = await POST(request())

    expect(response.status).toBe(503)
    await expect(response.json()).resolves.toEqual({
      error: 'Recording finalization requires MongoDB transactions',
      code: 'TRANSACTIONS_REQUIRED',
    })
    expect(mocks.deleteFromR2).toHaveBeenCalledWith(CAMERA_KEY, DELETE_AUTHORITY)
  })

  it('returns 404 and compensates when the owned session is missing', async () => {
    mocks.associateRecordingArtifact.mockRejectedValueOnce(
      new mocks.MockRecordingArtifactSessionNotFoundError(),
    )

    const response = await POST(request())

    expect(response.status).toBe(404)
    await expect(response.json()).resolves.toEqual({
      error: 'Interview session not found',
    })
    expect(mocks.deleteFromR2).toHaveBeenCalledWith(CAMERA_KEY, DELETE_AUTHORITY)
  })

  it('prefers exact account-unavailable and compensates when deletion swept the session', async () => {
    mocks.associateRecordingArtifact.mockRejectedValueOnce(
      new mocks.MockRecordingArtifactSessionNotFoundError(),
    )
    mocks.isJobsAccountActive
      .mockResolvedValueOnce(true)
      .mockResolvedValueOnce(false)

    const response = await POST(request())

    expect(response.status).toBe(401)
    await expect(response.json()).resolves.toMatchObject({ code: 'ACCOUNT_UNAVAILABLE' })
    expect(mocks.deleteFromR2).toHaveBeenCalledWith(CAMERA_KEY, DELETE_AUTHORITY)
  })

  it('deletes a delayed older object without replacing the newer association', async () => {
    mocks.associateRecordingArtifact.mockResolvedValueOnce({
      accepted: false,
      previousKey: undefined,
    })

    const response = await POST(request())

    expect(response.status).toBe(200)
    await expect(response.json()).resolves.toEqual({
      success: true,
      superseded: true,
    })
    expect(mocks.deleteFromR2).toHaveBeenCalledWith(CAMERA_KEY, DELETE_AUTHORITY)
    expect(mocks.cleanupSupersededRecordingArtifact).not.toHaveBeenCalled()
  })

  it('compensates when deletion starts after transactional association', async () => {
    mocks.isJobsAccountActive
      .mockResolvedValueOnce(true)
      .mockResolvedValueOnce(false)

    const response = await POST(request())

    expect(response.status).toBe(401)
    await expect(response.json()).resolves.toMatchObject({ code: 'ACCOUNT_UNAVAILABLE' })
    expect(mocks.cleanupSupersededRecordingArtifact).toHaveBeenCalledTimes(1)
    expect(mocks.deleteFromR2).toHaveBeenCalledWith(CAMERA_KEY, DELETE_AUTHORITY)
  })

  it('keeps the exact terminal response when compensation itself fails', async () => {
    const deleteError = new Error('R2 unavailable')
    mocks.associateRecordingArtifact.mockRejectedValueOnce(
      new mocks.MockJobsAccountTransactionsRequiredError(),
    )
    mocks.deleteFromR2.mockRejectedValueOnce(deleteError)

    const response = await POST(request())

    expect(response.status).toBe(503)
    await expect(response.json()).resolves.toMatchObject({ code: 'TRANSACTIONS_REQUIRED' })
    expect(mocks.loggerWarn).toHaveBeenCalledWith(
      { error: deleteError, key: CAMERA_KEY },
      'Recording finalization compensation failed',
    )
  })
})
