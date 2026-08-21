import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('../services/hireControlBoundary', () => ({
  connectHireControlDB: vi.fn().mockResolvedValue(undefined),
}))

const { media, privacy, round, observationRetention } = vi.hoisted(() => ({
  media: {
    updateMany: vi.fn(),
    updateOne: vi.fn(),
    findOneAndUpdate: vi.fn(),
    find: vi.fn(),
    exists: vi.fn(),
  },
  privacy: { find: vi.fn(), updateOne: vi.fn() },
  round: { exists: vi.fn() },
  observationRetention: { purgeDue: vi.fn(), cancelFuture: vi.fn() },
}))

vi.mock('../models/HireMediaAsset', () => ({ HireMediaAsset: media }))
vi.mock('../models/HirePrivacyRequest', () => ({ HirePrivacyRequest: privacy }))
vi.mock('../models/HireRound', () => ({ HireRound: round }))
vi.mock('../../hire-multimodal/models', () => ({
  HireMultimodalAnalysis: { collection: { name: 'hiremultimodalanalyses' } },
  HireMultimodalObservation: { collection: { name: 'hiremultimodalobservations' } },
  HireMultimodalObservationPurgeObligation: {
    collection: { name: 'hiremultimodalobservationpurgeobligations' },
  },
}))
vi.mock('../../hire-multimodal/services/observationRetentionService', () => ({
  purgeDueHireMultimodalObservationRetention: (...args: unknown[]) =>
    observationRetention.purgeDue(...args),
  scheduleHireMultimodalObservationRetention: vi.fn(),
  cancelFutureHireMultimodalObservationRetention: (...args: unknown[]) =>
    observationRetention.cancelFuture(...args),
}))

import {
  cancelFutureHireJobMediaPurge,
  purgeDueHireMedia,
} from '../services/mediaLifecycleService'

const NOW = new Date('2026-08-10T00:00:00.000Z')
const WORKSPACE_ID = '111111111111111111111111'

function mediaQuery(value: unknown[]) {
  const sorted = {
    limit: vi.fn().mockResolvedValue(value),
  }
  return {
    select: vi.fn().mockReturnValue({
      sort: vi.fn().mockReturnValue(sorted),
    }),
    sort: vi.fn().mockReturnValue(sorted),
  }
}

function privacyQuery(value: unknown[]) {
  return {
    select: vi.fn().mockReturnValue({
      limit: vi.fn().mockResolvedValue(value),
    }),
  }
}

beforeEach(() => {
  vi.clearAllMocks()
  media.updateMany.mockResolvedValue({ modifiedCount: 0 })
  media.updateOne.mockResolvedValue({ modifiedCount: 1, matchedCount: 1 })
  media.findOneAndUpdate.mockResolvedValue(null)
  media.find.mockReturnValue(mediaQuery([]))
  media.exists.mockResolvedValue(null)
  privacy.find.mockReturnValue(privacyQuery([]))
  privacy.updateOne.mockResolvedValue({ modifiedCount: 1 })
  round.exists.mockResolvedValue(null)
  observationRetention.purgeDue.mockResolvedValue({
    scanned: 0,
    runtimeAcknowledged: 0,
    controlPurged: 0,
    failed: 0,
  })
  observationRetention.cancelFuture.mockResolvedValue(0)
})

describe('media lifecycle lease and tenant fencing', () => {
  it('cancels only safe future job retention and keeps failed staging recovery due', async () => {
    media.updateMany
      .mockResolvedValueOnce({ modifiedCount: 2 })
      .mockResolvedValueOnce({ modifiedCount: 3 })
      .mockResolvedValueOnce({ modifiedCount: 1 })
    observationRetention.cancelFuture.mockResolvedValue(4)

    await expect(cancelFutureHireJobMediaPurge({
      workspaceId: WORKSPACE_ID,
      jobId: '222222222222222222222222',
      reopenedAt: NOW,
    })).resolves.toBe(10)

    expect(media.updateMany).toHaveBeenNthCalledWith(
      1,
      {
        workspaceId: WORKSPACE_ID,
        jobId: '222222222222222222222222',
        state: 'ready',
        purgeReason: 'job_closed',
        purgeEligibleAt: { $gt: NOW },
      },
      {
        $unset: {
          purgeEligibleAt: 1,
          purgeReason: 1,
          purgeClaimId: 1,
          purgeClaimedAt: 1,
          purgeFailureCode: 1,
        },
      },
    )
    expect(media.updateMany).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        state: 'staging',
        purgeReason: 'job_closed',
        purgeEligibleAt: { $gt: NOW },
      }),
      {
        $unset: {
          purgeEligibleAt: 1,
          purgeReason: 1,
          purgeClaimId: 1,
          purgeClaimedAt: 1,
          purgeFailureCode: 1,
        },
      },
    )
    expect(media.updateMany).toHaveBeenNthCalledWith(
      3,
      expect.objectContaining({
        state: 'purge_failed',
        purgeReason: 'job_closed',
        purgeEligibleAt: { $gt: NOW },
      }),
      {
        $set: {
          purgeEligibleAt: NOW,
          purgeReason: 'stale_staging',
        },
        $unset: {
          active: 1,
          ingestionLeaseId: 1,
          ingestionLeaseExpiresAt: 1,
          purgeClaimId: 1,
          purgeClaimedAt: 1,
        },
      },
    )
    expect(observationRetention.cancelFuture).toHaveBeenCalledWith({
      workspaceId: WORKSPACE_ID,
      jobId: '222222222222222222222222',
      reopenedAt: NOW,
    })
  })

  it('scopes recovery and due scans, and never selects writer-owned staging for deletion', async () => {
    await purgeDueHireMedia({ workspaceId: WORKSPACE_ID, now: NOW })

    expect(media.updateMany).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        workspaceId: WORKSPACE_ID,
        state: 'staging',
        purgeEligibleAt: { $exists: true },
      }),
      expect.objectContaining({
        $set: expect.objectContaining({
          state: 'purge_failed',
          purgeFailureCode: 'STALE_INGESTION_LEASE',
        }),
        $unset: expect.objectContaining({
          ingestionLeaseId: 1,
          ingestionLeaseExpiresAt: 1,
        }),
      }),
    )
    expect(media.updateMany).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        workspaceId: WORKSPACE_ID,
        state: 'staging',
        purgeEligibleAt: { $exists: false },
      }),
      expect.objectContaining({
        $set: expect.objectContaining({
          state: 'purge_failed',
          purgeEligibleAt: NOW,
          purgeReason: 'stale_staging',
        }),
      }),
    )
    expect(media.find).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        workspaceId: WORKSPACE_ID,
        state: 'purge_claimed',
        purgeClaimedAt: { $lte: expect.any(Date) },
      }),
    )
    expect(media.find).toHaveBeenNthCalledWith(2, {
      workspaceId: WORKSPACE_ID,
      state: { $in: ['ready', 'purge_failed'] },
      purgeEligibleAt: { $lte: NOW },
      ingestionLeaseId: { $exists: false },
      ingestionLeaseExpiresAt: { $exists: false },
    })
    expect(privacy.find).toHaveBeenCalledWith({
      workspaceId: WORKSPACE_ID,
      status: 'processing',
      live: true,
    })
  })

  it('waits through an active ingestion lease, then deletes authoritatively at expiry', async () => {
    const quietUntil = new Date('2026-08-10T01:00:00.000Z')
    const beforeQuiet = new Date(quietUntil.getTime() - 1)
    const candidate = {
      _id: '222222222222222222222222',
      workspaceId: WORKSPACE_ID,
      applicationId: '333333333333333333333333',
      jobId: '444444444444444444444444',
      candidateId: '555555555555555555555555',
      roundId: '666666666666666666666666',
      attemptId: '777777777777777777777777',
      objectKey:
        'hire-media/111111111111111111111111/333333333333333333333333/666666666666666666666666/777777777777777777777777/222222222222222222222222-camera-recording.webm',
      kind: 'camera_recording' as const,
      state: 'staging',
      ingestionLeaseId: 'quiet-period-writer' as string | undefined,
      ingestionLeaseExpiresAt: quietUntil as Date | undefined,
      purgeEligibleAt: quietUntil,
      purgeReason: 'stale_staging',
      purgeFailureCode: 'RUNTIME_MEDIA_COPY_FAILED_OR_UNCERTAIN',
    }
    const request = {
      _id: '888888888888888888888888',
      workspaceId: WORKSPACE_ID,
      candidateId: candidate.candidateId,
    }

    media.updateMany.mockImplementation(async (filter) => {
      const expiryCutoff = filter.$or?.[0]?.ingestionLeaseExpiresAt?.$lte
      if (
        candidate.state === 'staging' &&
        filter.state === 'staging' &&
        filter.purgeEligibleAt?.$exists === true &&
        expiryCutoff instanceof Date &&
        candidate.ingestionLeaseExpiresAt !== undefined &&
        candidate.ingestionLeaseExpiresAt.getTime() <= expiryCutoff.getTime()
      ) {
        candidate.state = 'purge_failed'
        candidate.ingestionLeaseId = undefined
        candidate.ingestionLeaseExpiresAt = undefined
        return { modifiedCount: 1 }
      }
      return { modifiedCount: 0 }
    })
    media.find.mockImplementation((filter) => {
      if (filter.state === 'purge_claimed') return mediaQuery([])
      if (
        candidate.state === 'purge_failed' &&
        filter.state?.$in?.includes('purge_failed') &&
        candidate.purgeEligibleAt.getTime() <=
          filter.purgeEligibleAt.$lte.getTime()
      ) {
        return mediaQuery([candidate])
      }
      return mediaQuery([])
    })
    media.findOneAndUpdate.mockImplementation(async (_filter, update) => {
      if (candidate.state !== 'purge_failed') return null
      candidate.state = 'purge_claimed'
      return {
        ...candidate,
        purgeClaimId: update.$set.purgeClaimId,
        purgeClaimedAt: update.$set.purgeClaimedAt,
      }
    })
    media.updateOne.mockImplementation(async (filter, update) => {
      if (
        candidate.state !== 'purge_claimed' ||
        filter.state !== 'purge_claimed'
      ) {
        return { modifiedCount: 0, matchedCount: 0 }
      }
      candidate.state = update.$set.state
      return { modifiedCount: 1, matchedCount: 1 }
    })
    media.exists.mockImplementation(async () =>
      candidate.state === 'purged' ? null : { _id: candidate._id },
    )
    privacy.find.mockImplementation(() => privacyQuery([request]))
    const storage = {
      upload: vi.fn(),
      signDownload: vi.fn(),
      delete: vi.fn().mockResolvedValue(undefined),
    }

    const before = await purgeDueHireMedia({
      workspaceId: WORKSPACE_ID,
      now: beforeQuiet,
      storage,
    })

    expect(candidate.state).toBe('staging')
    expect(candidate.ingestionLeaseId).toBe('quiet-period-writer')
    expect(storage.delete).not.toHaveBeenCalled()
    expect(privacy.updateOne).not.toHaveBeenCalled()
    expect(before).toMatchObject({
      scanned: 0,
      purged: 0,
      privacyRequestsCompleted: 0,
    })

    const after = await purgeDueHireMedia({
      workspaceId: WORKSPACE_ID,
      now: quietUntil,
      storage,
    })

    expect(candidate.state).toBe('purged')
    expect(storage.delete).toHaveBeenCalledOnce()
    expect(storage.delete).toHaveBeenCalledWith({
      key: candidate.objectKey,
      coordinate: {
        workspaceId: candidate.workspaceId,
        applicationId: candidate.applicationId,
        roundId: candidate.roundId,
        attemptId: candidate.attemptId,
        assetId: candidate._id,
      },
      kind: 'camera-recording',
      objectKeyNonce: undefined,
    })
    expect(privacy.updateOne).toHaveBeenCalledOnce()
    expect(after).toMatchObject({
      scanned: 1,
      purged: 1,
      privacyRequestsCompleted: 1,
    })
  })

  it('token-fences a successful delete from claim through terminal finalization', async () => {
    const candidate = {
      _id: '222222222222222222222222',
      workspaceId: WORKSPACE_ID,
      applicationId: '333333333333333333333333',
      jobId: '444444444444444444444444',
      candidateId: '555555555555555555555555',
      roundId: '666666666666666666666666',
      attemptId: '777777777777777777777777',
      objectKey: 'hire-media/private.webm',
      kind: 'camera_recording' as const,
      state: 'ready',
      purgeEligibleAt: NOW,
    }
    media.find
      .mockReturnValueOnce(mediaQuery([]))
      .mockReturnValueOnce(mediaQuery([candidate]))
    media.findOneAndUpdate.mockImplementation(async (_filter, update) => ({
      ...candidate,
      state: 'purge_claimed',
      purgeClaimId: update.$set.purgeClaimId,
    }))
    const storage = {
      upload: vi.fn(),
      signRead: vi.fn(),
      delete: vi.fn().mockResolvedValue(undefined),
    }

    const report = await purgeDueHireMedia({
      workspaceId: WORKSPACE_ID,
      now: NOW,
      storage,
    })

    const purgeClaimId = media.findOneAndUpdate.mock.calls[0][1].$set.purgeClaimId
    expect(purgeClaimId).toEqual(expect.any(String))
    expect(media.findOneAndUpdate).toHaveBeenCalledWith(
      expect.objectContaining({
        _id: candidate._id,
        state: { $in: ['ready', 'purge_failed'] },
        ingestionLeaseId: { $exists: false },
        ingestionLeaseExpiresAt: { $exists: false },
      }),
      expect.objectContaining({
        $set: expect.objectContaining({ state: 'purge_claimed', purgeClaimId }),
      }),
      { new: true },
    )
    expect(storage.delete).toHaveBeenCalledOnce()
    expect(media.updateOne).toHaveBeenCalledWith(
      expect.objectContaining({
        _id: candidate._id,
        state: 'purge_claimed',
        purgeClaimId,
      }),
      expect.objectContaining({
        $set: { state: 'purged', purgedAt: NOW },
        $unset: expect.objectContaining({
          purgeClaimId: 1,
          ingestionLeaseId: 1,
          ingestionLeaseExpiresAt: 1,
        }),
      }),
    )
    expect(report).toMatchObject({ scanned: 1, purged: 1, failed: 0 })
  })

  it('recovers only the exact stale purge token so a newer claimant wins the interleaving', async () => {
    const purgeClaimedAt = new Date('2026-08-09T23:00:00.000Z')
    media.find
      .mockReturnValueOnce(mediaQuery([{
        _id: '222222222222222222222222',
        purgeClaimId: 'old-purge-claim',
        purgeClaimedAt,
      }]))
      .mockReturnValueOnce(mediaQuery([]))

    await purgeDueHireMedia({ workspaceId: WORKSPACE_ID, now: NOW })

    expect(media.updateOne).toHaveBeenCalledWith(
      {
        _id: '222222222222222222222222',
        workspaceId: WORKSPACE_ID,
        state: 'purge_claimed',
        purgeClaimedAt,
        purgeClaimId: 'old-purge-claim',
      },
      expect.objectContaining({
        $set: {
          state: 'purge_failed',
          purgeFailureCode: 'STALE_PURGE_CLAIM',
        },
        $unset: expect.objectContaining({ purgeClaimId: 1, purgeClaimedAt: 1 }),
      }),
    )
  })

  it('releases a failed object delete only for the worker purge token', async () => {
    const candidate = {
      _id: '222222222222222222222222',
      workspaceId: WORKSPACE_ID,
      applicationId: '333333333333333333333333',
      jobId: '444444444444444444444444',
      candidateId: '555555555555555555555555',
      roundId: '666666666666666666666666',
      attemptId: '777777777777777777777777',
      objectKey: 'hire-media/private.webm',
      state: 'ready',
      purgeEligibleAt: NOW,
    }
    media.find
      .mockReturnValueOnce(mediaQuery([]))
      .mockReturnValueOnce(mediaQuery([candidate]))
    media.findOneAndUpdate.mockImplementation(async (_filter, update) => ({
      ...candidate,
      state: 'purge_claimed',
      purgeClaimId: update.$set.purgeClaimId,
    }))
    const storage = {
      upload: vi.fn(),
      signRead: vi.fn(),
      delete: vi.fn().mockRejectedValue(new Error('R2 unavailable')),
    }

    const report = await purgeDueHireMedia({
      workspaceId: WORKSPACE_ID,
      now: NOW,
      storage,
    })

    const purgeClaimId = media.findOneAndUpdate.mock.calls[0][1].$set.purgeClaimId
    expect(media.updateOne).toHaveBeenCalledWith(
      expect.objectContaining({
        _id: candidate._id,
        state: 'purge_claimed',
        purgeClaimId,
      }),
      expect.objectContaining({
        $set: { state: 'purge_failed', purgeFailureCode: 'Error' },
        $unset: expect.objectContaining({ purgeClaimId: 1, purgeClaimedAt: 1 }),
      }),
    )
    expect(report).toMatchObject({ scanned: 1, purged: 0, failed: 1 })
  })

  it('does not complete privacy deletion while any media lease metadata remains', async () => {
    const request = {
      _id: '222222222222222222222222',
      candidateId: '333333333333333333333333',
    }
    privacy.find.mockReturnValue(privacyQuery([request]))
    media.exists.mockResolvedValue({ _id: 'leased-or-incomplete-media' })

    const report = await purgeDueHireMedia({ workspaceId: WORKSPACE_ID, now: NOW })

    expect(media.exists).toHaveBeenCalledWith({
      workspaceId: WORKSPACE_ID,
      candidateId: request.candidateId,
      $or: [
        { state: { $ne: 'purged' } },
        { purgedAt: { $exists: false } },
        { ingestionLeaseId: { $exists: true } },
        { ingestionLeaseExpiresAt: { $exists: true } },
      ],
    })
    expect(round.exists).not.toHaveBeenCalled()
    expect(privacy.updateOne).not.toHaveBeenCalled()
    expect(report.privacyRequestsCompleted).toBe(0)
  })
})
