import { beforeEach, describe, expect, it, vi } from 'vitest'

const {
  mockGetServerSession,
  mockConnectDB,
  mockFindOne,
  mockLean,
} = vi.hoisted(() => ({
  mockGetServerSession: vi.fn(),
  mockConnectDB: vi.fn(),
  mockFindOne: vi.fn(),
  mockLean: vi.fn(),
}))

vi.mock('next-auth', () => ({ getServerSession: mockGetServerSession }))
vi.mock('@shared/auth/authOptions', () => ({ authOptions: {} }))
vi.mock('@shared/db/connection', () => ({ connectDB: mockConnectDB }))
vi.mock('@shared/db/models', () => ({
  User: { findOne: mockFindOne },
}))

import { requireCurrentPlatformAdmin } from '../adminAuth'

const ACTOR_ID = '507f1f77bcf86cd799439001'

beforeEach(() => {
  mockGetServerSession.mockReset().mockResolvedValue({ user: { id: ACTOR_ID } })
  mockConnectDB.mockReset().mockResolvedValue(undefined)
  mockLean.mockReset().mockResolvedValue({ _id: ACTOR_ID })
  mockFindOne.mockReset().mockReturnValue({
    select: vi.fn().mockReturnValue({ lean: mockLean }),
  })
})

describe('requireCurrentPlatformAdmin', () => {
  it('rejects an unauthenticated request before connecting to Mongo', async () => {
    mockGetServerSession.mockResolvedValueOnce(null)

    await expect(requireCurrentPlatformAdmin()).resolves.toMatchObject({
      ok: false,
      status: 401,
      code: 'ADMIN_REQUIRED',
    })
    expect(mockConnectDB).not.toHaveBeenCalled()
  })

  it('rejects a malformed actor ID before connecting to Mongo', async () => {
    mockGetServerSession.mockResolvedValueOnce({ user: { id: 'not-an-object-id' } })

    await expect(requireCurrentPlatformAdmin()).resolves.toMatchObject({
      ok: false,
      status: 403,
      code: 'ADMIN_REQUIRED',
    })
    expect(mockConnectDB).not.toHaveBeenCalled()
  })

  it('rechecks both the current database role and active account state', async () => {
    await expect(requireCurrentPlatformAdmin()).resolves.toEqual({
      ok: true,
      actorUserId: ACTOR_ID,
    })

    expect(mockFindOne).toHaveBeenCalledWith({
      _id: ACTOR_ID,
      role: 'platform_admin',
      $or: [
        { accountState: 'active' },
        { accountState: { $exists: false } },
      ],
    })
  })

  it('rejects a demoted, deleting, or missing actor', async () => {
    mockLean.mockResolvedValueOnce(null)

    await expect(requireCurrentPlatformAdmin()).resolves.toMatchObject({
      ok: false,
      status: 403,
      code: 'ADMIN_REQUIRED',
    })
  })

  it('fails closed when the authority lookup is unavailable', async () => {
    mockConnectDB.mockRejectedValueOnce(new Error('mongo unavailable'))

    await expect(requireCurrentPlatformAdmin()).resolves.toMatchObject({
      ok: false,
      status: 503,
      code: 'AUTHORITY_UNAVAILABLE',
      actorUserId: ACTOR_ID,
    })
  })

  it('runs the command abuse gate before the database lookup', async () => {
    const blocked = new Response('limited', { status: 429 })
    const beforeAuthorityLookup = vi.fn().mockResolvedValue(blocked)

    await expect(requireCurrentPlatformAdmin({ beforeAuthorityLookup })).resolves.toMatchObject({
      ok: false,
      status: 429,
      code: 'REQUEST_BLOCKED',
      response: blocked,
    })
    expect(beforeAuthorityLookup).toHaveBeenCalledWith(ACTOR_ID)
    expect(mockConnectDB).not.toHaveBeenCalled()
  })
})
