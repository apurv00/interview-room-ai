import { beforeEach, describe, expect, it, vi } from 'vitest'
import { NextRequest } from 'next/server'

const mocks = vi.hoisted(() => ({
  getServerSession: vi.fn(),
  connectDB: vi.fn(),
  isJobsAccountActive: vi.fn(),
  sessionExists: vi.fn(),
  userExists: vi.fn(),
  getUploadPresignedUrl: vi.fn(),
  getDownloadPresignedUrl: vi.fn(),
  recordingKey: vi.fn(),
  screenRecordingKey: vi.fn(),
  audioRecordingKey: vi.fn(),
  documentKey: vi.fn(),
  isR2Configured: vi.fn(),
}))

vi.mock('next-auth', () => ({ getServerSession: mocks.getServerSession }))
vi.mock('@shared/auth/authOptions', () => ({ authOptions: {} }))
vi.mock('@shared/db/connection', () => ({ connectDB: mocks.connectDB }))
vi.mock('@shared/services/jobsAccountFence', () => ({
  isJobsAccountActive: mocks.isJobsAccountActive,
}))
vi.mock('@shared/db/models/InterviewSession', () => ({
  InterviewSession: { exists: mocks.sessionExists },
}))
vi.mock('@shared/db/models/User', () => ({
  User: { exists: mocks.userExists },
}))
vi.mock('@shared/storage/r2', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@shared/storage/r2')>()
  return {
    ...actual,
    getUploadPresignedUrl: mocks.getUploadPresignedUrl,
    getDownloadPresignedUrl: mocks.getDownloadPresignedUrl,
    recordingKey: mocks.recordingKey,
    screenRecordingKey: mocks.screenRecordingKey,
    audioRecordingKey: mocks.audioRecordingKey,
    documentKey: mocks.documentKey,
    isR2Configured: mocks.isR2Configured,
  }
})

import { POST } from '../route'

const USER_ID = '507f1f77bcf86cd799439010'
const FOREIGN_USER_ID = '507f1f77bcf86cd799439099'
const SESSION_ID = '507f1f77bcf86cd799439011'
const OTHER_SESSION_ID = '507f1f77bcf86cd799439012'
const TIMESTAMP = '1721500000000'
const RECORDING_KEY = `recordings/${USER_ID}/${SESSION_ID}-${TIMESTAMP}.webm`
const SCREEN_RECORDING_KEY = `recordings/${USER_ID}/${SESSION_ID}-screen-${TIMESTAMP}.webm`
const AUDIO_RECORDING_KEY = `recordings/${USER_ID}/${SESSION_ID}-audio-${TIMESTAMP}.webm`
const DOCUMENT_KEY = `documents/${USER_ID}/resume/${TIMESTAMP}-cv.pdf`

function request(
  body: Record<string, unknown>,
  originUserId?: string,
): NextRequest {
  return new NextRequest('http://localhost/api/storage/presign', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      ...(originUserId !== undefined ? { 'x-origin-user-id': originUserId } : {}),
    },
    body: JSON.stringify(body),
  })
}

beforeEach(() => {
  vi.clearAllMocks()
  mocks.getServerSession.mockResolvedValue({ user: { id: USER_ID } })
  mocks.connectDB.mockResolvedValue(undefined)
  mocks.isJobsAccountActive.mockResolvedValue(true)
  mocks.sessionExists.mockResolvedValue({ _id: SESSION_ID })
  mocks.userExists.mockResolvedValue(null)
  mocks.getUploadPresignedUrl.mockResolvedValue('https://r2.example/upload')
  mocks.getDownloadPresignedUrl.mockResolvedValue('https://r2.example/download')
  mocks.recordingKey.mockReturnValue(RECORDING_KEY)
  mocks.screenRecordingKey.mockReturnValue(SCREEN_RECORDING_KEY)
  mocks.audioRecordingKey.mockReturnValue(AUDIO_RECORDING_KEY)
  mocks.documentKey.mockReturnValue(DOCUMENT_KEY)
  mocks.isR2Configured.mockReturnValue(true)
})

describe('POST /api/storage/presign account and key fences', () => {
  it('rejects a request from a different originating sign-in before DB or signing work', async () => {
    const response = await POST(request(
      { action: 'upload', type: 'document', docType: 'resume', fileName: 'cv.pdf' },
      FOREIGN_USER_ID,
    ))

    expect(response.status).toBe(409)
    await expect(response.json()).resolves.toEqual({
      error: 'sign-in session changed',
      code: 'SESSION_CHANGED',
    })
    expect(mocks.connectDB).not.toHaveBeenCalled()
    expect(mocks.getUploadPresignedUrl).not.toHaveBeenCalled()
  })

  it('rejects an inactive account before configuration, ownership, or signing work', async () => {
    mocks.isJobsAccountActive.mockResolvedValueOnce(false)

    const response = await POST(request({
      action: 'upload',
      type: 'recording',
      sessionId: SESSION_ID,
    }))

    expect(response.status).toBe(401)
    await expect(response.json()).resolves.toEqual({
      error: 'account unavailable',
      code: 'ACCOUNT_UNAVAILABLE',
    })
    expect(mocks.isR2Configured).not.toHaveBeenCalled()
    expect(mocks.sessionExists).not.toHaveBeenCalled()
    expect(mocks.getUploadPresignedUrl).not.toHaveBeenCalled()
  })

  it('does not sign from an ownership result captured while deletion commits', async () => {
    mocks.isJobsAccountActive
      .mockResolvedValueOnce(true)
      .mockResolvedValueOnce(false)

    const response = await POST(request({
      action: 'upload',
      type: 'recording',
      sessionId: SESSION_ID,
    }))

    expect(response.status).toBe(401)
    await expect(response.json()).resolves.toEqual({
      error: 'account unavailable',
      code: 'ACCOUNT_UNAVAILABLE',
    })
    expect(mocks.sessionExists).toHaveBeenCalledWith({ _id: SESSION_ID, userId: USER_ID })
    expect(mocks.getUploadPresignedUrl).not.toHaveBeenCalled()
  })

  it('rejects document uploads without minting a storage capability', async () => {
    const response = await POST(request({
      action: 'upload',
      type: 'document',
      docType: 'resume',
      fileName: 'cv.pdf',
    }))

    expect(response.status).toBe(410)
    await expect(response.json()).resolves.toEqual({
      error: 'Document originals are no longer retained',
      code: 'DOCUMENT_STORAGE_DISABLED',
    })
    expect(mocks.getUploadPresignedUrl).not.toHaveBeenCalled()
    expect(mocks.isJobsAccountActive).toHaveBeenCalledTimes(1)
  })

  it.each([
    ['literal traversal', `recordings/${USER_ID}/${SESSION_ID}-${TIMESTAMP}.webm/../secret`],
    ['encoded traversal', `recordings/${USER_ID}/%2e%2e/${SESSION_ID}-${TIMESTAMP}.webm`],
    ['double-encoded traversal', `recordings/${USER_ID}/%252e%252e/${SESSION_ID}-${TIMESTAMP}.webm`],
  ])('rejects a %s download key before reference or signing work', async (_label, key) => {
    const response = await POST(request({ action: 'download', key }))

    expect(response.status).toBe(403)
    await expect(response.json()).resolves.toEqual({ error: 'Forbidden' })
    expect(mocks.sessionExists).not.toHaveBeenCalled()
    expect(mocks.userExists).not.toHaveBeenCalled()
    expect(mocks.getDownloadPresignedUrl).not.toHaveBeenCalled()
  })

  it('rejects a syntactically canonical key for a foreign account', async () => {
    const key = `documents/${FOREIGN_USER_ID}/resume/${TIMESTAMP}-cv.pdf`

    const response = await POST(request({ action: 'download', key }))

    expect(response.status).toBe(403)
    expect(mocks.sessionExists).not.toHaveBeenCalled()
    expect(mocks.userExists).not.toHaveBeenCalled()
    expect(mocks.getDownloadPresignedUrl).not.toHaveBeenCalled()
  })

  it('does not sign a canonical recording key without a live reference', async () => {
    const key = `recordings/${USER_ID}/${OTHER_SESSION_ID}-${TIMESTAMP}.webm`
    mocks.sessionExists.mockResolvedValueOnce(null)

    const response = await POST(request({ action: 'download', key }))

    expect(response.status).toBe(404)
    await expect(response.json()).resolves.toEqual({ error: 'Artifact not found' })
    expect(mocks.sessionExists).toHaveBeenCalledWith({
      userId: USER_ID,
      $or: [
        { recordingR2Key: key },
        { screenRecordingR2Key: key },
        { audioRecordingR2Key: key },
      ],
    })
    expect(mocks.getDownloadPresignedUrl).not.toHaveBeenCalled()
  })

  it('returns exact account-unavailable when a missing reference is caused by deletion', async () => {
    mocks.sessionExists.mockResolvedValueOnce(null)
    mocks.isJobsAccountActive
      .mockResolvedValueOnce(true)
      .mockResolvedValueOnce(false)

    const response = await POST(request({ action: 'download', key: RECORDING_KEY }))

    expect(response.status).toBe(401)
    await expect(response.json()).resolves.toEqual({
      error: 'account unavailable',
      code: 'ACCOUNT_UNAVAILABLE',
    })
    expect(mocks.getDownloadPresignedUrl).not.toHaveBeenCalled()
  })

  it('withholds a signed URL when its live reference disappears', async () => {
    mocks.sessionExists
      .mockResolvedValueOnce({ _id: SESSION_ID })
      .mockResolvedValueOnce(null)

    const response = await POST(request({ action: 'download', key: RECORDING_KEY }))

    expect(response.status).toBe(404)
    await expect(response.json()).resolves.toEqual({ error: 'Artifact not found' })
    expect(mocks.getDownloadPresignedUrl).toHaveBeenCalledWith(RECORDING_KEY)
  })

  it('returns exact account-unavailable when deletion removes the post-sign reference', async () => {
    mocks.sessionExists
      .mockResolvedValueOnce({ _id: SESSION_ID })
      .mockResolvedValueOnce(null)
    mocks.isJobsAccountActive
      .mockResolvedValueOnce(true)
      .mockResolvedValueOnce(true)
      .mockResolvedValueOnce(true)
      .mockResolvedValueOnce(false)

    const response = await POST(request({ action: 'download', key: RECORDING_KEY }))

    expect(response.status).toBe(401)
    await expect(response.json()).resolves.toEqual({
      error: 'account unavailable',
      code: 'ACCOUNT_UNAVAILABLE',
    })
    expect(mocks.getDownloadPresignedUrl).toHaveBeenCalledWith(RECORDING_KEY)
  })

  it('returns successful upload capabilities with a private no-store policy', async () => {
    const response = await POST(request({
      action: 'upload',
      type: 'recording',
      sessionId: SESSION_ID,
    }, USER_ID))

    expect(response.status).toBe(200)
    await expect(response.json()).resolves.toEqual({
      url: 'https://r2.example/upload',
      key: RECORDING_KEY,
      contentType: 'video/webm',
    })
    expect(response.headers.get('Cache-Control')).toBe('private, no-store')
    expect(mocks.isJobsAccountActive).toHaveBeenCalledTimes(3)
  })

  it('returns successful download capabilities only while the document remains referenced', async () => {
    const response = await POST(request({ action: 'download', key: DOCUMENT_KEY }))

    expect(response.status).toBe(200)
    await expect(response.json()).resolves.toEqual({ url: 'https://r2.example/download' })
    expect(response.headers.get('Cache-Control')).toBe('private, no-store')
    expect(mocks.getDownloadPresignedUrl).toHaveBeenCalledWith(DOCUMENT_KEY)
    expect(mocks.sessionExists).toHaveBeenCalledTimes(2)
    expect(mocks.userExists).toHaveBeenCalledTimes(2)
    expect(mocks.isJobsAccountActive).toHaveBeenCalledTimes(3)
  })
})
