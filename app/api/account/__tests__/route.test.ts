import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => {
  class AccountDeletionForbiddenError extends Error {}
  class AccountDeletionNotFoundError extends Error {}
  class AccountDeletionIncompleteError extends Error {
    constructor(public readonly failedCollections: string[]) {
      super(`Account deletion is incomplete: ${failedCollections.join(', ')}`)
    }
  }

  return {
    AccountDeletionForbiddenError,
    AccountDeletionNotFoundError,
    AccountDeletionIncompleteError,
    getServerSession: vi.fn(),
    deleteUserAccount: vi.fn(),
    loggerError: vi.fn(),
  }
})

vi.mock('next-auth', () => ({ getServerSession: mocks.getServerSession }))
vi.mock('@shared/auth/authOptions', () => ({ authOptions: {} }))
vi.mock('@shared/services/accountDeletion', () => ({
  AccountDeletionForbiddenError: mocks.AccountDeletionForbiddenError,
  AccountDeletionNotFoundError: mocks.AccountDeletionNotFoundError,
  AccountDeletionIncompleteError: mocks.AccountDeletionIncompleteError,
  deleteUserAccount: mocks.deleteUserAccount,
}))
vi.mock('@shared/logger', () => ({
  logger: { error: mocks.loggerError },
}))

import { DELETE } from '../route'

const USER_ID = '507f1f77bcf86cd799439011'

beforeEach(() => {
  vi.clearAllMocks()
  mocks.getServerSession.mockResolvedValue({ user: { id: USER_ID } })
})

describe('DELETE /api/account', () => {
  it('returns the completed deletion result', async () => {
    const result = {
      userId: USER_ID,
      email: 'user@example.com',
      collectionsCleared: { User: 1 },
      r2KeysDeleted: 2,
      r2KeysFailed: 0,
    }
    mocks.deleteUserAccount.mockResolvedValue(result)

    const response = await DELETE()

    expect(response.status).toBe(200)
    await expect(response.json()).resolves.toEqual({ ok: true, ...result })
    expect(mocks.deleteUserAccount).toHaveBeenCalledWith(USER_ID)
    expect(mocks.loggerError).not.toHaveBeenCalled()
  })

  it('rejects an unauthenticated request before deletion work', async () => {
    mocks.getServerSession.mockResolvedValue(null)

    const response = await DELETE()

    expect(response.status).toBe(401)
    await expect(response.json()).resolves.toEqual({ error: 'Unauthorized' })
    expect(mocks.deleteUserAccount).not.toHaveBeenCalled()
    expect(mocks.loggerError).not.toHaveBeenCalled()
  })

  it('returns a distinct retryable service response when deletion is incomplete', async () => {
    const failure = new mocks.AccountDeletionIncompleteError([
      'UsageRecord',
      'UsageBuffer',
    ])
    mocks.deleteUserAccount.mockRejectedValue(failure)

    const response = await DELETE()

    expect(response.status).toBe(503)
    expect(response.headers.get('Retry-After')).toBeNull()
    await expect(response.json()).resolves.toEqual({
      error: 'We started deleting your account but could not finish. Please try again or contact support.',
      code: 'ACCOUNT_DELETION_INCOMPLETE',
    })
    expect(mocks.loggerError).toHaveBeenCalledWith(
      {
        err: failure,
        event: 'account_deletion_incomplete',
        code: 'ACCOUNT_DELETION_INCOMPLETE',
        userId: USER_ID,
        failedCollections: ['UsageRecord', 'UsageBuffer'],
      },
      'Account deletion incomplete',
    )
  })

  it('treats a verified compensating retry as idempotently deleted', async () => {
    mocks.deleteUserAccount.mockResolvedValue({
      userId: USER_ID,
      email: '',
      collectionsCleared: { JobApplication: 0 },
      r2KeysDeleted: 0,
      r2KeysFailed: 0,
      alreadyDeleted: true,
    })

    const response = await DELETE()

    expect(response.status).toBe(200)
    await expect(response.json()).resolves.toMatchObject({
      ok: true,
      alreadyDeleted: true,
    })
    expect(mocks.loggerError).not.toHaveBeenCalled()
  })

  it('does not claim success when missing-user cleanup is unverified', async () => {
    const failure = new mocks.AccountDeletionNotFoundError()
    mocks.deleteUserAccount.mockRejectedValue(failure)

    const response = await DELETE()

    expect(response.status).toBe(503)
    await expect(response.json()).resolves.toMatchObject({
      code: 'ACCOUNT_DELETION_UNVERIFIED',
    })
    expect(mocks.loggerError).toHaveBeenCalledWith(
      expect.objectContaining({
        err: failure,
        event: 'account_deletion_unverified_missing_user',
        userId: USER_ID,
      }),
      'Account deletion could not be verified after User disappeared',
    )
  })

  it('keeps unexpected failures on the generic 500 path', async () => {
    const failure = new Error('Mongo unavailable')
    mocks.deleteUserAccount.mockRejectedValue(failure)

    const response = await DELETE()

    expect(response.status).toBe(500)
    await expect(response.json()).resolves.toEqual({
      error: 'Failed to delete account. Please try again or contact support.',
    })
    expect(mocks.loggerError).toHaveBeenCalledWith(
      { err: failure, userId: USER_ID },
      'Account deletion failed',
    )
  })
})
