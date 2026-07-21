import { beforeEach, describe, expect, it, vi } from 'vitest'

const {
  mockObjectIdIsValid,
  mockUserExists,
  mockUserDistinct,
  mockUserUpdateOne,
  mockStartSession,
  mockWithTransaction,
  mockEndSession,
  transactionSession,
} = vi.hoisted(() => {
  const mockWithTransaction = vi.fn()
  const mockEndSession = vi.fn()
  const transactionSession = {
    withTransaction: mockWithTransaction,
    endSession: mockEndSession,
  }
  return {
    mockObjectIdIsValid: vi.fn(),
    mockUserExists: vi.fn(),
    mockUserDistinct: vi.fn(),
    mockUserUpdateOne: vi.fn(),
    mockStartSession: vi.fn(),
    mockWithTransaction,
    mockEndSession,
    transactionSession,
  }
})

vi.mock('mongoose', () => ({
  default: {
    Types: { ObjectId: { isValid: mockObjectIdIsValid } },
  },
}))

vi.mock('@shared/db/models', () => ({
  User: {
    exists: mockUserExists,
    distinct: mockUserDistinct,
    updateOne: mockUserUpdateOne,
    db: { startSession: mockStartSession },
  },
}))

import {
  JobsAccountInactiveError,
  JobsAccountTransactionsRequiredError,
  activeJobsAccountIds,
  activeJobsAccountFilter,
  isJobsAccountActive,
  withActiveJobsAccountWrite,
} from '@shared/services/jobsAccountFence'

const USER_ID = '507f1f77bcf86cd799439011'
const OTHER_USER_ID = '507f1f77bcf86cd799439012'

beforeEach(() => {
  vi.resetAllMocks()
  mockObjectIdIsValid.mockReturnValue(true)
  mockUserExists.mockResolvedValue({ _id: USER_ID })
  mockUserDistinct.mockResolvedValue([USER_ID])
  mockUserUpdateOne.mockResolvedValue({ matchedCount: 1 })
  mockStartSession.mockResolvedValue(transactionSession)
  mockWithTransaction.mockImplementation(async (work: () => Promise<void>) => {
    await work()
  })
  mockEndSession.mockResolvedValue(undefined)
})

describe('Jobs account lifecycle predicate', () => {
  it('treats legacy users without accountState as active', () => {
    expect(activeJobsAccountFilter(USER_ID)).toEqual({
      _id: USER_ID,
      $or: [
        { accountState: 'active' },
        { accountState: { $exists: false } },
      ],
    })
  })

  it('rejects malformed stale-token ids without querying Mongo', async () => {
    mockObjectIdIsValid.mockReturnValue(false)

    await expect(isJobsAccountActive('not-an-object-id')).resolves.toBe(false)

    expect(mockUserExists).not.toHaveBeenCalled()
  })

  it('resolves active and legacy owners in one deduplicated query', async () => {
    mockObjectIdIsValid.mockImplementation((id: string) => id !== 'invalid')
    mockUserDistinct.mockResolvedValue([USER_ID, OTHER_USER_ID])

    await expect(activeJobsAccountIds([
      USER_ID,
      USER_ID,
      OTHER_USER_ID,
      'invalid',
    ])).resolves.toEqual(new Set([USER_ID, OTHER_USER_ID]))

    expect(mockUserDistinct).toHaveBeenCalledWith('_id', {
      _id: { $in: [USER_ID, OTHER_USER_ID] },
      $or: [
        { accountState: 'active' },
        { accountState: { $exists: false } },
      ],
    })
  })

  it('excludes missing and deleting owners from the active id set', async () => {
    mockUserDistinct.mockResolvedValue([USER_ID])

    await expect(activeJobsAccountIds([USER_ID, OTHER_USER_ID]))
      .resolves.toEqual(new Set([USER_ID]))
  })
})

describe('withActiveJobsAccountWrite', () => {
  it('wins the lifecycle race by mutating the fence before invoking work in the same transaction', async () => {
    const order: string[] = []
    mockUserUpdateOne.mockImplementation(async () => {
      order.push('writer-fence')
      return { matchedCount: 1 }
    })
    const work = vi.fn(async (receivedSession: typeof transactionSession) => {
      order.push('user-data-write')
      expect(receivedSession).toBe(transactionSession)
      return { created: true }
    })

    await expect(withActiveJobsAccountWrite(USER_ID, work)).resolves.toEqual({
      created: true,
    })

    expect(order).toEqual(['writer-fence', 'user-data-write'])
    expect(mockUserUpdateOne).toHaveBeenCalledWith(
      activeJobsAccountFilter(USER_ID),
      { $inc: { jobsWriteRevision: 1 } },
      { session: transactionSession, timestamps: false },
    )
    expect(mockWithTransaction).toHaveBeenCalledWith(expect.any(Function), {
      readConcern: { level: 'snapshot' },
      writeConcern: { w: 'majority' },
      readPreference: 'primary',
    })
    expect(mockEndSession).toHaveBeenCalledTimes(1)
  })

  it('does not enter user work when the deletion marker wins the lifecycle race', async () => {
    mockUserUpdateOne.mockResolvedValueOnce({ matchedCount: 0 })
    const work = vi.fn()

    await expect(withActiveJobsAccountWrite(USER_ID, work)).rejects.toBeInstanceOf(
      JobsAccountInactiveError,
    )

    expect(work).not.toHaveBeenCalled()
    expect(mockEndSession).toHaveBeenCalledTimes(1)
  })

  it('waits for the lifecycle write-conflict seam before allowing user data creation', async () => {
    let resolveFence!: (value: { matchedCount: number }) => void
    mockUserUpdateOne.mockReturnValueOnce(new Promise((resolve) => {
      resolveFence = resolve
    }))
    const work = vi.fn().mockResolvedValue('stored')

    const write = withActiveJobsAccountWrite(USER_ID, work)
    await vi.waitFor(() => expect(mockUserUpdateOne).toHaveBeenCalledTimes(1))
    expect(work).not.toHaveBeenCalled()

    resolveFence({ matchedCount: 1 })

    await expect(write).resolves.toBe('stored')
    expect(work).toHaveBeenCalledWith(transactionSession)
  })

  it('aborts malformed stale-token ids before opening a transaction', async () => {
    mockObjectIdIsValid.mockReturnValue(false)
    const work = vi.fn()

    await expect(withActiveJobsAccountWrite('invalid-user-id', work)).rejects.toBeInstanceOf(
      JobsAccountInactiveError,
    )

    expect(mockStartSession).not.toHaveBeenCalled()
    expect(work).not.toHaveBeenCalled()
  })

  it('fails closed when MongoDB cannot provide replica-set transactions', async () => {
    mockWithTransaction.mockRejectedValueOnce(Object.assign(
      new Error('Transaction numbers are only allowed on a replica set member or mongos'),
      { code: 20, codeName: 'IllegalOperation' },
    ))

    await expect(withActiveJobsAccountWrite(USER_ID, vi.fn())).rejects.toBeInstanceOf(
      JobsAccountTransactionsRequiredError,
    )

    expect(mockEndSession).toHaveBeenCalledTimes(1)
  })
})
