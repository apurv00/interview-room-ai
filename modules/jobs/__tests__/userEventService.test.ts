import { beforeEach, describe, expect, it, vi } from 'vitest'

const {
  mockProductEventCreate,
  mockWithActiveJobsAccountWrite,
  mockDbSession,
  MockJobsAccountInactiveError,
} = vi.hoisted(() => {
  class MockJobsAccountInactiveError extends Error {}
  return {
    mockProductEventCreate: vi.fn(),
    mockWithActiveJobsAccountWrite: vi.fn(),
    mockDbSession: { id: 'jobs-account-session' },
    MockJobsAccountInactiveError,
  }
})

vi.mock('@shared/db/models', () => ({ ProductEvent: { create: mockProductEventCreate } }))
vi.mock('@shared/services/jobsAccountFence', () => ({
  JobsAccountInactiveError: MockJobsAccountInactiveError,
  withActiveJobsAccountWrite: mockWithActiveJobsAccountWrite,
}))

import { recordJobsUserEvent } from '../services/userEventService'

beforeEach(() => {
  vi.clearAllMocks()
  mockProductEventCreate.mockResolvedValue([])
  mockWithActiveJobsAccountWrite.mockImplementation(
    async (_userId: string, work: (session: unknown) => Promise<unknown>) => work(mockDbSession),
  )
})

describe('recordJobsUserEvent', () => {
  it('writes user-attributed telemetry in the durable account transaction', async () => {
    const input = {
      userId: '507f1f77bcf86cd799439010',
      name: 'jobs.feed_viewed',
      props: { source: 'feed' },
    }

    expect(await recordJobsUserEvent(input)).toBe(true)
    expect(mockProductEventCreate).toHaveBeenCalledWith(
      [input],
      { session: mockDbSession },
    )
  })

  it('returns false and creates nothing when account deletion owns the fence', async () => {
    mockWithActiveJobsAccountWrite.mockRejectedValueOnce(
      new MockJobsAccountInactiveError('account deleting'),
    )

    expect(await recordJobsUserEvent({
      userId: '507f1f77bcf86cd799439010',
      name: 'jobs.feed_viewed',
    })).toBe(false)
    expect(mockProductEventCreate).not.toHaveBeenCalled()
  })
})
