import { beforeEach, describe, expect, it, vi } from 'vitest'
import { NextRequest } from 'next/server'

const mocks = vi.hoisted(() => ({
  getServerSession: vi.fn(),
  claim: vi.fn(),
  recordStorage: vi.fn(),
  settleMultipart: vi.fn(),
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
  }
})

import { POST } from '../write-fence/route'

const WORKSPACE_ID = '1'.repeat(24)
const APPLICATION_ID = '2'.repeat(24)
const ROUND_ID = '3'.repeat(24)
const PRINCIPAL_ID = '4'.repeat(24)
const SESSION_ID = '5'.repeat(24)
const FOREIGN_SESSION_ID = '6'.repeat(24)
const BINDING_ID = '7'.repeat(24)

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

function request(pathname: string, body: Record<string, unknown>): NextRequest {
  const url = new URL('http://engine.test/api/hire-engine/write-fence')
  url.searchParams.set('__runtime_target', pathname)
  return new NextRequest(url, {
    method: 'POST',
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
})
