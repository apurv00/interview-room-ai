import { beforeEach, describe, expect, it, vi } from 'vitest'
import { NextRequest } from 'next/server'

const mocks = vi.hoisted(() => ({
  getServerSession: vi.fn(),
  requireWorkspace: vi.fn(),
  capture: vi.fn(),
}))

vi.mock('next-auth', () => ({ getServerSession: mocks.getServerSession }))
vi.mock('@shared/auth/authOptions', () => ({ authOptions: {} }))
vi.mock('@modules/hire-runtime/services/runtimeTenantScope', () => ({
  requireRuntimeWorkspaceId: mocks.requireWorkspace,
}))
vi.mock('@modules/hire-runtime/services/multimodalObservationCaptureService', async () => {
  const actual = await vi.importActual<
    typeof import('@modules/hire-runtime/services/multimodalObservationCaptureService')
  >('@modules/hire-runtime/services/multimodalObservationCaptureService')
  return { ...actual, captureHireRuntimeMultimodalObservation: mocks.capture }
})

import { POST } from '../route'

const WORKSPACE_ID = '1'.repeat(24)
const PRINCIPAL_ID = '2'.repeat(24)
const SESSION_ID = '3'.repeat(24)
const FENCE_SECRET = 'f'.repeat(64)

function request(
  body: Record<string, unknown>,
  headers: Record<string, string> = {},
): NextRequest {
  return new NextRequest(
    'https://hire-runtime.test/api/hire-engine/multimodal-observations/capture',
    {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...headers },
      body: JSON.stringify(body),
    },
  )
}

const capture = {
  sessionId: SESSION_ID,
  cameraSamples: [],
  browserVisibility: { available: false, hiddenSpans: [] },
}

beforeEach(() => {
  vi.clearAllMocks()
  vi.stubEnv('HIRE_RUNTIME_FENCE_SECRET', FENCE_SECRET)
  mocks.getServerSession.mockResolvedValue({
    user: { id: PRINCIPAL_ID, organizationId: WORKSPACE_ID },
  })
  mocks.requireWorkspace.mockReturnValue(WORKSPACE_ID)
  mocks.capture.mockResolvedValue('accepted')
})

describe('POST /api/hire-engine/multimodal-observations/capture', () => {
  it('does not expose a direct browser-write path outside the signed runtime fence', async () => {
    const response = await POST(request(capture))

    expect(response.status).toBe(404)
    expect(mocks.capture).not.toHaveBeenCalled()
  })

  it('rejects a stale principal header after the fence authenticated the request', async () => {
    const response = await POST(request(capture, {
      'x-ipg-hire-runtime-fence-bypass': FENCE_SECRET,
      'x-origin-user-id': '4'.repeat(24),
    }))

    expect(response.status).toBe(409)
    expect(mocks.capture).not.toHaveBeenCalled()
  })

  it('accepts only bounded capture input from the fence-bound runtime principal', async () => {
    const response = await POST(request(capture, {
      'x-ipg-hire-runtime-fence-bypass': FENCE_SECRET,
      'x-origin-user-id': PRINCIPAL_ID,
    }))

    expect(response.status).toBe(200)
    expect(response.headers.get('cache-control')).toBe('private, no-store')
    await expect(response.json()).resolves.toEqual({ accepted: true })
    expect(mocks.capture).toHaveBeenCalledWith({
      workspaceId: WORKSPACE_ID,
      principalId: PRINCIPAL_ID,
      capture,
    })
  })

  it('rejects unbounded or malformed browser input before the capture service', async () => {
    const response = await POST(request({
      ...capture,
      cameraSamples: [{ atMs: 0, gazeX: 20, gazeY: 0, headYaw: 0, headPitch: 0 }],
    }, {
      'x-ipg-hire-runtime-fence-bypass': FENCE_SECRET,
      'x-origin-user-id': PRINCIPAL_ID,
    }))

    expect(response.status).toBe(400)
    expect(mocks.capture).not.toHaveBeenCalled()
  })
})
