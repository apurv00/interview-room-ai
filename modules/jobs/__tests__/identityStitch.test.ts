import { describe, it, expect, vi } from 'vitest'

const { mockUpdateMany } = vi.hoisted(() => ({ mockUpdateMany: vi.fn() }))
vi.mock('@shared/db/models', () => ({ ProductEvent: { updateMany: mockUpdateMany } }))

import { stitchAnonEventsToUser } from '../services/identityStitch'

describe('stitchAnonEventsToUser (anon→user backfill)', () => {
  it('backfills only rows still missing a userId — idempotent by query shape', async () => {
    mockUpdateMany.mockClear()
    mockUpdateMany.mockImplementation(() => Promise.resolve({ modifiedCount: 7 }))
    const n = await stitchAnonEventsToUser('anon-1', 'user-1')
    expect(n).toBe(7)
    expect(mockUpdateMany).toHaveBeenCalledWith(
      { anonId: 'anon-1', userId: { $exists: false } },
      { $set: { userId: 'user-1' } }
    )
  })

  it('never throws — telemetry stitching cannot break a flow', async () => {
    mockUpdateMany.mockClear()
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
})
