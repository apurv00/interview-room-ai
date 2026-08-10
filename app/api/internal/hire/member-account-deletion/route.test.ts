import { beforeEach, describe, expect, it, vi } from 'vitest'
import { NextRequest } from 'next/server'
import { AppError } from '@shared/errors'

const mocks = vi.hoisted(() => ({
  verify: vi.fn(),
  preflight: vi.fn(),
  commit: vi.fn(),
}))

vi.mock('@shared/services/internalServiceAuth', () => ({
  verifyInternalServiceRequest: (...args: unknown[]) => mocks.verify(...args),
}))

vi.mock('@hire/services/memberLifecycleService', async () => {
  const actual = await vi.importActual<typeof import('@hire/services/memberLifecycleService')>(
    '@hire/services/memberLifecycleService',
  )
  return {
    ...actual,
    preflightLinkedB2CAccountDeletion: (...args: unknown[]) => mocks.preflight(...args),
    commitLinkedB2CAccountDeletion: (...args: unknown[]) => mocks.commit(...args),
  }
})

import { POST } from './route'

const BASE = {
  schemaVersion: 1,
  b2cUserId: '507f1f77bcf86cd799439011',
  operationId: '123e4567-e89b-42d3-a456-426614174000',
}

function request(body: Record<string, unknown>) {
  return new NextRequest(
    'https://hire.interviewprep.guru/api/internal/hire/member-account-deletion',
    { method: 'POST', body: JSON.stringify(body) },
  )
}

beforeEach(() => {
  vi.clearAllMocks()
  mocks.verify.mockResolvedValue({ ok: true, keyId: 'current' })
})

describe('POST /api/internal/hire/member-account-deletion', () => {
  it('runs a read-only preflight through the authenticated versioned contract', async () => {
    mocks.preflight.mockResolvedValue({ action: 'member_removal_required' })

    const response = await POST(request({ ...BASE, phase: 'preflight' }))

    expect(response.status).toBe(200)
    expect(response.headers.get('cache-control')).toBe('private, no-store')
    await expect(response.json()).resolves.toEqual({
      ok: true,
      action: 'member_removal_required',
    })
    expect(mocks.preflight).toHaveBeenCalledWith({ ...BASE, phase: 'preflight' })
    expect(mocks.commit).not.toHaveBeenCalled()
  })

  it('dispatches a commit and serializes the workspace purge deadline', async () => {
    mocks.commit.mockResolvedValue({
      action: 'workspace_deletion_scheduled',
      purgeAfter: new Date('2026-09-09T00:00:00.000Z'),
    })

    const response = await POST(request({
      ...BASE,
      phase: 'commit',
      workspaceConfirmationName: 'Acme Hiring',
      acknowledgeWorkspaceDeletion: true,
    }))

    expect(response.status).toBe(200)
    await expect(response.json()).resolves.toEqual({
      ok: true,
      action: 'workspace_deletion_scheduled',
      purgeAfter: '2026-09-09T00:00:00.000Z',
    })
  })

  it('rejects email-bearing or otherwise extended identity payloads', async () => {
    const response = await POST(request({
      ...BASE,
      phase: 'preflight',
      email: 'candidate@example.com',
    }))

    expect(response.status).toBe(400)
    expect(mocks.preflight).not.toHaveBeenCalled()
    expect(mocks.commit).not.toHaveBeenCalled()
  })

  it('fails closed before lifecycle work when service authentication fails', async () => {
    mocks.verify.mockResolvedValue({ ok: false, reason: 'invalid-signature' })

    const response = await POST(request({ ...BASE, phase: 'preflight' }))

    expect(response.status).toBe(401)
    expect(mocks.preflight).not.toHaveBeenCalled()
    expect(mocks.commit).not.toHaveBeenCalled()
  })

  it('maps a concurrent transfer requirement to the bridge gate contract', async () => {
    mocks.commit.mockRejectedValue(
      new AppError('Transfer administrator access first', 409, 'HIRE_ADMIN_TRANSFER_REQUIRED'),
    )

    const response = await POST(request({ ...BASE, phase: 'commit' }))

    expect(response.status).toBe(409)
    await expect(response.json()).resolves.toEqual({
      ok: false,
      code: 'HIRE_ADMIN_TRANSFER_REQUIRED',
      error: 'Transfer administrator access first',
    })
  })
})
