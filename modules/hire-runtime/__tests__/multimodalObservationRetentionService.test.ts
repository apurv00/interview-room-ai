import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  connect: vi.fn(),
  bindingExists: vi.fn(),
  bindingUpdateMany: vi.fn(),
  bindingFind: vi.fn(),
  bindingUpdateOne: vi.fn(),
  outboxDeleteMany: vi.fn(),
  analysisOutboxFind: vi.fn(),
  analysisOutboxDeleteMany: vi.fn(),
  deleteObjects: vi.fn(),
  tombstoneExists: vi.fn(),
  tombstoneUpdateOne: vi.fn(),
}))

vi.mock('../services/runtimeBoundary', () => ({
  connectHireRuntimeDB: mocks.connect,
}))
vi.mock('../models/HireRuntimeBinding', () => ({
  HireRuntimeBinding: {
    exists: mocks.bindingExists,
    updateMany: mocks.bindingUpdateMany,
    find: mocks.bindingFind,
    updateOne: mocks.bindingUpdateOne,
  },
}))
vi.mock('../models/HireRuntimeMultimodalObservationOutbox', () => ({
  HireRuntimeMultimodalObservationOutbox: { deleteMany: mocks.outboxDeleteMany },
}))
vi.mock('../models/HireRuntimeMultimodalAnalysisOutbox', () => ({
  HireRuntimeMultimodalAnalysisOutbox: {
    find: mocks.analysisOutboxFind,
    deleteMany: mocks.analysisOutboxDeleteMany,
  },
}))
vi.mock('../services/runtimeMediaManifest', () => ({
  deleteRuntimePersonalObjects: mocks.deleteObjects,
}))
vi.mock('../models/HireRuntimeMultimodalObservationRetentionTombstone', () => ({
  HireRuntimeMultimodalObservationRetentionTombstone: {
    exists: mocks.tombstoneExists,
    updateOne: mocks.tombstoneUpdateOne,
  },
}))

import { purgeHireRuntimeMultimodalObservationRetention } from '../services/multimodalObservationRetentionService'

const INPUT = {
  schemaVersion: 1,
  purgeId: 'a'.repeat(24),
  workspaceId: 'b'.repeat(24),
  applicationId: 'c'.repeat(24),
  roundId: 'd'.repeat(24),
  purgeEligibleAt: '2026-01-01T00:00:00.000Z',
  reason: 'job_closed_retention',
} as const

beforeEach(() => {
  vi.clearAllMocks()
  mocks.connect.mockResolvedValue(undefined)
  mocks.bindingExists.mockResolvedValue({ _id: 'binding' })
  mocks.bindingUpdateMany.mockResolvedValue({ acknowledged: true, matchedCount: 1 })
  mocks.bindingFind.mockReturnValue({
    select: vi.fn().mockReturnValue({ lean: vi.fn().mockResolvedValue([]) }),
  })
  mocks.bindingUpdateOne.mockResolvedValue({ acknowledged: true, matchedCount: 1 })
  mocks.outboxDeleteMany.mockResolvedValue({ acknowledged: true, deletedCount: 1 })
  mocks.analysisOutboxFind.mockReturnValue({
    select: vi.fn().mockReturnValue({ lean: vi.fn().mockResolvedValue([]) }),
  })
  mocks.analysisOutboxDeleteMany.mockResolvedValue({ acknowledged: true, deletedCount: 0 })
  mocks.deleteObjects.mockResolvedValue(undefined)
  mocks.tombstoneExists.mockResolvedValue(null)
  mocks.tombstoneUpdateOne.mockResolvedValue({ acknowledged: true, upsertedCount: 1 })
})

describe('Hire runtime multimodal observation deadline retention', () => {
  it('installs the durable fence before deleting the exact outbox', async () => {
    const calls: string[] = []
    mocks.tombstoneUpdateOne.mockImplementation(async () => {
      calls.push('tombstone')
      return { acknowledged: true, upsertedCount: 1 }
    })
    mocks.outboxDeleteMany.mockImplementation(async () => {
      calls.push('outbox')
      return { acknowledged: true, deletedCount: 1 }
    })

    await expect(
      purgeHireRuntimeMultimodalObservationRetention(INPUT),
    ).resolves.toEqual({ outcome: 'purged' })

    expect(calls).toEqual(['tombstone', 'outbox'])
    expect(mocks.tombstoneUpdateOne).toHaveBeenCalledWith(
      {
        workspaceId: INPUT.workspaceId,
        applicationId: INPUT.applicationId,
        roundId: INPUT.roundId,
      },
      {
        $setOnInsert: expect.objectContaining({
          purgeId: INPUT.purgeId,
          purgeEligibleAt: new Date(INPUT.purgeEligibleAt),
          purgedAt: expect.any(Date),
        }),
      },
      { upsert: true, writeConcern: { w: 'majority', j: true } },
    )
    const coordinates = {
      workspaceId: INPUT.workspaceId,
      applicationId: INPUT.applicationId,
      roundId: INPUT.roundId,
    }
    expect(mocks.bindingUpdateMany).toHaveBeenCalledWith(
      coordinates,
      { $set: { multimodalObservationRetentionPurgedAt: expect.any(Date) } },
      { writeConcern: { w: 'majority', j: true } },
    )
    expect(mocks.outboxDeleteMany).toHaveBeenCalledWith(
      coordinates,
      { writeConcern: { w: 'majority', j: true } },
    )
    expect(mocks.analysisOutboxDeleteMany).toHaveBeenCalledWith(
      coordinates,
      { writeConcern: { w: 'majority', j: true } },
    )
  })

  it('fences capture, seals a just-reserved exact capability, then releases its inventory', async () => {
    const events: string[] = []
    const key = `landmarks/v2/${'2'.repeat(64)}`
    const objectKeyNonce = '1'.repeat(64)
    mocks.bindingUpdateMany.mockImplementationOnce(async () => {
      events.push('binding-fence')
      return { acknowledged: true, matchedCount: 1 }
    })
    mocks.bindingFind.mockReturnValueOnce({
      select: vi.fn().mockReturnValue({
        lean: vi.fn().mockImplementation(async () => {
          events.push('binding-inventory')
          return [{
            _id: 'binding',
            principalId: { toString: () => 'e'.repeat(24) },
            issuedObjectCapabilities: [{
              key,
              objectKeyNonce,
              runtimeSessionId: { toString: () => 'f'.repeat(24) },
              expiresAt: new Date('2099-01-01T00:00:00.000Z'),
            }],
          }]
        }),
      }),
    })
    mocks.deleteObjects.mockImplementationOnce(async () => {
      events.push('seal')
    })
    mocks.bindingUpdateOne.mockImplementationOnce(async () => {
      events.push('release')
      return { acknowledged: true, matchedCount: 1 }
    })
    mocks.analysisOutboxDeleteMany.mockImplementationOnce(async () => {
      events.push('outbox-delete')
      return { acknowledged: true, deletedCount: 0 }
    })

    await expect(
      purgeHireRuntimeMultimodalObservationRetention(INPUT),
    ).resolves.toEqual({ outcome: 'purged' })

    expect(events).toEqual([
      'binding-fence',
      'binding-inventory',
      'seal',
      'release',
      'outbox-delete',
    ])
    expect(mocks.deleteObjects).toHaveBeenCalledWith({
      principalId: 'e'.repeat(24),
      objects: [{ key, runtimeSessionId: 'f'.repeat(24), objectKeyNonce }],
    })
    expect(mocks.bindingUpdateOne).toHaveBeenCalledWith(
      {
        _id: 'binding',
        workspaceId: INPUT.workspaceId,
        applicationId: INPUT.applicationId,
        roundId: INPUT.roundId,
      },
      {
        $pull: {
          issuedObjectCapabilities: { key: { $in: [key] } },
        },
      },
      { writeConcern: { w: 'majority', j: true } },
    )
  })

  it('creates a fence even when the runtime round was never provisioned', async () => {
    mocks.bindingExists.mockResolvedValueOnce(null)

    await expect(
      purgeHireRuntimeMultimodalObservationRetention(INPUT),
    ).resolves.toEqual({ outcome: 'not_provisioned' })

    expect(mocks.tombstoneUpdateOne).toHaveBeenCalledOnce()
    expect(mocks.outboxDeleteMany).toHaveBeenCalledOnce()
  })

  it('keeps cleanup idempotent when an earlier purge has already fenced the round', async () => {
    mocks.tombstoneExists.mockResolvedValueOnce({ _id: 'existing' })

    await expect(
      purgeHireRuntimeMultimodalObservationRetention(INPUT),
    ).resolves.toEqual({ outcome: 'already_purged' })

    expect(mocks.tombstoneUpdateOne).not.toHaveBeenCalled()
    expect(mocks.outboxDeleteMany).toHaveBeenCalledOnce()
    expect(mocks.bindingExists).not.toHaveBeenCalled()
  })

  it('does not permit a signed early request to erase supplemental data', async () => {
    await expect(
      purgeHireRuntimeMultimodalObservationRetention({
        ...INPUT,
        purgeEligibleAt: '2099-01-01T00:00:00.000Z',
      }),
    ).rejects.toThrow(/before its deadline/)

    expect(mocks.tombstoneUpdateOne).not.toHaveBeenCalled()
    expect(mocks.outboxDeleteMany).not.toHaveBeenCalled()
  })
})
