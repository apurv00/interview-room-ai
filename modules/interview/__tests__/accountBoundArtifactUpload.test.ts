import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  requestAccountBoundJson,
  uploadRecordingArtifact,
} from '@interview/utils/accountBoundArtifactUpload'
import { captureReplayUploadIntent } from '@interview/utils/resumableUpload'
import { __resetReplayUploadPrivacyForTests } from '@shared/services/replayUploadPrivacy'

const USER_ID = '507f1f77bcf86cd799439010'
const SESSION_ID = '507f1f77bcf86cd799439011'

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  })
}

describe('account-bound interview artifact uploads', () => {
  beforeEach(() => {
    vi.restoreAllMocks()
    __resetReplayUploadPrivacyForTests()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('carries one privacy generation and origin identity through audio upload and association', async () => {
    const calls: Array<{ url: string; init?: RequestInit }> = []
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url
      calls.push({ url, init })
      if (url === '/api/storage/presign') {
        return jsonResponse({
          url: 'https://r2.example/audio',
          key: `recordings/${USER_ID}/${SESSION_ID}-audio-1700000000000.webm`,
          contentType: 'audio/webm',
        })
      }
      if (url === 'https://r2.example/audio') return new Response('', { status: 200 })
      if (url === '/api/recordings/finalize') return jsonResponse({ success: true })
      throw new Error(`Unexpected fetch: ${url}`)
    }))

    const result = await uploadRecordingArtifact(
      new Blob(['audio'], { type: 'audio/webm' }),
      SESSION_ID,
      'audio',
      captureReplayUploadIntent(),
      USER_ID,
    )

    expect(result).toBe(true)
    expect(calls.map((call) => call.url)).toEqual([
      '/api/storage/presign',
      'https://r2.example/audio',
      '/api/recordings/finalize',
    ])
    expect(calls[0].init?.headers).toMatchObject({ 'x-origin-user-id': USER_ID })
    expect(calls[2].init?.headers).toMatchObject({ 'x-origin-user-id': USER_ID })
    expect(JSON.parse(String(calls[2].init?.body))).toEqual({
      type: 'audio-recording',
      sessionId: SESSION_ID,
      key: `recordings/${USER_ID}/${SESSION_ID}-audio-1700000000000.webm`,
      sizeBytes: 5,
    })
    expect(calls.every((call) => call.init?.signal instanceof AbortSignal)).toBe(true)
  })

  it('turns exact account-unavailable at presign into a terminal privacy generation', async () => {
    const intent = captureReplayUploadIntent()
    const fetchMock = vi.fn(async () => jsonResponse({
      error: 'account unavailable',
      code: 'ACCOUNT_UNAVAILABLE',
    }, 401))
    vi.stubGlobal('fetch', fetchMock)

    await expect(uploadRecordingArtifact(
      new Blob(['audio'], { type: 'audio/webm' }),
      SESSION_ID,
      'audio',
      intent,
      USER_ID,
    )).resolves.toBe(false)

    // The same recorder intent must not be revived for a later landmark or
    // duration request after the terminal response crossed the boundary.
    await expect(requestAccountBoundJson(
      '/api/recordings/landmarks',
      { sessionId: SESSION_ID, frames: [] },
      intent,
      USER_ID,
    )).resolves.toBeNull()
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it('cancels the generation when deletion wins after the R2 PUT but before association', async () => {
    const calls: string[] = []
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url
      calls.push(url)
      if (url === '/api/storage/presign') {
        return jsonResponse({
          url: 'https://r2.example/audio',
          key: `recordings/${USER_ID}/${SESSION_ID}-audio-1700000000000.webm`,
          contentType: 'audio/webm',
        })
      }
      if (url === 'https://r2.example/audio') return new Response('', { status: 200 })
      if (url === '/api/recordings/finalize') {
        return jsonResponse({ code: 'ACCOUNT_UNAVAILABLE' }, 401)
      }
      throw new Error(`Unexpected fetch: ${url}`)
    }))

    await expect(uploadRecordingArtifact(
      new Blob(['audio'], { type: 'audio/webm' }),
      SESSION_ID,
      'audio',
      captureReplayUploadIntent(),
      USER_ID,
    )).resolves.toBe(false)
    expect(calls).toEqual([
      '/api/storage/presign',
      'https://r2.example/audio',
      '/api/recordings/finalize',
    ])
  })

  it('turns exact session-changed at finalization into a terminal privacy generation', async () => {
    const intent = captureReplayUploadIntent(USER_ID)
    const calls: string[] = []
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url
      calls.push(url)
      if (url === '/api/storage/presign') {
        return jsonResponse({
          url: 'https://r2.example/audio',
          key: `recordings/${USER_ID}/${SESSION_ID}-audio-1700000000000.webm`,
          contentType: 'audio/webm',
        })
      }
      if (url === 'https://r2.example/audio') return new Response('', { status: 200 })
      if (url === '/api/recordings/finalize') {
        return jsonResponse({
          error: 'sign-in session changed',
          code: 'SESSION_CHANGED',
        }, 409)
      }
      throw new Error(`Unexpected fetch: ${url}`)
    }))

    await expect(uploadRecordingArtifact(
      new Blob(['audio'], { type: 'audio/webm' }),
      SESSION_ID,
      'audio',
      intent,
      USER_ID,
    )).resolves.toBe(false)

    await expect(requestAccountBoundJson(
      '/api/recordings/landmarks',
      { sessionId: SESSION_ID, frames: [] },
      intent,
      USER_ID,
    )).resolves.toBeNull()
    expect(calls).toEqual([
      '/api/storage/presign',
      'https://r2.example/audio',
      '/api/recordings/finalize',
    ])
  })

  it('uses the shared generation and AbortSignal for landmarks and duration PATCH requests', async () => {
    const calls: Array<{ url: string; init?: RequestInit }> = []
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url
      calls.push({ url, init })
      return jsonResponse({ success: true })
    }))
    const intent = captureReplayUploadIntent()

    const landmarks = await requestAccountBoundJson(
      '/api/recordings/landmarks',
      { sessionId: SESSION_ID, frames: [] },
      intent,
      USER_ID,
    )
    const duration = await requestAccountBoundJson(
      `/api/interviews/${SESSION_ID}`,
      { recordingDurationSeconds: 42 },
      intent,
      USER_ID,
      { method: 'PATCH', keepalive: true },
    )

    expect(landmarks?.ok).toBe(true)
    expect(duration?.ok).toBe(true)
    expect(calls[0].init).toMatchObject({ method: 'POST' })
    expect(calls[1].init).toMatchObject({ method: 'PATCH', keepalive: true })
    for (const call of calls) {
      expect(call.init?.headers).toMatchObject({ 'x-origin-user-id': USER_ID })
      expect(call.init?.signal).toBeInstanceOf(AbortSignal)
    }
  })

  it('bounds one JSON request without treating its timeout as a privacy cancellation', async () => {
    vi.useFakeTimers()
    let requestSignal: AbortSignal | undefined
    vi.stubGlobal('fetch', vi.fn((_input: RequestInfo | URL, init?: RequestInit) => {
      requestSignal = init?.signal ?? undefined
      return new Promise<Response>((_resolve, reject) => {
        requestSignal?.addEventListener('abort', () => reject(new Error('request timed out')), {
          once: true,
        })
      })
    }))

    const request = requestAccountBoundJson(
      '/api/hire-engine/multimodal-analysis/capture',
      { sessionId: SESSION_ID, frames: [] },
      captureReplayUploadIntent(USER_ID),
      USER_ID,
      { timeoutMs: 25 },
    )
    const rejected = expect(request).rejects.toThrow('request timed out')
    await vi.advanceTimersByTimeAsync(25)

    await rejected
    expect(requestSignal?.aborted).toBe(true)
  })

  it('cancels landmark work only for exact 401 ACCOUNT_UNAVAILABLE', async () => {
    const intent = captureReplayUploadIntent()
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(jsonResponse({ error: 'Unauthorized' }, 401))
      .mockResolvedValueOnce(jsonResponse({ success: true }))
    vi.stubGlobal('fetch', fetchMock)

    const generic401 = await requestAccountBoundJson(
      '/api/recordings/landmarks',
      { sessionId: SESSION_ID, frames: [] },
      intent,
      USER_ID,
    )
    const subsequent = await requestAccountBoundJson(
      '/api/recordings/landmarks',
      { sessionId: SESSION_ID, frames: [] },
      intent,
      USER_ID,
    )

    expect(generic401?.status).toBe(401)
    expect(subsequent?.ok).toBe(true)
    expect(fetchMock).toHaveBeenCalledTimes(2)
  })
})
