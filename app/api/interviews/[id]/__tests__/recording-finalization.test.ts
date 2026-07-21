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
    updateSession: vi.fn(),
    associateRecordingArtifact: vi.fn(),
    cleanupSupersededRecordingArtifact: vi.fn(),
    deleteFromR2: vi.fn(),
    loggerWarn: vi.fn(),
    loggerError: vi.fn(),
    MockJobsAccountInactiveError,
    MockJobsAccountTransactionsRequiredError,
    MockRecordingArtifactKeyRejectedError,
    MockRecordingArtifactSessionNotFoundError,
  }
})

vi.mock('next-auth', () => ({ getServerSession: mocks.getServerSession }))
vi.mock('@shared/auth/authOptions', () => ({ authOptions: {} }))
vi.mock('@shared/db/connection', () => ({ connectDB: mocks.connectDB }))
vi.mock('@interview/services/core/interviewService', () => ({
  getSession: vi.fn(),
  updateSession: mocks.updateSession,
}))
vi.mock('@learn/services/xpService', () => ({ awardXp: vi.fn() }))
vi.mock('@learn/services/streakService', () => ({
  recordActivity: vi.fn(),
  updateStreak: vi.fn(),
}))
vi.mock('@learn/services/badgeService', () => ({ checkAndAwardBadges: vi.fn() }))
vi.mock('@shared/services/accountDeletion', () => ({ deleteInterviewSession: vi.fn() }))
vi.mock('@shared/services/usageBuffer', () => ({ flushUsageBuffer: vi.fn() }))
vi.mock('@shared/db/models', () => ({
  InterviewSession: { aggregate: vi.fn() },
}))
vi.mock('@shared/services/jobsAccountFence', () => ({
  activeJobsAccountIds: vi.fn(),
  isJobsAccountActive: mocks.isJobsAccountActive,
  JobsAccountInactiveError: mocks.MockJobsAccountInactiveError,
  JobsAccountTransactionsRequiredError: mocks.MockJobsAccountTransactionsRequiredError,
}))
vi.mock('@shared/storage/r2', () => ({ deleteFromR2: mocks.deleteFromR2 }))
vi.mock('@shared/logger', () => ({
  logger: {
    info: vi.fn(),
    warn: mocks.loggerWarn,
    error: mocks.loggerError,
  },
}))
vi.mock('@interview/services/core/recordingArtifactService', () => ({
  associateRecordingArtifact: mocks.associateRecordingArtifact,
  cleanupSupersededRecordingArtifact: mocks.cleanupSupersededRecordingArtifact,
  RecordingArtifactKeyRejectedError: mocks.MockRecordingArtifactKeyRejectedError,
  RecordingArtifactSessionNotFoundError: mocks.MockRecordingArtifactSessionNotFoundError,
}))

import { PATCH } from '../route'

const CAMERA_KEY = `recordings/${mocks.userId}/${mocks.sessionId}-1700000000000.webm`
const SCREEN_KEY = `recordings/${mocks.userId}/${mocks.sessionId}-screen-1700000000000.webm`
const AUDIO_KEY = `recordings/${mocks.userId}/${mocks.sessionId}-audio-1700000000000.webm`
const DELETE_AUTHORITY = {
  ownerUserId: mocks.userId,
  sessionId: mocks.sessionId,
}

function request(
  body: Record<string, unknown>,
  originUserId?: string,
) {
  return new NextRequest(`http://localhost/api/interviews/${mocks.sessionId}`, {
    method: 'PATCH',
    headers: {
      'content-type': 'application/json',
      ...(originUserId !== undefined ? { 'x-origin-user-id': originUserId } : {}),
    },
    body: JSON.stringify(body),
  })
}

function callPatch(body: Record<string, unknown>, originUserId?: string) {
  return PATCH(request(body, originUserId), { params: { id: mocks.sessionId } })
}

beforeEach(() => {
  vi.clearAllMocks()
  mocks.getServerSession.mockResolvedValue({
    user: { id: mocks.userId, role: 'candidate' },
  })
  mocks.connectDB.mockResolvedValue(undefined)
  mocks.isJobsAccountActive.mockResolvedValue(true)
  mocks.associateRecordingArtifact.mockResolvedValue({
    accepted: true,
    previousKey: undefined,
  })
  mocks.cleanupSupersededRecordingArtifact.mockResolvedValue(undefined)
  mocks.deleteFromR2.mockResolvedValue(undefined)
  mocks.updateSession.mockResolvedValue({
    updated: { _id: { toString: () => mocks.sessionId } },
    priorStatus: 'in_progress',
  })
})

describe('PATCH /api/interviews/[id] legacy recording finalization', () => {
  it.each([
    [
      'camera',
      { recordingR2Key: CAMERA_KEY, recordingSizeBytes: 4_096, recordingDurationSeconds: 73 },
      { type: 'recording', key: CAMERA_KEY, sizeBytes: 4_096, durationSeconds: 73 },
    ],
    [
      'screen',
      { screenRecordingR2Key: SCREEN_KEY, screenRecordingSizeBytes: 2_048 },
      { type: 'screen-recording', key: SCREEN_KEY, sizeBytes: 2_048 },
    ],
    [
      'audio',
      { audioRecordingR2Key: AUDIO_KEY, audioRecordingSizeBytes: 1_024 },
      { type: 'audio-recording', key: AUDIO_KEY, sizeBytes: 1_024 },
    ],
  ] as const)('intercepts an artifact-only %s patch before the generic updater', async (
    _label,
    body,
    expectedArtifact,
  ) => {
    const response = await callPatch(body, mocks.userId)

    expect(response.status).toBe(200)
    await expect(response.json()).resolves.toEqual({
      success: true,
      sessionId: mocks.sessionId,
    })
    expect(mocks.associateRecordingArtifact).toHaveBeenCalledWith({
      userId: mocks.userId,
      sessionId: mocks.sessionId,
      ...expectedArtifact,
    })
    expect(mocks.updateSession).not.toHaveBeenCalled()
  })

  it('leaves ordinary non-artifact updates on the existing generic path', async () => {
    const response = await callPatch({ durationActualSeconds: 75 })

    expect(response.status).toBe(200)
    expect(mocks.updateSession).toHaveBeenCalledWith(
      mocks.sessionId,
      mocks.userId,
      'candidate',
      undefined,
      { durationActualSeconds: 75 },
    )
    expect(mocks.associateRecordingArtifact).not.toHaveBeenCalled()
  })

  it.each([
    [
      'artifact plus a generic session mutation',
      { recordingR2Key: CAMERA_KEY, recordingSizeBytes: 100, status: 'completed' },
    ],
    [
      'multiple artifacts',
      {
        recordingR2Key: CAMERA_KEY,
        recordingSizeBytes: 100,
        audioRecordingR2Key: AUDIO_KEY,
        audioRecordingSizeBytes: 50,
      },
    ],
    ['key without size', { recordingR2Key: CAMERA_KEY }],
    [
      'screen artifact with camera duration',
      {
        screenRecordingR2Key: SCREEN_KEY,
        screenRecordingSizeBytes: 100,
        recordingDurationSeconds: 10,
      },
    ],
  ])('rejects %s instead of exposing storage fields to the generic updater', async (_label, body) => {
    const response = await callPatch(body as Record<string, unknown>)

    expect(response.status).toBe(400)
    await expect(response.json()).resolves.toEqual({
      error: 'Recording artifacts must be finalized separately',
    })
    expect(mocks.associateRecordingArtifact).not.toHaveBeenCalled()
    expect(mocks.updateSession).not.toHaveBeenCalled()
  })

  it('rejects an account switch before parsing or association', async () => {
    const response = await callPatch(
      { recordingR2Key: CAMERA_KEY, recordingSizeBytes: 100 },
      mocks.foreignUserId,
    )

    expect(response.status).toBe(409)
    await expect(response.json()).resolves.toEqual({
      error: 'sign-in session changed',
      code: 'SESSION_CHANGED',
    })
    expect(mocks.connectDB).not.toHaveBeenCalled()
    expect(mocks.associateRecordingArtifact).not.toHaveBeenCalled()
  })

  it.each([
    ['arbitrary', `recordings/${mocks.userId}/not-a-recording.webm`],
    [
      'foreign-user',
      `recordings/${mocks.foreignUserId}/${mocks.sessionId}-1700000000000.webm`,
    ],
    [
      'wrong-session',
      `recordings/${mocks.userId}/507f1f77bcf86cd799439099-1700000000000.webm`,
    ],
  ])('returns 403 without deleting a potentially unrelated %s key', async (_label, key) => {
    mocks.associateRecordingArtifact.mockRejectedValueOnce(
      new mocks.MockRecordingArtifactKeyRejectedError(),
    )

    const response = await callPatch({ recordingR2Key: key, recordingSizeBytes: 100 })

    expect(response.status).toBe(403)
    await expect(response.json()).resolves.toEqual({ error: 'Forbidden' })
    expect(mocks.deleteFromR2).not.toHaveBeenCalled()
    expect(mocks.updateSession).not.toHaveBeenCalled()
  })

  it('compensates with exact account-unavailable when deletion wins association', async () => {
    mocks.associateRecordingArtifact.mockRejectedValueOnce(
      new mocks.MockJobsAccountInactiveError(),
    )

    const response = await callPatch({ recordingR2Key: CAMERA_KEY, recordingSizeBytes: 100 })

    expect(response.status).toBe(401)
    await expect(response.json()).resolves.toEqual({
      error: 'account unavailable',
      code: 'ACCOUNT_UNAVAILABLE',
    })
    expect(mocks.deleteFromR2).toHaveBeenCalledWith(CAMERA_KEY, DELETE_AUTHORITY)
  })

  it('compensates with transactions-required when Mongo cannot provide the fence', async () => {
    mocks.associateRecordingArtifact.mockRejectedValueOnce(
      new mocks.MockJobsAccountTransactionsRequiredError(),
    )

    const response = await callPatch({ recordingR2Key: CAMERA_KEY, recordingSizeBytes: 100 })

    expect(response.status).toBe(503)
    await expect(response.json()).resolves.toEqual({
      error: 'Recording finalization requires MongoDB transactions',
      code: 'TRANSACTIONS_REQUIRED',
    })
    expect(mocks.deleteFromR2).toHaveBeenCalledWith(CAMERA_KEY, DELETE_AUTHORITY)
  })

  it('compensates with 404 when the owned interview session is missing', async () => {
    mocks.associateRecordingArtifact.mockRejectedValueOnce(
      new mocks.MockRecordingArtifactSessionNotFoundError(),
    )

    const response = await callPatch({ recordingR2Key: CAMERA_KEY, recordingSizeBytes: 100 })

    expect(response.status).toBe(404)
    await expect(response.json()).resolves.toEqual({ error: 'Interview session not found' })
    expect(mocks.deleteFromR2).toHaveBeenCalledWith(CAMERA_KEY, DELETE_AUTHORITY)
  })

  it('prefers account-unavailable when deletion swept the missing session', async () => {
    mocks.associateRecordingArtifact.mockRejectedValueOnce(
      new mocks.MockRecordingArtifactSessionNotFoundError(),
    )
    mocks.isJobsAccountActive
      .mockResolvedValueOnce(true)
      .mockResolvedValueOnce(false)

    const response = await callPatch({ recordingR2Key: CAMERA_KEY, recordingSizeBytes: 100 })

    expect(response.status).toBe(401)
    await expect(response.json()).resolves.toMatchObject({ code: 'ACCOUNT_UNAVAILABLE' })
    expect(mocks.deleteFromR2).toHaveBeenCalledWith(CAMERA_KEY, DELETE_AUTHORITY)
  })

  it('deletes a delayed older artifact and reports it as superseded', async () => {
    mocks.associateRecordingArtifact.mockResolvedValueOnce({
      accepted: false,
      previousKey: undefined,
    })

    const response = await callPatch({ recordingR2Key: CAMERA_KEY, recordingSizeBytes: 100 })

    expect(response.status).toBe(200)
    await expect(response.json()).resolves.toEqual({
      success: true,
      sessionId: mocks.sessionId,
      superseded: true,
    })
    expect(mocks.deleteFromR2).toHaveBeenCalledWith(CAMERA_KEY, DELETE_AUTHORITY)
    expect(mocks.cleanupSupersededRecordingArtifact).not.toHaveBeenCalled()
  })

  it('compensates when deletion starts after transactional association', async () => {
    mocks.isJobsAccountActive
      .mockResolvedValueOnce(true)
      .mockResolvedValueOnce(false)

    const response = await callPatch({ recordingR2Key: CAMERA_KEY, recordingSizeBytes: 100 })

    expect(response.status).toBe(401)
    await expect(response.json()).resolves.toMatchObject({ code: 'ACCOUNT_UNAVAILABLE' })
    expect(mocks.deleteFromR2).toHaveBeenCalledWith(CAMERA_KEY, DELETE_AUTHORITY)
  })

  it('never lets an empty storage key bypass the artifact-only interceptor', async () => {
    const response = await callPatch({ recordingR2Key: '', recordingSizeBytes: 100 })

    expect(response.status).toBe(400)
    await expect(response.json()).resolves.toEqual({
      error: 'Recording artifacts must be finalized separately',
    })
    expect(mocks.associateRecordingArtifact).not.toHaveBeenCalled()
    expect(mocks.updateSession).not.toHaveBeenCalled()
  })

  it.each([
    ['camera', { recordingSizeBytes: 100 }],
    ['screen', { screenRecordingSizeBytes: 100 }],
    ['audio', { audioRecordingSizeBytes: 100 }],
  ])('never lets %s metadata without a key reach the generic updater', async (_label, body) => {
    const response = await callPatch(body)

    expect(response.status).toBe(400)
    await expect(response.json()).resolves.toEqual({
      error: 'Recording artifacts must be finalized separately',
    })
    expect(mocks.associateRecordingArtifact).not.toHaveBeenCalled()
    expect(mocks.updateSession).not.toHaveBeenCalled()
  })
})
