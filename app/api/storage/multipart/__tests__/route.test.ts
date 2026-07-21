import { NextRequest } from 'next/server'

const mocks = vi.hoisted(() => {
  class JobsAccountInactiveError extends Error {}
  class JobsAccountTransactionsRequiredError extends Error {}
  class RecordingArtifactKeyRejectedError extends Error {}
  class RecordingArtifactSessionNotFoundError extends Error {}

  return {
    userId: '69fb49747e70dc410e5a2f12',
    sessionId: '69fb576edadf44259295721d',
    getServerSession: vi.fn(),
    connectDB: vi.fn(),
    isJobsAccountActive: vi.fn(),
    JobsAccountInactiveError,
    JobsAccountTransactionsRequiredError,
    sessionExists: vi.fn(),
    sessionFindOne: vi.fn(),
    associateRecordingArtifact: vi.fn(),
    cleanupSupersededRecordingArtifact: vi.fn(),
    parseRecordingArtifactKey: vi.fn(),
    isSessionRecordingKey: vi.fn(),
    RecordingArtifactKeyRejectedError,
    RecordingArtifactSessionNotFoundError,
    isR2Configured: vi.fn(),
    createMultipartUpload: vi.fn(),
    getMultipartPartPresignedUrl: vi.fn(),
    completeMultipartUpload: vi.fn(),
    abortMultipartUpload: vi.fn(),
    deleteFromR2: vi.fn(),
    objectExists: vi.fn(),
    aiLoggerError: vi.fn(),
    aiLoggerWarn: vi.fn(),
  }
})

vi.mock('next-auth', () => ({
  getServerSession: mocks.getServerSession,
}))

vi.mock('@shared/auth/authOptions', () => ({
  authOptions: {},
}))

vi.mock('@shared/db/connection', () => ({
  connectDB: mocks.connectDB,
}))

vi.mock('@shared/services/jobsAccountFence', () => ({
  isJobsAccountActive: mocks.isJobsAccountActive,
  JobsAccountInactiveError: mocks.JobsAccountInactiveError,
  JobsAccountTransactionsRequiredError: mocks.JobsAccountTransactionsRequiredError,
}))

vi.mock('@shared/db/models/InterviewSession', () => ({
  InterviewSession: {
    exists: mocks.sessionExists,
    findOne: mocks.sessionFindOne,
  },
}))

vi.mock('@interview/services/core/recordingArtifactService', () => ({
  associateRecordingArtifact: mocks.associateRecordingArtifact,
  cleanupSupersededRecordingArtifact: mocks.cleanupSupersededRecordingArtifact,
  parseRecordingArtifactKey: mocks.parseRecordingArtifactKey,
  isSessionRecordingKey: mocks.isSessionRecordingKey,
  RecordingArtifactKeyRejectedError: mocks.RecordingArtifactKeyRejectedError,
  RecordingArtifactSessionNotFoundError: mocks.RecordingArtifactSessionNotFoundError,
}))

vi.mock('@shared/storage/r2', () => ({
  isR2Configured: mocks.isR2Configured,
  recordingKey: (userId: string, sessionId: string) => `recordings/${userId}/${sessionId}-1700000000000.webm`,
  screenRecordingKey: (userId: string, sessionId: string) => `recordings/${userId}/${sessionId}-screen-1700000000000.webm`,
  audioRecordingKey: (userId: string, sessionId: string) => `recordings/${userId}/${sessionId}-audio-1700000000000.webm`,
  createMultipartUpload: mocks.createMultipartUpload,
  getMultipartPartPresignedUrl: mocks.getMultipartPartPresignedUrl,
  completeMultipartUpload: mocks.completeMultipartUpload,
  abortMultipartUpload: mocks.abortMultipartUpload,
  deleteFromR2: mocks.deleteFromR2,
  objectExists: mocks.objectExists,
}))

vi.mock('@shared/logger', () => ({
  aiLogger: {
    error: mocks.aiLoggerError,
    warn: mocks.aiLoggerWarn,
  },
}))

import { POST } from '../route'

type RecordingType = 'recording' | 'screen-recording' | 'audio-recording'
const DELETE_AUTHORITY = {
  ownerUserId: mocks.userId,
  sessionId: mocks.sessionId,
}

function parseCanonicalRecordingKey(key: string, userId: string) {
  const prefix = `recordings/${userId}/`
  if (!key.startsWith(prefix) || key.includes('..')) return null
  const match = /^([a-fA-F0-9]{24})(?:-(screen|audio))?-(\d{10,16})\.webm$/
    .exec(key.slice(prefix.length))
  if (!match) return null
  return {
    sessionId: match[1],
    type: match[2] === 'screen'
      ? 'screen-recording'
      : match[2] === 'audio'
      ? 'audio-recording'
      : 'recording',
    timestamp: match[3],
  }
}

function makeRequest(body: Record<string, unknown>, originUserId?: string): NextRequest {
  return new NextRequest('http://localhost/api/storage/multipart', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      ...(originUserId !== undefined ? { 'x-origin-user-id': originUserId } : {}),
    },
    body: JSON.stringify(body),
  })
}

describe('POST /api/storage/multipart', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.getServerSession.mockResolvedValue({
      user: { id: mocks.userId },
    })
    mocks.isR2Configured.mockReturnValue(true)
    mocks.isJobsAccountActive.mockResolvedValue(true)
    mocks.sessionExists.mockResolvedValue({ _id: mocks.sessionId })
    mocks.sessionFindOne.mockReturnValue({
      select: vi.fn().mockReturnValue({
        lean: vi.fn().mockResolvedValue(null),
      }),
    })
    mocks.createMultipartUpload.mockResolvedValue({
      key: `recordings/${mocks.userId}/${mocks.sessionId}-1700000000000.webm`,
      uploadId: 'upload-123',
    })
    mocks.getMultipartPartPresignedUrl.mockResolvedValue('https://r2.example/part')
    mocks.completeMultipartUpload.mockResolvedValue(undefined)
    mocks.abortMultipartUpload.mockResolvedValue(undefined)
    mocks.deleteFromR2.mockResolvedValue(undefined)
    mocks.objectExists.mockResolvedValue(true)
    mocks.parseRecordingArtifactKey.mockImplementation(parseCanonicalRecordingKey)
    mocks.isSessionRecordingKey.mockImplementation((
      key: string,
      type: RecordingType,
      userId: string,
      sessionId: string,
    ) => {
      const identity = parseCanonicalRecordingKey(key, userId)
      return identity?.sessionId === sessionId && identity.type === type
    })
    mocks.associateRecordingArtifact.mockResolvedValue({ accepted: true })
    mocks.cleanupSupersededRecordingArtifact.mockResolvedValue(undefined)
  })

  it('rejects a stale tab whose origin user no longer matches the authenticated user', async () => {
    const res = await POST(makeRequest({
      action: 'create',
      type: 'recording',
      sessionId: mocks.sessionId,
    }, 'another-user'))

    expect(res.status).toBe(409)
    await expect(res.json()).resolves.toEqual({
      error: 'sign-in session changed',
      code: 'SESSION_CHANGED',
    })
    expect(mocks.isJobsAccountActive).not.toHaveBeenCalled()
    expect(mocks.createMultipartUpload).not.toHaveBeenCalled()
  })

  it.each(['create', 'sign-part', 'complete'] as const)(
    'denies inactive accounts before %s can create new R2 authority',
    async (action) => {
      mocks.isJobsAccountActive.mockResolvedValueOnce(false)
      const common = {
        key: `recordings/${mocks.userId}/${mocks.sessionId}-1700000000000.webm`,
        uploadId: 'upload-123',
      }
      const body = action === 'create'
        ? { action, type: 'recording', sessionId: mocks.sessionId }
        : action === 'sign-part'
        ? { action, ...common, partNumber: 1 }
        : {
            action,
            ...common,
            type: 'recording',
            sessionId: mocks.sessionId,
            sizeBytes: 10,
            parts: [{ partNumber: 1, etag: 'etag-1' }],
          }

      const res = await POST(makeRequest(body))

      expect(res.status).toBe(401)
      await expect(res.json()).resolves.toEqual({
        error: 'account unavailable',
        code: 'ACCOUNT_UNAVAILABLE',
      })
      expect(mocks.createMultipartUpload).not.toHaveBeenCalled()
      expect(mocks.getMultipartPartPresignedUrl).not.toHaveBeenCalled()
      expect(mocks.completeMultipartUpload).not.toHaveBeenCalled()
      if (action === 'sign-part') {
        expect(mocks.abortMultipartUpload).toHaveBeenCalledWith(common.key, common.uploadId)
        expect(mocks.deleteFromR2).not.toHaveBeenCalled()
      } else if (action === 'complete') {
        expect(mocks.abortMultipartUpload).toHaveBeenCalledWith(common.key, common.uploadId)
        expect(mocks.deleteFromR2).toHaveBeenCalledWith(
          common.key,
          DELETE_AUTHORITY,
        )
      } else {
        expect(mocks.abortMultipartUpload).not.toHaveBeenCalled()
        expect(mocks.deleteFromR2).not.toHaveBeenCalled()
      }
    },
  )

  it('keeps account-unavailable authoritative during a storage outage', async () => {
    mocks.isJobsAccountActive.mockResolvedValueOnce(false)
    mocks.isR2Configured.mockReturnValue(false)

    const res = await POST(makeRequest({
      action: 'create',
      type: 'recording',
      sessionId: mocks.sessionId,
    }))

    expect(res.status).toBe(401)
    await expect(res.json()).resolves.toMatchObject({ code: 'ACCOUNT_UNAVAILABLE' })
    expect(mocks.isR2Configured).not.toHaveBeenCalled()
  })

  it('creates a multipart upload for an owned recording session', async () => {
    const res = await POST(makeRequest({
      action: 'create',
      type: 'recording',
      sessionId: mocks.sessionId,
    }))
    const body = await res.json()

    expect(res.status).toBe(200)
    expect(mocks.sessionExists).toHaveBeenCalledWith({ _id: mocks.sessionId, userId: mocks.userId })
    expect(mocks.createMultipartUpload).toHaveBeenCalledWith(
      `recordings/${mocks.userId}/${mocks.sessionId}-1700000000000.webm`,
      'video/webm'
    )
    expect(body).toMatchObject({
      key: `recordings/${mocks.userId}/${mocks.sessionId}-1700000000000.webm`,
      uploadId: 'upload-123',
      contentType: 'video/webm',
      partSizeBytes: 8 * 1024 * 1024,
    })
    expect(res.headers.get('cache-control')).toBe('private, no-store')
  })

  it('aborts a newly-created upload and withholds authority when deletion wins before egress', async () => {
    mocks.isJobsAccountActive
      .mockResolvedValueOnce(true)
      .mockResolvedValueOnce(true)
      .mockResolvedValueOnce(false)

    const res = await POST(makeRequest({
      action: 'create',
      type: 'recording',
      sessionId: mocks.sessionId,
    }))

    expect(res.status).toBe(401)
    await expect(res.json()).resolves.toMatchObject({ code: 'ACCOUNT_UNAVAILABLE' })
    expect(mocks.createMultipartUpload).toHaveBeenCalledTimes(1)
    expect(mocks.abortMultipartUpload).toHaveBeenCalledWith(
      `recordings/${mocks.userId}/${mocks.sessionId}-1700000000000.webm`,
      'upload-123',
    )
  })

  it('aborts a newly-created upload when its owned session disappears before egress', async () => {
    mocks.sessionExists
      .mockResolvedValueOnce({ _id: mocks.sessionId })
      .mockResolvedValueOnce(null)

    const res = await POST(makeRequest({
      action: 'create',
      type: 'recording',
      sessionId: mocks.sessionId,
    }))

    expect(res.status).toBe(403)
    expect(mocks.abortMultipartUpload).toHaveBeenCalledWith(
      `recordings/${mocks.userId}/${mocks.sessionId}-1700000000000.webm`,
      'upload-123',
    )
  })

  it('signs only keys owned by the authenticated user', async () => {
    const res = await POST(makeRequest({
      action: 'sign-part',
      key: `recordings/${mocks.userId}/${mocks.sessionId}-1700000000000.webm`,
      uploadId: 'upload-123',
      partNumber: 2,
    }))
    const body = await res.json()

    expect(res.status).toBe(200)
    expect(body.url).toBe('https://r2.example/part')
    expect(mocks.getMultipartPartPresignedUrl).toHaveBeenCalledWith(
      `recordings/${mocks.userId}/${mocks.sessionId}-1700000000000.webm`,
      'upload-123',
      2
    )
    expect(res.headers.get('cache-control')).toBe('private, no-store')
  })

  it('withholds a signed part URL and aborts the upload when deletion wins during signing', async () => {
    mocks.isJobsAccountActive
      .mockResolvedValueOnce(true)
      .mockResolvedValueOnce(false)

    const key = `recordings/${mocks.userId}/${mocks.sessionId}-1700000000000.webm`
    const res = await POST(makeRequest({
      action: 'sign-part',
      key,
      uploadId: 'upload-123',
      partNumber: 2,
    }))

    expect(res.status).toBe(401)
    await expect(res.json()).resolves.toMatchObject({ code: 'ACCOUNT_UNAVAILABLE' })
    expect(mocks.getMultipartPartPresignedUrl).toHaveBeenCalledTimes(1)
    expect(mocks.abortMultipartUpload).toHaveBeenCalledWith(key, 'upload-123')
  })

  it('withholds a signed part URL and aborts when session ownership disappears after signing', async () => {
    mocks.sessionExists
      .mockResolvedValueOnce({ _id: mocks.sessionId })
      .mockResolvedValueOnce(null)
    const key = `recordings/${mocks.userId}/${mocks.sessionId}-1700000000000.webm`

    const res = await POST(makeRequest({
      action: 'sign-part',
      type: 'recording',
      sessionId: mocks.sessionId,
      key,
      uploadId: 'upload-123',
      partNumber: 2,
    }))

    expect(res.status).toBe(403)
    expect(mocks.getMultipartPartPresignedUrl).toHaveBeenCalledTimes(1)
    expect(mocks.sessionExists).toHaveBeenCalledTimes(2)
    expect(mocks.abortMultipartUpload).toHaveBeenCalledWith(key, 'upload-123')
  })

  it('rejects multipart part signing for another user key', async () => {
    const res = await POST(makeRequest({
      action: 'sign-part',
      key: `recordings/other-user/${mocks.sessionId}-1700000000000.webm`,
      uploadId: 'upload-123',
      partNumber: 1,
    }))

    expect(res.status).toBe(403)
    expect(mocks.getMultipartPartPresignedUrl).not.toHaveBeenCalled()
  })

  it.each([
    {
      label: 'legacy non-timestamp key',
      key: `recordings/${mocks.userId}/${mocks.sessionId}-camera.webm`,
      sessionId: undefined,
      type: undefined,
    },
    {
      label: 'traversal key',
      key: `recordings/${mocks.userId}/../${mocks.sessionId}-1700000000000.webm`,
      sessionId: undefined,
      type: undefined,
    },
    {
      label: 'wrong extension',
      key: `recordings/${mocks.userId}/${mocks.sessionId}-1700000000000.mp4`,
      sessionId: undefined,
      type: undefined,
    },
    {
      label: 'wrong session',
      key: `recordings/${mocks.userId}/69fb576edadf44259295721e-1700000000000.webm`,
      sessionId: mocks.sessionId,
      type: undefined,
    },
    {
      label: 'type-confused audio key',
      key: `recordings/${mocks.userId}/${mocks.sessionId}-audio-1700000000000.webm`,
      sessionId: undefined,
      type: 'recording' as const,
    },
  ])('rejects $label during part signing', async ({ key, sessionId, type }) => {
    const res = await POST(makeRequest({
      action: 'sign-part',
      key,
      uploadId: 'upload-123',
      partNumber: 1,
      ...(sessionId ? { sessionId } : {}),
      ...(type ? { type } : {}),
    }))

    expect(res.status).toBe(403)
    expect(mocks.getMultipartPartPresignedUrl).not.toHaveBeenCalled()
  })

  it('completes multipart upload and patches the session replay key', async () => {
    const key = `recordings/${mocks.userId}/${mocks.sessionId}-screen-1700000000000.webm`
    const res = await POST(makeRequest({
      action: 'complete',
      type: 'screen-recording',
      sessionId: mocks.sessionId,
      key,
      uploadId: 'upload-123',
      sizeBytes: 123_456,
      parts: [
        { partNumber: 1, etag: '"etag-1"' },
        { partNumber: 2, etag: '"etag-2"' },
      ],
    }))

    expect(res.status).toBe(200)
    expect(mocks.completeMultipartUpload).toHaveBeenCalledWith(key, 'upload-123', [
      { PartNumber: 1, ETag: '"etag-1"' },
      { PartNumber: 2, ETag: '"etag-2"' },
    ])
    expect(mocks.associateRecordingArtifact).toHaveBeenCalledWith({
      userId: mocks.userId,
      sessionId: mocks.sessionId,
      type: 'screen-recording',
      key,
      sizeBytes: 123_456,
    })
    expect(mocks.cleanupSupersededRecordingArtifact).toHaveBeenCalledWith(
      undefined,
      key,
      mocks.userId,
      mocks.sessionId,
    )
  })

  it('does not complete when deletion wins after ownership validation', async () => {
    mocks.isJobsAccountActive
      .mockResolvedValueOnce(true)
      .mockResolvedValueOnce(false)
    const key = `recordings/${mocks.userId}/${mocks.sessionId}-1700000000000.webm`

    const res = await POST(makeRequest({
      action: 'complete',
      type: 'recording',
      sessionId: mocks.sessionId,
      key,
      uploadId: 'upload-123',
      sizeBytes: 123,
      parts: [{ partNumber: 1, etag: 'etag-1' }],
    }))

    expect(res.status).toBe(401)
    expect(mocks.completeMultipartUpload).not.toHaveBeenCalled()
    expect(mocks.associateRecordingArtifact).not.toHaveBeenCalled()
  })

  it('deletes a materialized object and skips the session patch when deletion wins during completion', async () => {
    mocks.isJobsAccountActive
      .mockResolvedValueOnce(true)
      .mockResolvedValueOnce(true)
      .mockResolvedValueOnce(false)
    const key = `recordings/${mocks.userId}/${mocks.sessionId}-1700000000000.webm`

    const res = await POST(makeRequest({
      action: 'complete',
      type: 'recording',
      sessionId: mocks.sessionId,
      key,
      uploadId: 'upload-123',
      sizeBytes: 123,
      parts: [{ partNumber: 1, etag: 'etag-1' }],
    }))

    expect(res.status).toBe(401)
    expect(mocks.completeMultipartUpload).toHaveBeenCalledTimes(1)
    expect(mocks.deleteFromR2).toHaveBeenCalledWith(key, DELETE_AUTHORITY)
    expect(mocks.associateRecordingArtifact).not.toHaveBeenCalled()
  })

  it('deletes a materialized object when the owned session disappears before its conditional patch', async () => {
    mocks.associateRecordingArtifact.mockRejectedValueOnce(
      new mocks.RecordingArtifactSessionNotFoundError('session missing'),
    )
    const key = `recordings/${mocks.userId}/${mocks.sessionId}-1700000000000.webm`

    const res = await POST(makeRequest({
      action: 'complete',
      type: 'recording',
      sessionId: mocks.sessionId,
      key,
      uploadId: 'upload-123',
      sizeBytes: 123,
      parts: [{ partNumber: 1, etag: 'etag-1' }],
    }))

    expect(res.status).toBe(403)
    expect(mocks.deleteFromR2).toHaveBeenCalledWith(key, DELETE_AUTHORITY)
  })

  it('deletes the materialized object when transactional association rejects an inactive account', async () => {
    mocks.associateRecordingArtifact.mockRejectedValueOnce(
      new mocks.JobsAccountInactiveError('account unavailable'),
    )
    const key = `recordings/${mocks.userId}/${mocks.sessionId}-1700000000000.webm`

    const res = await POST(makeRequest({
      action: 'complete',
      type: 'recording',
      sessionId: mocks.sessionId,
      key,
      uploadId: 'upload-123',
      sizeBytes: 123,
      parts: [{ partNumber: 1, etag: 'etag-1' }],
    }))

    expect(res.status).toBe(401)
    await expect(res.json()).resolves.toMatchObject({ code: 'ACCOUNT_UNAVAILABLE' })
    expect(mocks.deleteFromR2).toHaveBeenCalledWith(key, DELETE_AUTHORITY)
  })

  it('deletes the materialized object and reports a transaction prerequisite failure', async () => {
    mocks.associateRecordingArtifact.mockRejectedValueOnce(
      new mocks.JobsAccountTransactionsRequiredError('transactions required'),
    )
    const key = `recordings/${mocks.userId}/${mocks.sessionId}-1700000000000.webm`

    const res = await POST(makeRequest({
      action: 'complete',
      type: 'recording',
      sessionId: mocks.sessionId,
      key,
      uploadId: 'upload-123',
      sizeBytes: 123,
      parts: [{ partNumber: 1, etag: 'etag-1' }],
    }))

    expect(res.status).toBe(503)
    await expect(res.json()).resolves.toEqual({
      error: 'Recording finalization requires MongoDB transactions',
      code: 'TRANSACTIONS_REQUIRED',
    })
    expect(mocks.deleteFromR2).toHaveBeenCalledWith(key, DELETE_AUTHORITY)
  })

  it('deletes a completed object rejected by the association key guard', async () => {
    mocks.associateRecordingArtifact.mockRejectedValueOnce(
      new mocks.RecordingArtifactKeyRejectedError('key rejected'),
    )
    const key = `recordings/${mocks.userId}/${mocks.sessionId}-1700000000000.webm`

    const res = await POST(makeRequest({
      action: 'complete',
      type: 'recording',
      sessionId: mocks.sessionId,
      key,
      uploadId: 'upload-123',
      sizeBytes: 123,
      parts: [{ partNumber: 1, etag: 'etag-1' }],
    }))

    expect(res.status).toBe(403)
    expect(mocks.deleteFromR2).toHaveBeenCalledWith(key, DELETE_AUTHORITY)
  })

  it('deletes a delayed completion superseded by a newer accepted artifact', async () => {
    mocks.associateRecordingArtifact.mockResolvedValueOnce({ accepted: false })
    const key = `recordings/${mocks.userId}/${mocks.sessionId}-1700000000000.webm`

    const res = await POST(makeRequest({
      action: 'complete',
      type: 'recording',
      sessionId: mocks.sessionId,
      key,
      uploadId: 'upload-123',
      sizeBytes: 123,
      parts: [{ partNumber: 1, etag: 'etag-1' }],
    }))

    expect(res.status).toBe(200)
    await expect(res.json()).resolves.toEqual({ key, superseded: true })
    expect(mocks.deleteFromR2).toHaveBeenCalledWith(key, DELETE_AUTHORITY)
    expect(mocks.cleanupSupersededRecordingArtifact).not.toHaveBeenCalled()
  })

  it('deletes a materialized object when deletion wins after the conditional session patch', async () => {
    mocks.isJobsAccountActive
      .mockResolvedValueOnce(true)
      .mockResolvedValueOnce(true)
      .mockResolvedValueOnce(true)
      .mockResolvedValueOnce(false)
    const key = `recordings/${mocks.userId}/${mocks.sessionId}-1700000000000.webm`

    const res = await POST(makeRequest({
      action: 'complete',
      type: 'recording',
      sessionId: mocks.sessionId,
      key,
      uploadId: 'upload-123',
      sizeBytes: 123,
      parts: [{ partNumber: 1, etag: 'etag-1' }],
    }))

    expect(res.status).toBe(401)
    expect(mocks.associateRecordingArtifact).toHaveBeenCalledTimes(1)
    expect(mocks.deleteFromR2).toHaveBeenCalledWith(key, DELETE_AUTHORITY)
  })

  it('rechecks a completion exception and deletes a possibly-materialized object when inactive', async () => {
    mocks.isJobsAccountActive
      .mockResolvedValueOnce(true)
      .mockResolvedValueOnce(true)
      .mockResolvedValueOnce(false)
    mocks.completeMultipartUpload.mockRejectedValueOnce(new Error('completion response lost'))
    const key = `recordings/${mocks.userId}/${mocks.sessionId}-1700000000000.webm`

    const res = await POST(makeRequest({
      action: 'complete',
      type: 'recording',
      sessionId: mocks.sessionId,
      key,
      uploadId: 'upload-123',
      sizeBytes: 123,
      parts: [{ partNumber: 1, etag: 'etag-1' }],
    }))

    expect(res.status).toBe(401)
    expect(mocks.objectExists).toHaveBeenCalledWith(key)
    expect(mocks.deleteFromR2).toHaveBeenCalledWith(key, DELETE_AUTHORITY)
    expect(mocks.associateRecordingArtifact).not.toHaveBeenCalled()
  })

  it('allows an inactive account to abort its owned multipart upload, then returns the terminal account response', async () => {
    mocks.isJobsAccountActive.mockResolvedValueOnce(false)
    const key = `recordings/${mocks.userId}/${mocks.sessionId}-1700000000000.webm`

    const res = await POST(makeRequest({
      action: 'abort',
      key,
      uploadId: 'upload-123',
    }))

    expect(mocks.abortMultipartUpload).toHaveBeenCalledWith(key, 'upload-123')
    expect(res.status).toBe(401)
    await expect(res.json()).resolves.toMatchObject({ code: 'ACCOUNT_UNAVAILABLE' })
  })

  it('returns success after an active account aborts its owned multipart upload', async () => {
    const key = `recordings/${mocks.userId}/${mocks.sessionId}-1700000000000.webm`

    const res = await POST(makeRequest({
      action: 'abort',
      key,
      uploadId: 'upload-123',
    }))

    expect(mocks.abortMultipartUpload).toHaveBeenCalledWith(key, 'upload-123')
    expect(res.status).toBe(200)
    await expect(res.json()).resolves.toEqual({ ok: true })
  })

  it('persists recorder-truth durationSeconds with a camera complete (queued-drain fallback path)', async () => {
    const key = `recordings/${mocks.userId}/${mocks.sessionId}-1700000000000.webm`
    const res = await POST(makeRequest({
      action: 'complete',
      type: 'recording',
      sessionId: mocks.sessionId,
      key,
      uploadId: 'upload-123',
      sizeBytes: 164_656_436,
      durationSeconds: 1789.4,
      parts: [{ partNumber: 1, etag: '"etag-1"' }],
    }))

    expect(res.status).toBe(200)
    expect(mocks.associateRecordingArtifact).toHaveBeenCalledWith({
      userId: mocks.userId,
      sessionId: mocks.sessionId,
      type: 'recording',
      key,
      sizeBytes: 164_656_436,
      durationSeconds: 1789.4,
    })
  })

  it('camera complete without durationSeconds patches only key+size (legacy clients)', async () => {
    const key = `recordings/${mocks.userId}/${mocks.sessionId}-1700000000000.webm`
    const res = await POST(makeRequest({
      action: 'complete',
      type: 'recording',
      sessionId: mocks.sessionId,
      key,
      uploadId: 'upload-123',
      sizeBytes: 9_999,
      parts: [{ partNumber: 1, etag: '"etag-1"' }],
    }))

    expect(res.status).toBe(200)
    expect(mocks.associateRecordingArtifact).toHaveBeenCalledWith({
      userId: mocks.userId,
      sessionId: mocks.sessionId,
      type: 'recording',
      key,
      sizeBytes: 9_999,
    })
  })

  it('recovers a retried complete (NoSuchUpload) when the object exists and patches the session', async () => {
    const key = `recordings/${mocks.userId}/${mocks.sessionId}-1700000000000.webm`
    const noSuchUpload = Object.assign(new Error('NoSuchUpload'), { name: 'NoSuchUpload' })
    mocks.completeMultipartUpload.mockRejectedValueOnce(noSuchUpload)
    mocks.objectExists.mockResolvedValueOnce(true)

    const res = await POST(makeRequest({
      action: 'complete',
      type: 'recording',
      sessionId: mocks.sessionId,
      key,
      uploadId: 'upload-123',
      sizeBytes: 999_000,
      parts: [{ partNumber: 1, etag: '"etag-1"' }],
    }))

    expect(res.status).toBe(200)
    expect(mocks.objectExists).toHaveBeenCalledWith(key)
    expect(mocks.associateRecordingArtifact).toHaveBeenCalledWith({
      userId: mocks.userId,
      sessionId: mocks.sessionId,
      type: 'recording',
      key,
      sizeBytes: 999_000,
    })
  })

  it('returns 410 and skips the session patch when NoSuchUpload but the object does not exist', async () => {
    const key = `recordings/${mocks.userId}/${mocks.sessionId}-1700000000000.webm`
    const noSuchUpload = Object.assign(new Error('NoSuchUpload'), { name: 'NoSuchUpload' })
    mocks.completeMultipartUpload.mockRejectedValueOnce(noSuchUpload)
    mocks.objectExists.mockResolvedValueOnce(false)

    const res = await POST(makeRequest({
      action: 'complete',
      type: 'recording',
      sessionId: mocks.sessionId,
      key,
      uploadId: 'upload-123',
      sizeBytes: 999_000,
      parts: [{ partNumber: 1, etag: '"etag-1"' }],
    }))

    expect(res.status).toBe(410)
    expect(mocks.objectExists).toHaveBeenCalledWith(key)
    expect(mocks.associateRecordingArtifact).not.toHaveBeenCalled()
  })

  it('treats a retried complete as idempotent when the session already has the final recording', async () => {
    const key = `recordings/${mocks.userId}/${mocks.sessionId}-1700000000000.webm`
    const noSuchUpload = Object.assign(new Error('NoSuchUpload'), { name: 'NoSuchUpload' })
    mocks.completeMultipartUpload.mockRejectedValueOnce(noSuchUpload)
    mocks.objectExists.mockResolvedValueOnce(false)
    mocks.sessionFindOne.mockReturnValueOnce({
      select: vi.fn().mockReturnValue({
        lean: vi.fn().mockResolvedValue({
          recordingR2Key: key,
          recordingSizeBytes: 999_000,
        }),
      }),
    })

    const res = await POST(makeRequest({
      action: 'complete',
      type: 'recording',
      sessionId: mocks.sessionId,
      key,
      uploadId: 'upload-123',
      sizeBytes: 999_000,
      parts: [{ partNumber: 1, etag: '"etag-1"' }],
    }))
    const body = await res.json()

    expect(res.status).toBe(200)
    expect(body.key).toBe(key)
    expect(mocks.associateRecordingArtifact).not.toHaveBeenCalled()
    expect(mocks.aiLoggerWarn).toHaveBeenCalledWith(
      expect.objectContaining({ status: 'already-persisted', action: 'complete' }),
      'Multipart complete retried after session was already patched',
    )
  })

  it('does not patch the session when complete fails with a non-recoverable error', async () => {
    const key = `recordings/${mocks.userId}/${mocks.sessionId}-1700000000000.webm`
    mocks.completeMultipartUpload.mockRejectedValueOnce(new Error('network blip'))

    const res = await POST(makeRequest({
      action: 'complete',
      type: 'recording',
      sessionId: mocks.sessionId,
      key,
      uploadId: 'upload-123',
      sizeBytes: 999_000,
      parts: [{ partNumber: 1, etag: '"etag-1"' }],
    }))

    expect(res.status).toBe(500)
    expect(mocks.objectExists).not.toHaveBeenCalled()
    expect(mocks.associateRecordingArtifact).not.toHaveBeenCalled()
    expect(mocks.aiLoggerError).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'complete',
        type: 'recording',
        sessionId: mocks.sessionId,
        keySuffix: key,
        partCount: 1,
        sizeBytes: 999_000,
        error: expect.objectContaining({
          name: 'Error',
          message: 'network blip',
        }),
      }),
      'Multipart upload failed'
    )
  })

  it.each([
    {
      label: 'different session',
      key: `recordings/${mocks.userId}/69fb576edadf44259295721e-1700000000000.webm`,
      type: 'recording' as const,
      aborts: true,
    },
    {
      label: 'type-confused audio artifact',
      key: `recordings/${mocks.userId}/${mocks.sessionId}-audio-1700000000000.webm`,
      type: 'recording' as const,
      aborts: true,
    },
    {
      label: 'legacy non-timestamp artifact',
      key: `recordings/${mocks.userId}/${mocks.sessionId}-camera.webm`,
      type: 'recording' as const,
      aborts: false,
    },
    {
      label: 'path traversal artifact',
      key: `recordings/${mocks.userId}/../${mocks.sessionId}-1700000000000.webm`,
      type: 'recording' as const,
      aborts: false,
    },
  ])('rejects completion for a $label key', async ({ key, type, aborts }) => {
    const res = await POST(makeRequest({
      action: 'complete',
      type,
      sessionId: mocks.sessionId,
      key,
      uploadId: 'upload-123',
      sizeBytes: 123_456,
      parts: [{ partNumber: 1, etag: '"etag-1"' }],
    }))

    expect(res.status).toBe(403)
    expect(mocks.completeMultipartUpload).not.toHaveBeenCalled()
    expect(mocks.associateRecordingArtifact).not.toHaveBeenCalled()
    if (aborts) {
      expect(mocks.abortMultipartUpload).toHaveBeenCalledWith(key, 'upload-123')
    } else {
      expect(mocks.abortMultipartUpload).not.toHaveBeenCalled()
    }
  })
})
