import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({ createHeaders: vi.fn() }))

vi.mock('../internalServiceAuth', () => ({
  createInternalServiceHeaders: (...args: unknown[]) => mocks.createHeaders(...args),
}))

import {
  HireMemberDeletionBlockedError,
  HireMemberDeletionBridgeUnavailableError,
  commitHireMemberForB2CAccountDeletion,
  preflightHireMemberForB2CAccountDeletion,
} from '../hireMemberDeletionBridgeClient'

const USER_ID = '507f1f77bcf86cd799439011'
const OPERATION_ID = '123e4567-e89b-42d3-a456-426614174000'

beforeEach(() => {
  vi.clearAllMocks()
  mocks.createHeaders.mockReturnValue({ 'x-ipg-signature': 'signed' })
})

afterEach(() => {
  vi.unstubAllEnvs()
  vi.unstubAllGlobals()
})

describe('B2C → Hire member deletion client', () => {
  it('fails closed in production when the Hire control bridge is unconfigured', async () => {
    vi.stubEnv('NODE_ENV', 'production')
    vi.stubEnv('HIRE_CONTROL_INTERNAL_URL', '')
    vi.stubEnv('HIRE_ACCOUNT_BRIDGE_SECRET', '')

    await expect(
      preflightHireMemberForB2CAccountDeletion(USER_ID, { operationId: OPERATION_ID }),
    ).rejects.toBeInstanceOf(HireMemberDeletionBridgeUnavailableError)
  })

  it('uses an opaque B2C id and strict versioned payload without an email', async () => {
    vi.stubEnv('HIRE_CONTROL_INTERNAL_URL', 'https://hire.interviewprep.guru')
    vi.stubEnv('HIRE_ACCOUNT_BRIDGE_SECRET', 's'.repeat(64))
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ ok: true, action: 'member_removal_required' }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
    ))

    const result = await preflightHireMemberForB2CAccountDeletion(USER_ID, {
      operationId: OPERATION_ID,
    })

    expect(result).toEqual({
      operationId: OPERATION_ID,
      result: { ok: true, action: 'member_removal_required' },
    })
    const [url, request] = vi.mocked(fetch).mock.calls[0]
    expect(String(url)).toBe(
      'https://hire.interviewprep.guru/api/internal/hire/member-account-deletion',
    )
    const body = JSON.parse(String(request?.body))
    expect(body).toEqual({
      schemaVersion: 1,
      phase: 'preflight',
      b2cUserId: USER_ID,
      operationId: OPERATION_ID,
    })
    expect(JSON.stringify(body)).not.toMatch(/email/i)
    expect(mocks.createHeaders).toHaveBeenCalledWith(
      expect.objectContaining({
        method: 'POST',
        path: '/api/internal/hire/member-account-deletion',
        body: JSON.stringify(body),
      }),
    )
  })

  it('maps the sole-admin confirmation gate and preserves the workspace name', async () => {
    vi.stubEnv('HIRE_CONTROL_INTERNAL_URL', 'https://hire.interviewprep.guru')
    vi.stubEnv('HIRE_ACCOUNT_BRIDGE_SECRET', 's'.repeat(64))
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(
      new Response(JSON.stringify({
        ok: false,
        code: 'HIRE_WORKSPACE_DELETE_CONFIRMATION_REQUIRED',
        error: 'Confirm workspace deletion',
        workspaceName: 'Acme Hiring',
      }), { status: 409, headers: { 'content-type': 'application/json' } }),
    ))

    const rejection = commitHireMemberForB2CAccountDeletion(USER_ID, {
      operationId: OPERATION_ID,
    })
    await expect(rejection).rejects.toMatchObject({
      code: 'HIRE_WORKSPACE_DELETE_CONFIRMATION_REQUIRED',
      workspaceName: 'Acme Hiring',
    })
    await expect(rejection).rejects.toBeInstanceOf(HireMemberDeletionBlockedError)
  })

  it('rejects malformed success payloads instead of bypassing Hire ownership', async () => {
    vi.stubEnv('HIRE_CONTROL_INTERNAL_URL', 'https://hire.interviewprep.guru')
    vi.stubEnv('HIRE_ACCOUNT_BRIDGE_SECRET', 's'.repeat(64))
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ ok: true, action: 'invented_action' }), { status: 200 }),
    ))

    await expect(
      preflightHireMemberForB2CAccountDeletion(USER_ID, { operationId: OPERATION_ID }),
    ).rejects.toBeInstanceOf(HireMemberDeletionBridgeUnavailableError)
  })

  it('keeps legacy development tests local when the bridge is intentionally absent', async () => {
    vi.stubEnv('NODE_ENV', 'test')
    vi.stubEnv('HIRE_CONTROL_INTERNAL_URL', '')
    vi.stubEnv('HIRE_ACCOUNT_BRIDGE_SECRET', '')

    await expect(
      preflightHireMemberForB2CAccountDeletion(USER_ID, { operationId: OPERATION_ID }),
    ).resolves.toEqual({
      operationId: OPERATION_ID,
      result: { ok: true, action: 'not_linked' },
    })
  })
})
