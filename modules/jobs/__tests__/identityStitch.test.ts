import { describe, it, expect, vi } from 'vitest'

const { mockUpdateMany, mockWithActiveJobsAccountWrite, mockDbSession } = vi.hoisted(() => ({
  mockUpdateMany: vi.fn(),
  mockWithActiveJobsAccountWrite: vi.fn(),
  mockDbSession: { id: 'jobs-account-session' },
}))
vi.mock('@shared/db/models', () => ({ ProductEvent: { updateMany: mockUpdateMany } }))
vi.mock('@shared/services/jobsAccountFence', () => ({
  JobsAccountInactiveError: class JobsAccountInactiveError extends Error {},
  withActiveJobsAccountWrite: mockWithActiveJobsAccountWrite,
}))

import { stitchAnonEventsToUser } from '../services/identityStitch'

describe('stitchAnonEventsToUser (anon→user backfill)', () => {
  it('backfills only rows still missing a userId — idempotent by query shape', async () => {
    mockUpdateMany.mockClear()
    mockWithActiveJobsAccountWrite.mockReset().mockImplementation(
      async (_userId: string, work: (session: unknown) => Promise<unknown>) => work(mockDbSession),
    )
    mockUpdateMany.mockImplementation(() => Promise.resolve({ modifiedCount: 7 }))
    const n = await stitchAnonEventsToUser('anon-1', 'user-1')
    expect(n).toBe(7)
    expect(mockUpdateMany).toHaveBeenCalledWith(
      { anonId: 'anon-1', userId: { $exists: false } },
      { $set: { userId: 'user-1' } },
      { session: mockDbSession },
    )
    expect(mockWithActiveJobsAccountWrite).toHaveBeenCalledWith('user-1', expect.any(Function))
  })

  it('never throws — telemetry stitching cannot break a flow', async () => {
    mockUpdateMany.mockClear()
    mockWithActiveJobsAccountWrite.mockReset().mockImplementation(
      async (_userId: string, work: (session: unknown) => Promise<unknown>) => work(mockDbSession),
    )
    mockUpdateMany.mockImplementation(() => Promise.reject(new Error('mongo down')))
    let result: number | null = null
    let threw: unknown = null
    try {
      result = await stitchAnonEventsToUser('anon-1', 'user-1')
    } catch (e) {
      threw = e
    }
    expect(threw).toBeNull()
    expect(result).toBe(0)
  })

  it('does not recreate telemetry when the account fence rejects the writer', async () => {
    mockUpdateMany.mockClear()
    mockWithActiveJobsAccountWrite.mockReset().mockRejectedValue(new Error('account deleting'))

    expect(await stitchAnonEventsToUser('anon-1', 'user-1')).toBe(0)
    expect(mockUpdateMany).not.toHaveBeenCalled()
  })
})
