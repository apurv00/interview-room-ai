import { beforeEach, describe, expect, it, vi } from 'vitest'
import { NextRequest } from 'next/server'

const mocks = vi.hoisted(() => ({
  getServerSession: vi.fn(),
  claim: vi.fn(),
  recordStorage: vi.fn(),
  settleMultipart: vi.fn(),
  reserveReplay: vi.fn(),
  releaseReplay: vi.fn(),
  fetch: vi.fn(),
}))

vi.mock('next-auth', () => ({ getServerSession: mocks.getServerSession }))
vi.mock('@shared/auth/authOptions', () => ({ authOptions: {} }))
vi.mock('@modules/hire-runtime/services/runtimeWriteFence', async () => {
  const actual = await vi.importActual<
    typeof import('@modules/hire-runtime/services/runtimeWriteFence')
  >('@modules/hire-runtime/services/runtimeWriteFence')
  return {
    ...actual,
    claimRuntimeWriteCapability: mocks.claim,
    recordRuntimeStorageCapability: mocks.recordStorage,
    settleRuntimeMultipartCapability: mocks.settleMultipart,
    reserveRuntimeReplayWrites: mocks.reserveReplay,
    releaseRuntimeReplayWriteReservations: mocks.releaseReplay,
  }
})

import { RuntimeWriteFenceError } from '@modules/hire-runtime/services/runtimeWriteFence'
import { PATCH, POST } from '../write-fence/route'

const WORKSPACE_ID = '1'.repeat(24)
const APPLICATION_ID = '2'.repeat(24)
const ROUND_ID = '3'.repeat(24)
const PRINCIPAL_ID = '4'.repeat(24)
const SESSION_ID = '5'.repeat(24)
const FOREIGN_SESSION_ID = '6'.repeat(24)
const BINDING_ID = '7'.repeat(24)
const CAMERA_KEY = `recordings/${PRINCIPAL_ID}/${SESSION_ID}-1723248000000.webm`

function objectId(value: string) {
  return { toString: () => value }
}

function binding() {
  return {
    _id: objectId(BINDING_ID),
    status: 'active',
    workspaceId: objectId(WORKSPACE_ID),
    applicationId: objectId(APPLICATION_ID),
    roundId: objectId(ROUND_ID),
    principalId: objectId(PRINCIPAL_ID),
    runtimeSessionId: objectId(SESSION_ID),
  }
}

function request(
  pathname: string,
  body: Record<string, unknown>,
  method = 'POST',
): NextRequest {
  const url = new URL('http://engine.test/api/hire-engine/write-fence')
  url.searchParams.set('__runtime_target', pathname)
  return new NextRequest(url, {
    method,
    headers: {
      'content-type': 'application/json',
      'x-origin-user-id': FOREIGN_SESSION_ID,
    },
    body: JSON.stringify(body),
  })
}

beforeEach(() => {
  vi.clearAllMocks()
  vi.stubEnv('HIRE_RUNTIME_FENCE_SECRET', 'f'.repeat(64))
  vi.stubEnv('NEXTAUTH_URL', 'http://engine.test')
  mocks.getServerSession.mockResolvedValue({
    user: { id: PRINCIPAL_ID, organizationId: WORKSPACE_ID },
  })
  mocks.claim.mockResolvedValue(binding())
  mocks.reserveReplay.mockResolvedValue([])
  mocks.releaseReplay.mockResolvedValue(undefined)
  mocks.fetch.mockResolvedValue(new Response(JSON.stringify({ ok: true }), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  }))
  vi.stubGlobal('fetch', mocks.fetch)
})

describe('POST /api/hire-engine/write-fence', () => {
  it('rejects a foreign engine session before the unchanged route is invoked', async () => {
    const response = await POST(request(
      '/api/interview/clarify-coding',
      { sessionId: FOREIGN_SESSION_ID, problemId: 'two-sum' },
    ))

    expect(response.status).toBe(404)
    expect(response.headers.get('cache-control')).toBe('no-store')
    expect(mocks.fetch).not.toHaveBeenCalled()
  })

  it('forwards a bound request with an authoritative signed-principal header', async () => {
    const response = await POST(request(
      '/api/generate-feedback',
      { sessionId: SESSION_ID, transcript: [] },
    ))

    expect(response.status).toBe(200)
    expect(mocks.fetch).toHaveBeenCalledTimes(1)
    const [target, init] = mocks.fetch.mock.calls[0] as [URL, RequestInit]
    expect(target.pathname).toBe('/api/generate-feedback')
    expect(new Headers(init.headers).get('x-origin-user-id')).toBe(PRINCIPAL_ID)
    expect(new Headers(init.headers).get('x-ipg-hire-runtime-fence-bypass')).toBe(
      'f'.repeat(64),
    )
  })

  it('forwards the exact bound PATCH method and JSON bytes to the unchanged session route', async () => {
    const body = {
      status: 'in_progress',
      startedAt: '2026-08-10T10:00:00.000Z',
    }
    const response = await PATCH(request(
      `/api/interviews/${SESSION_ID}`,
      body,
      'PATCH',
    ))

    expect(response.status).toBe(200)
    const [target, init] = mocks.fetch.mock.calls[0] as [URL, RequestInit]
    expect(target.pathname).toBe(`/api/interviews/${SESSION_ID}`)
    expect(init.method).toBe('PATCH')
    expect(JSON.parse(new TextDecoder().decode(init.body as Uint8Array))).toEqual(body)
  })

  it('routes admitted TTS bytes directly to the runtime-owned endpoint', async () => {
    const body = { text: 'Short interviewer prompt', voice: 'indian' }
    const response = await POST(request('/api/tts', body))

    expect(response.status).toBe(200)
    const [target, init] = mocks.fetch.mock.calls[0] as [URL, RequestInit]
    expect(target.pathname).toBe('/api/hire-engine/tts')
    expect(JSON.parse(new TextDecoder().decode(init.body as Uint8Array))).toEqual(body)
  })

  it('forwards only a pending replay upload after the result is published', async () => {
    mocks.claim.mockResolvedValueOnce({
      ...binding(),
      status: 'completed',
      consentVersion: 'hire-ai-v6-2026-08-20',
      publishedRevision: 1,
      cameraMediaStatus: 'pending',
      mediaCompletionContractVersion: 1,
    })
    mocks.fetch.mockResolvedValueOnce(new Response(JSON.stringify({
      url: 'https://upload.invalid',
      key: CAMERA_KEY,
      contentType: 'video/webm',
    }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    }))

    const response = await POST(request('/api/storage/presign', {
      action: 'upload',
      type: 'recording',
      sessionId: SESSION_ID,
    }))

    expect(response.status).toBe(200)
    expect(mocks.fetch).toHaveBeenCalledOnce()
    expect(mocks.recordStorage).toHaveBeenCalledWith(expect.objectContaining({
      bindingId: BINDING_ID,
      runtimeSessionId: SESSION_ID,
      key: CAMERA_KEY,
    }))
    expect(mocks.reserveReplay).toHaveBeenCalledWith({
      workspaceId: WORKSPACE_ID,
      bindingId: BINDING_ID,
      principalId: PRINCIPAL_ID,
      runtimeSessionId: SESSION_ID,
      kinds: ['camera'],
    })
  })

  it('reserves a replay kind before side effects and releases only after capability capture', async () => {
    const events: string[] = []
    mocks.claim.mockResolvedValueOnce({
      ...binding(),
      consentVersion: 'hire-ai-v6-2026-08-20',
      mediaCompletionContractVersion: 1,
      cameraMediaStatus: 'pending',
    })
    mocks.reserveReplay.mockImplementationOnce(async () => {
      events.push('reserve')
      return [{ reservationId: 'reservation', kind: 'camera' }]
    })
    mocks.fetch.mockImplementationOnce(async () => {
      events.push('upstream')
      return new Response(JSON.stringify({
        key: CAMERA_KEY,
        uploadId: 'upload-id',
        contentType: 'video/webm',
        partSizeBytes: 8 * 1024 * 1024,
      }), { status: 200, headers: { 'content-type': 'application/json' } })
    })
    mocks.recordStorage.mockImplementationOnce(async () => {
      events.push('capability')
    })
    mocks.releaseReplay.mockImplementationOnce(async () => {
      events.push('release')
    })

    const response = await POST(request('/api/storage/multipart', {
      action: 'create',
      type: 'recording',
      sessionId: SESSION_ID,
    }))

    expect(response.status).toBe(200)
    expect(events).toEqual(['reserve', 'upstream', 'capability', 'release'])
  })

  it('does not reach R2 when terminalization wins before reservation', async () => {
    mocks.claim.mockResolvedValueOnce({
      ...binding(),
      consentVersion: 'hire-ai-v6-2026-08-20',
      mediaCompletionContractVersion: 1,
      cameraMediaStatus: 'pending',
    })
    mocks.reserveReplay.mockRejectedValueOnce(
      new RuntimeWriteFenceError('terminalizing', 410, 'MEDIA_TERMINAL'),
    )

    const response = await POST(request('/api/storage/multipart', {
      action: 'create',
      type: 'recording',
      sessionId: SESSION_ID,
    }))

    expect(response.status).toBe(410)
    await expect(response.json()).resolves.toEqual({
      error: 'Runtime unavailable',
      code: 'MEDIA_TERMINAL',
    })
    expect(mocks.fetch).not.toHaveBeenCalled()
    expect(mocks.releaseReplay).not.toHaveBeenCalled()
  })

  it('exposes an exact account-unavailable boundary without forwarding', async () => {
    mocks.claim.mockRejectedValueOnce(
      new RuntimeWriteFenceError('purged', 410, 'ACCOUNT_UNAVAILABLE'),
    )

    const response = await POST(request('/api/storage/multipart', {
      action: 'create',
      type: 'recording',
      sessionId: SESSION_ID,
    }))

    expect(response.status).toBe(410)
    await expect(response.json()).resolves.toEqual({
      error: 'Runtime unavailable',
      code: 'ACCOUNT_UNAVAILABLE',
    })
    expect(mocks.fetch).not.toHaveBeenCalled()
  })

  it('does not forward interview work after the result is published', async () => {
    mocks.claim.mockResolvedValueOnce({
      ...binding(),
      status: 'completed',
      consentVersion: 'hire-ai-v6-2026-08-20',
      publishedRevision: 1,
      cameraMediaStatus: 'pending',
    })

    const response = await POST(request(
      '/api/generate-feedback',
      { sessionId: SESSION_ID, transcript: [] },
    ))

    expect(response.status).toBe(410)
    expect(mocks.fetch).not.toHaveBeenCalled()
  })

  it('forwards the Hire-native observation capture only after binding its session', async () => {
    const body = {
      sessionId: SESSION_ID,
      cameraSamples: [],
      browserVisibility: { available: false, hiddenSpans: [] },
    }
    const response = await POST(request(
      '/api/hire-engine/multimodal-observations/capture',
      body,
    ))

    expect(response.status).toBe(200)
    const [target, init] = mocks.fetch.mock.calls[0] as [URL, RequestInit]
    expect(target.pathname).toBe('/api/hire-engine/multimodal-observations/capture')
    expect(JSON.parse(new TextDecoder().decode(init.body as Uint8Array))).toEqual(body)
  })
})
