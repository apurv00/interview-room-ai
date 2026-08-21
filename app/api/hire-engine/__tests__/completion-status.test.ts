import { beforeEach, describe, expect, it, vi } from 'vitest'
import { NextRequest } from 'next/server'
import { HIRE_AI_CONSENT_VERSION } from '@hire/policies/aiInterviewConsent'

const mocks = vi.hoisted(() => ({
  getServerSession: vi.fn(),
  completionBoundary: vi.fn(),
  terminalize: vi.fn(),
  interviewFindOne: vi.fn(),
}))

vi.mock('next-auth', () => ({ getServerSession: mocks.getServerSession }))
vi.mock('@shared/auth/authOptions', () => ({ authOptions: {} }))
vi.mock('@modules/hire-runtime/services/bindingService', async () => {
  const actual = await vi.importActual<
    typeof import('@modules/hire-runtime/services/bindingService')
  >('@modules/hire-runtime/services/bindingService')
  return { ...actual, completionBoundaryForPrincipal: mocks.completionBoundary }
})
vi.mock('@modules/hire-runtime/services/mediaCompletionService', () => ({
  terminalizeRuntimeReplayMedia: mocks.terminalize,
}))
vi.mock('@shared/db/models/InterviewSession', () => ({
  InterviewSession: { findOne: mocks.interviewFindOne },
}))

import { GET, POST } from '../completion-status/route'

const PRINCIPAL_ID = '1'.repeat(24)
const SESSION_ID = '2'.repeat(24)
const WORKSPACE_ID = '3'.repeat(24)

function objectId(value: string) {
  return { toString: () => value }
}

function interviewQuery(result: unknown) {
  const query = {
    select: vi.fn(),
    lean: vi.fn().mockResolvedValue(result),
  }
  query.select.mockReturnValue(query)
  return query
}

function request(body: unknown) {
  return new NextRequest('https://engine.example/api/hire-engine/completion-status', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Origin: 'https://engine.example',
    },
    body: JSON.stringify(body),
  })
}

function binding(overrides: Record<string, unknown> = {}) {
  return {
    _id: objectId('4'.repeat(24)),
    workspaceId: objectId(WORKSPACE_ID),
    principalId: objectId(PRINCIPAL_ID),
    runtimeSessionId: objectId(SESSION_ID),
    status: 'completed',
    consentVersion: HIRE_AI_CONSENT_VERSION,
    mediaCompletionContractVersion: 1,
    cameraMediaStatus: 'published',
    screenMediaStatus: 'published',
    issuedObjectCapabilities: [],
    issuedMultipartCapabilities: [],
    ...overrides,
  }
}

beforeEach(() => {
  vi.clearAllMocks()
  mocks.getServerSession.mockResolvedValue({
    user: { id: PRINCIPAL_ID, organizationId: WORKSPACE_ID },
  })
  mocks.completionBoundary.mockResolvedValue({
    state: 'available',
    binding: binding(),
  })
  mocks.terminalize.mockResolvedValue('recorded')
  mocks.interviewFindOne.mockReturnValue(interviewQuery({
    status: 'completed',
    completedAt: new Date('2026-08-10T10:00:00.000Z'),
  }))
})

describe('GET /api/hire-engine/completion-status', () => {
  it('confirms only the exact workspace-bound principal session', async () => {
    const response = await GET()
    expect(response.status).toBe(200)
    expect(response.headers.get('cache-control')).toBe('private, no-store')
    await expect(response.json()).resolves.toEqual({
      state: 'completed',
      sessionId: SESSION_ID,
      media: { camera: 'published', screen: 'published' },
      degraded: false,
    })
    expect(mocks.completionBoundary).toHaveBeenCalledWith({
      workspaceId: WORKSPACE_ID,
      principalId: PRINCIPAL_ID,
    })
    const filter = mocks.interviewFindOne.mock.calls[0][0]
    expect(filter._id.toString()).toBe(SESSION_ID)
    expect(filter.userId.toString()).toBe(PRINCIPAL_ID)
    expect(filter.organizationId.toString()).toBe(WORKSPACE_ID)
  })

  it('does not claim submission while the bound engine session is incomplete', async () => {
    mocks.interviewFindOne.mockReturnValue(interviewQuery({ status: 'in_progress' }))
    const response = await GET()
    await expect(response.json()).resolves.toEqual({
      state: 'pending',
      reason: 'session',
      sessionId: SESSION_ID,
      media: { camera: 'published', screen: 'published' },
      degraded: false,
    })
  })

  it('treats a missing bound session as pending rather than fabricating completion', async () => {
    mocks.interviewFindOne.mockReturnValue(interviewQuery(null))
    const response = await GET()
    await expect(response.json()).resolves.toEqual({
      state: 'pending',
      reason: 'session',
      sessionId: SESSION_ID,
      media: { camera: 'published', screen: 'published' },
      degraded: false,
    })
  })

  it('does not reveal runtime completion without the host-only session', async () => {
    mocks.getServerSession.mockResolvedValue(null)
    const response = await GET()
    expect(response.status).toBe(401)
    expect(mocks.completionBoundary).not.toHaveBeenCalled()
    expect(mocks.interviewFindOne).not.toHaveBeenCalled()
  })

  it('keeps a versioned completion pending until every required kind is terminal', async () => {
    mocks.completionBoundary.mockResolvedValue({
      state: 'available',
      binding: binding({
        cameraMediaStatus: 'pending',
        screenMediaStatus: 'unavailable',
      }),
    })

    const response = await GET()

    await expect(response.json()).resolves.toEqual({
      state: 'pending',
      reason: 'media',
      sessionId: SESSION_ID,
      media: { camera: 'pending', screen: 'unavailable' },
      degraded: true,
    })
  })

  it('preserves historical completion semantics for bindings without the version marker', async () => {
    mocks.completionBoundary.mockResolvedValue({
      state: 'available',
      binding: binding({
        mediaCompletionContractVersion: undefined,
        cameraMediaStatus: undefined,
        screenMediaStatus: undefined,
      }),
    })

    const response = await GET()

    await expect(response.json()).resolves.toEqual({
      state: 'completed',
      sessionId: SESSION_ID,
      media: { camera: 'legacy_complete', screen: 'legacy_complete' },
      degraded: false,
    })
  })

  it('durably records terminal camera unavailability only after completion', async () => {
    const pending = binding({ cameraMediaStatus: 'pending' })
    const unavailable = binding({
      cameraMediaStatus: 'unavailable',
      cameraMediaUnavailableReason: 'upload_rejected',
    })
    mocks.completionBoundary
      .mockResolvedValueOnce({ state: 'available', binding: pending })
      .mockResolvedValueOnce({ state: 'available', binding: unavailable })

    const response = await POST(request({
      action: 'mark-unavailable',
      sessionId: SESSION_ID,
      kind: 'camera',
      reason: 'upload_rejected',
    }))

    expect(response.status).toBe(200)
    expect(mocks.terminalize).toHaveBeenCalledWith({
      binding: pending,
      kind: 'camera',
      reason: 'upload_rejected',
    })
    await expect(response.json()).resolves.toMatchObject({
      recorded: true,
      state: 'completed',
      degraded: true,
      media: { camera: 'unavailable', screen: 'published' },
    })
  })

  it('refuses terminal unavailability while multipart finalization is held', async () => {
    mocks.completionBoundary.mockResolvedValue({
      state: 'available',
      binding: binding({
      cameraMediaStatus: 'pending',
      issuedMultipartCapabilities: [{
        key: `recordings/${PRINCIPAL_ID}/${SESSION_ID}-1700000000000.webm`,
        runtimeSessionId: objectId(SESSION_ID),
        uploadId: 'held-upload',
        expiresAt: new Date(Date.now() + 60_000),
      }],
      }),
    })
    mocks.terminalize.mockResolvedValueOnce('in_flight')

    const response = await POST(request({
      action: 'mark-unavailable',
      sessionId: SESSION_ID,
      kind: 'camera',
      reason: 'retry_exhausted',
    }))

    expect(response.status).toBe(409)
    await expect(response.json()).resolves.toMatchObject({
      code: 'MEDIA_WRITE_IN_FLIGHT',
    })
    expect(mocks.terminalize).toHaveBeenCalledOnce()
  })

  it('refuses to replace an associated recording with weaker unavailable evidence', async () => {
    mocks.completionBoundary.mockResolvedValue({
      state: 'available',
      binding: binding({ cameraMediaStatus: 'pending' }),
    })
    mocks.terminalize.mockResolvedValueOnce('in_flight')
    mocks.interviewFindOne.mockReturnValue(interviewQuery({
      status: 'completed',
      recordingR2Key: `recordings/${PRINCIPAL_ID}/${SESSION_ID}-1700000000000.webm`,
      recordingSizeBytes: 1024,
    }))

    const response = await POST(request({
      action: 'mark-unavailable',
      sessionId: SESSION_ID,
      kind: 'camera',
      reason: 'upload_rejected',
    }))

    expect(response.status).toBe(409)
    await expect(response.json()).resolves.toMatchObject({
      code: 'MEDIA_WRITE_IN_FLIGHT',
    })
    expect(mocks.terminalize).toHaveBeenCalledOnce()
  })

  it('rejects an unsafe POST without the exact runtime Origin', async () => {
    const unsafe = new NextRequest(
      'https://engine.example/api/hire-engine/completion-status',
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Origin: 'https://evil.example',
        },
        body: JSON.stringify({
          action: 'mark-unavailable',
          sessionId: SESSION_ID,
          kind: 'camera',
          reason: 'capture_failed',
        }),
      },
    )

    const response = await POST(unsafe)

    expect(response.status).toBe(403)
    expect(mocks.completionBoundary).not.toHaveBeenCalled()
    expect(mocks.terminalize).not.toHaveBeenCalled()
  })

  it.each(['revoked', 'purging'] as const)(
    'returns a privacy-terminal completion boundary while the account is %s',
    async (reason) => {
      mocks.completionBoundary.mockResolvedValueOnce({
        state: 'account_unavailable',
        reason,
      })

      const response = await GET()

      expect(response.status).toBe(410)
      await expect(response.json()).resolves.toEqual({
        state: 'account_unavailable',
        reason,
        code: 'ACCOUNT_UNAVAILABLE',
      })
    },
  )
})
