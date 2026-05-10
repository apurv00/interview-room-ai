import { NextRequest } from 'next/server'

const mocks = vi.hoisted(() => ({
  userId: '69fb49747e70dc410e5a2f12',
  sessionId: '69fb576edadf44259295721d',
  getServerSession: vi.fn(),
  connectDB: vi.fn(),
  sessionExists: vi.fn(),
  sessionFindOneAndUpdate: vi.fn(),
  isR2Configured: vi.fn(),
  createMultipartUpload: vi.fn(),
  getMultipartPartPresignedUrl: vi.fn(),
  completeMultipartUpload: vi.fn(),
  abortMultipartUpload: vi.fn(),
  objectExists: vi.fn(),
}))

vi.mock('next-auth', () => ({
  getServerSession: mocks.getServerSession,
}))

vi.mock('@shared/auth/authOptions', () => ({
  authOptions: {},
}))

vi.mock('@shared/db/connection', () => ({
  connectDB: mocks.connectDB,
}))

vi.mock('@shared/db/models/InterviewSession', () => ({
  InterviewSession: {
    exists: mocks.sessionExists,
    findOneAndUpdate: mocks.sessionFindOneAndUpdate,
  },
}))

vi.mock('@shared/storage/r2', () => ({
  isR2Configured: mocks.isR2Configured,
  recordingKey: (userId: string, sessionId: string) => `recordings/${userId}/${sessionId}-camera.webm`,
  screenRecordingKey: (userId: string, sessionId: string) => `recordings/${userId}/${sessionId}-screen.webm`,
  audioRecordingKey: (userId: string, sessionId: string) => `recordings/${userId}/${sessionId}-audio.webm`,
  createMultipartUpload: mocks.createMultipartUpload,
  getMultipartPartPresignedUrl: mocks.getMultipartPartPresignedUrl,
  completeMultipartUpload: mocks.completeMultipartUpload,
  abortMultipartUpload: mocks.abortMultipartUpload,
  objectExists: mocks.objectExists,
}))

import { POST } from '../route'

function makeRequest(body: Record<string, unknown>): NextRequest {
  return new NextRequest('http://localhost/api/storage/multipart', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
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
    mocks.sessionExists.mockResolvedValue({ _id: mocks.sessionId })
    mocks.createMultipartUpload.mockResolvedValue({
      key: `recordings/${mocks.userId}/${mocks.sessionId}-camera.webm`,
      uploadId: 'upload-123',
    })
    mocks.getMultipartPartPresignedUrl.mockResolvedValue('https://r2.example/part')
    mocks.completeMultipartUpload.mockResolvedValue(undefined)
    mocks.abortMultipartUpload.mockResolvedValue(undefined)
    mocks.objectExists.mockResolvedValue(true)
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
      `recordings/${mocks.userId}/${mocks.sessionId}-camera.webm`,
      'video/webm'
    )
    expect(body).toMatchObject({
      key: `recordings/${mocks.userId}/${mocks.sessionId}-camera.webm`,
      uploadId: 'upload-123',
      contentType: 'video/webm',
      partSizeBytes: 8 * 1024 * 1024,
    })
  })

  it('signs only keys owned by the authenticated user', async () => {
    const res = await POST(makeRequest({
      action: 'sign-part',
      key: `recordings/${mocks.userId}/${mocks.sessionId}-camera.webm`,
      uploadId: 'upload-123',
      partNumber: 2,
    }))
    const body = await res.json()

    expect(res.status).toBe(200)
    expect(body.url).toBe('https://r2.example/part')
    expect(mocks.getMultipartPartPresignedUrl).toHaveBeenCalledWith(
      `recordings/${mocks.userId}/${mocks.sessionId}-camera.webm`,
      'upload-123',
      2
    )
  })

  it('rejects multipart part signing for another user key', async () => {
    const res = await POST(makeRequest({
      action: 'sign-part',
      key: `recordings/other-user/${mocks.sessionId}-camera.webm`,
      uploadId: 'upload-123',
      partNumber: 1,
    }))

    expect(res.status).toBe(403)
    expect(mocks.getMultipartPartPresignedUrl).not.toHaveBeenCalled()
  })

  it('completes multipart upload and patches the session replay key', async () => {
    const key = `recordings/${mocks.userId}/${mocks.sessionId}-screen.webm`
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
    expect(mocks.sessionFindOneAndUpdate).toHaveBeenCalledWith(
      { _id: mocks.sessionId, userId: mocks.userId },
      { $set: { screenRecordingR2Key: key, screenRecordingSizeBytes: 123_456 } }
    )
  })

  it('recovers a retried complete (NoSuchUpload) when the object exists and patches the session', async () => {
    const key = `recordings/${mocks.userId}/${mocks.sessionId}-camera.webm`
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
    expect(mocks.sessionFindOneAndUpdate).toHaveBeenCalledWith(
      { _id: mocks.sessionId, userId: mocks.userId },
      { $set: { recordingR2Key: key, recordingSizeBytes: 999_000 } }
    )
  })

  it('returns 410 and skips the session patch when NoSuchUpload but the object does not exist', async () => {
    const key = `recordings/${mocks.userId}/${mocks.sessionId}-camera.webm`
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
    expect(mocks.sessionFindOneAndUpdate).not.toHaveBeenCalled()
  })

  it('does not patch the session when complete fails with a non-recoverable error', async () => {
    const key = `recordings/${mocks.userId}/${mocks.sessionId}-camera.webm`
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
    expect(mocks.sessionFindOneAndUpdate).not.toHaveBeenCalled()
  })

  it('rejects completion when the key belongs to a different session', async () => {
    const res = await POST(makeRequest({
      action: 'complete',
      type: 'recording',
      sessionId: mocks.sessionId,
      key: `recordings/${mocks.userId}/different-session-camera.webm`,
      uploadId: 'upload-123',
      sizeBytes: 123_456,
      parts: [{ partNumber: 1, etag: '"etag-1"' }],
    }))

    expect(res.status).toBe(403)
    expect(mocks.completeMultipartUpload).not.toHaveBeenCalled()
    expect(mocks.sessionFindOneAndUpdate).not.toHaveBeenCalled()
  })
})
