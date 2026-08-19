import { describe, expect, it, vi } from 'vitest'

vi.mock('../services/hireControlBoundary', () => ({
  connectHireControlDB: vi.fn().mockResolvedValue(undefined),
}))

const { media, privacy, round, observationRetention } = vi.hoisted(() => ({
  media: {
    updateMany: vi.fn().mockResolvedValue({ modifiedCount: 0 }),
    find: vi.fn(),
  },
  privacy: { find: vi.fn() },
  round: { exists: vi.fn() },
  observationRetention: { purgeDue: vi.fn() },
}))

vi.mock('../models/HireMediaAsset', () => ({ HireMediaAsset: media }))
vi.mock('../models/HirePrivacyRequest', () => ({ HirePrivacyRequest: privacy }))
vi.mock('../models/HireRound', () => ({ HireRound: round }))
vi.mock('../../hire-multimodal/models', () => ({
  HireMultimodalObservation: { collection: { name: 'hiremultimodalobservations' } },
  HireMultimodalObservationPurgeObligation: {
    collection: { name: 'hiremultimodalobservationpurgeobligations' },
  },
}))
vi.mock('../../hire-multimodal/services/observationRetentionService', () => ({
  purgeDueHireMultimodalObservationRetention: (...args: unknown[]) =>
    observationRetention.purgeDue(...args),
  scheduleHireMultimodalObservationRetention: vi.fn(),
  cancelFutureHireMultimodalObservationRetention: vi.fn(),
}))

import { purgeDueHireMedia } from '../services/mediaLifecycleService'

describe('media lifecycle tenant scope', () => {
  it('requires workspaceId on stale, due-media, and privacy-request scans', async () => {
    const workspaceId = '111111111111111111111111'
    media.find.mockReturnValue({
      sort: vi.fn().mockReturnValue({
        limit: vi.fn().mockResolvedValue([]),
      }),
    })
    privacy.find.mockReturnValue({
      select: vi.fn().mockReturnValue({
        limit: vi.fn().mockResolvedValue([]),
      }),
    })
    observationRetention.purgeDue.mockResolvedValue({
      scanned: 0,
      runtimeAcknowledged: 0,
      controlPurged: 0,
      failed: 0,
    })

    await purgeDueHireMedia({ workspaceId, now: new Date('2026-08-10T00:00:00.000Z') })

    expect(media.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({ workspaceId, state: 'staging' }),
      expect.any(Object),
    )
    expect(media.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        workspaceId,
        state: 'purge_claimed',
        purgeClaimedAt: { $lte: expect.any(Date) },
      }),
      expect.objectContaining({
        $set: { state: 'purge_failed', purgeFailureCode: 'STALE_PURGE_CLAIM' },
      }),
    )
    expect(media.find).toHaveBeenCalledWith(
      expect.objectContaining({ workspaceId }),
    )
    expect(privacy.find).toHaveBeenCalledWith({
      workspaceId,
      status: 'processing',
      live: true,
    })
    expect(observationRetention.purgeDue).toHaveBeenCalledWith({
      workspaceId,
      now: new Date('2026-08-10T00:00:00.000Z'),
      batchSize: 100,
    })
  })
})
