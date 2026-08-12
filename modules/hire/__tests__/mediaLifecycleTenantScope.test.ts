import { describe, expect, it, vi } from 'vitest'

vi.mock('../services/hireControlBoundary', () => ({
  connectHireControlDB: vi.fn().mockResolvedValue(undefined),
}))

const { media, privacy, round } = vi.hoisted(() => ({
  media: {
    updateMany: vi.fn().mockResolvedValue({ modifiedCount: 0 }),
    find: vi.fn(),
  },
  privacy: { find: vi.fn() },
  round: { exists: vi.fn() },
}))

vi.mock('../models/HireMediaAsset', () => ({ HireMediaAsset: media }))
vi.mock('../models/HirePrivacyRequest', () => ({ HirePrivacyRequest: privacy }))
vi.mock('../models/HireRound', () => ({ HireRound: round }))

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
  })
})
