import mongoose from 'mongoose'
import sharp from 'sharp'
import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('../services/hireControlBoundary', () => ({
  connectHireControlDB: vi.fn().mockResolvedValue(undefined),
}))

const {
  CandidatePiiTombstoneError,
  candidateFence,
  createIngestionLease,
  consent,
  attempt,
  job,
  media,
  round,
  workspace,
  session,
} = vi.hoisted(() => {
  class CandidatePiiTombstoneError extends Error {}
  return {
    CandidatePiiTombstoneError,
    candidateFence: vi.fn(),
    createIngestionLease: vi.fn(),
    consent: { exists: vi.fn(), findOne: vi.fn() },
    attempt: { findOne: vi.fn(), updateOne: vi.fn() },
    job: { findOne: vi.fn(), findOneAndUpdate: vi.fn() },
    media: {
      create: vi.fn(),
      updateMany: vi.fn(),
      updateOne: vi.fn(),
      findOne: vi.fn(),
      findOneAndUpdate: vi.fn(),
    },
    round: { exists: vi.fn() },
    workspace: { updateOne: vi.fn() },
    session: {
      withTransaction: vi.fn(async (work: () => Promise<void>) => work()),
      endSession: vi.fn().mockResolvedValue(undefined),
    },
  }
})

vi.mock('../models/HireConsentReceipt', () => ({ HireConsentReceipt: consent }))
vi.mock('../models/HireInterviewAttempt', () => ({ HireInterviewAttempt: attempt }))
vi.mock('../models/HireJob', () => ({ HireJob: job }))
vi.mock('../models/HireMediaAsset', () => ({
  HIRE_MEDIA_INGESTION_LEASE_MS: 60 * 60 * 1000,
  HireMediaAsset: media,
  createHireMediaIngestionLease: createIngestionLease,
}))
vi.mock('../models/HireRound', () => ({ HireRound: round }))
vi.mock('../models/HireWorkspace', () => ({ HireWorkspace: workspace }))
vi.mock('../services/hireCandidatePrivacyWriteFence', () => ({
  claimHireCandidatePiiWriteFence: candidateFence,
  HireCandidatePiiTombstoneError: CandidatePiiTombstoneError,
}))

import { saveHireIdentityPhoto } from '../services/identityMediaService'
import {
  HIRE_MEDIA_LEASE_CLEANUP_MARGIN_MS,
  HIRE_MEDIA_WRITE_TIMEOUT_MS,
} from '../services/hireMediaStorage'
import {
  HIRE_AI_CONSENT_VERSION,
  HIRE_AI_DISCLOSURE_DIGEST,
  HIRE_AI_V2_CONSENT_VERSION,
  HIRE_AI_V2_DISCLOSURE_DIGEST,
} from '../policies/aiInterviewConsent'

const IDS = {
  workspaceId: '111111111111111111111111',
  applicationId: '222222222222222222222222',
  jobId: '333333333333333333333333',
  candidateId: '444444444444444444444444',
  roundId: '555555555555555555555555',
  attemptId: '666666666666666666666666',
}
const NOW = new Date('2026-08-10T12:00:00.000Z')
const INGESTION_LEASE = {
  ingestionLeaseId: 'identity-photo-lease-id',
  ingestionLeaseExpiresAt: new Date('2026-08-10T13:00:00.000Z'),
}

function stagedAsset(): {
  _id: mongoose.Types.ObjectId
  objectKey: string
  objectKeyNonce: string
  ingestionLeaseId: string
  ingestionLeaseExpiresAt: Date
} {
  return media.create.mock.calls[0][0][0]
}

function cleanupClaimId(): string {
  const call = media.findOneAndUpdate.mock.calls[
    media.findOneAndUpdate.mock.calls.length - 1
  ]
  return (call[1] as { $set: { purgeClaimId: string } }).$set.purgeClaimId
}

beforeEach(() => {
  vi.clearAllMocks()
  INGESTION_LEASE.ingestionLeaseExpiresAt = new Date(
    Date.now() + 60 * 60 * 1000,
  )
  vi.spyOn(mongoose, 'startSession').mockResolvedValue(
    session as unknown as mongoose.ClientSession,
  )
  session.withTransaction.mockImplementation(async (work: () => Promise<void>) => work())
  session.endSession.mockResolvedValue(undefined)
  attempt.findOne.mockReturnValue({
    lean: vi.fn().mockResolvedValue({ consentReceiptId: '777777777777777777777777' }),
  })
  consent.exists.mockResolvedValue({ _id: '777777777777777777777777' })
  consent.findOne.mockReturnValue({
    select: vi.fn().mockReturnValue({
      lean: vi.fn().mockResolvedValue({
        consentVersion: HIRE_AI_CONSENT_VERSION,
        disclosureDigest: HIRE_AI_DISCLOSURE_DIGEST,
        acceptedAt: new Date('2026-08-10T00:00:00.000Z'),
      }),
    }),
  })
  media.create.mockImplementation(async (value: unknown) => value)
  media.updateMany.mockResolvedValue({ modifiedCount: 0 })
  media.updateOne.mockResolvedValue({ matchedCount: 1 })
  media.findOneAndUpdate.mockResolvedValue({ state: 'purge_claimed' })
  attempt.updateOne.mockResolvedValue({ matchedCount: 1 })
  media.findOne.mockResolvedValue({ _id: 'asset', state: 'ready' })
  workspace.updateOne.mockResolvedValue({ matchedCount: 1 })
  candidateFence.mockResolvedValue(undefined)
  createIngestionLease.mockReturnValue(INGESTION_LEASE)
  job.findOneAndUpdate.mockResolvedValue({ status: 'open' })
})

describe('identity media retention after close', () => {
  it('allows photo capture for an active attempt with the exact v2 receipt pair', async () => {
    consent.findOne.mockReturnValueOnce({
      select: vi.fn().mockReturnValue({
        lean: vi.fn().mockResolvedValue({
          consentVersion: HIRE_AI_V2_CONSENT_VERSION,
          disclosureDigest: HIRE_AI_V2_DISCLOSURE_DIGEST,
          acceptedAt: new Date('2026-08-10T00:00:00.000Z'),
        }),
      }),
    })
    job.findOne.mockReturnValue({
      select: vi.fn().mockReturnValue({
        lean: vi.fn().mockResolvedValue({ status: 'open' }),
      }),
    })
    job.findOneAndUpdate.mockResolvedValue({ status: 'open' })
    const body = await sharp({
      create: {
        width: 20,
        height: 20,
        channels: 3,
        background: { r: 20, g: 40, b: 60 },
      },
    }).jpeg().toBuffer()

    await expect(
      saveHireIdentityPhoto({
        scope: IDS,
        body,
        declaredContentType: 'image/jpeg',
        now: NOW,
        storage: {
          upload: vi.fn().mockResolvedValue(undefined),
          delete: vi.fn(),
          signDownload: vi.fn(),
        },
      }),
    ).resolves.toMatchObject({ state: 'ready' })
    expect(consent.findOne).toHaveBeenCalledWith(
      expect.objectContaining({
        _id: '777777777777777777777777',
        attemptId: IDS.attemptId,
        'accepted.recording': true,
        'accepted.identityPhoto': true,
        'accepted.attentionMonitoring': true,
        'accepted.aiEvaluation': true,
      }),
    )
    expect(createIngestionLease).toHaveBeenCalledOnce()
    expect(createIngestionLease).toHaveBeenCalledWith()
    expect(media.create).toHaveBeenCalledWith(
      [
        expect.objectContaining({
          state: 'staging',
          ...INGESTION_LEASE,
          objectKey: expect.stringMatching(/^hire-media\/v2\/[a-f0-9]{64}$/),
          objectKeyNonce: expect.stringMatching(/^[a-f0-9]{64}$/),
        }),
      ],
      { session },
    )
    expect(stagedAsset()).not.toHaveProperty('purgeEligibleAt')
    expect(stagedAsset()).not.toHaveProperty('purgeReason')
    expect(workspace.updateOne.mock.invocationCallOrder[0]).toBeLessThan(
      candidateFence.mock.invocationCallOrder[0],
    )
    expect(candidateFence.mock.invocationCallOrder[0]).toBeLessThan(
      media.create.mock.invocationCallOrder[0],
    )
    expect(job.findOne).not.toHaveBeenCalled()
    expect(job.findOneAndUpdate).toHaveBeenCalledTimes(2)
    expect(job.findOneAndUpdate).toHaveBeenNthCalledWith(
      1,
      { _id: IDS.jobId, workspaceId: IDS.workspaceId },
      { $inc: { intakeWriteVersion: 1 } },
      {
        new: true,
        session,
        projection: { status: 1, closedAt: 1 },
      },
    )
    expect(job.findOneAndUpdate).toHaveBeenNthCalledWith(
      2,
      { _id: IDS.jobId, workspaceId: IDS.workspaceId },
      { $inc: { intakeWriteVersion: 1 } },
      {
        new: true,
        session,
        projection: { status: 1, closedAt: 1 },
      },
    )
  })

  it('keeps the job-relative six-calendar-month deadline on a late-created photo', async () => {
    const closedAt = new Date('2024-08-31T12:00:00.000Z')
    const expectedPurgeAt = new Date('2025-02-28T12:00:00.000Z')
    job.findOne.mockReturnValue({
      select: vi.fn().mockReturnValue({
        lean: vi.fn().mockResolvedValue({ status: 'closed', closedAt }),
      }),
    })
    job.findOneAndUpdate.mockResolvedValue({ status: 'closed', closedAt })
    const body = await sharp({
      create: {
        width: 20,
        height: 20,
        channels: 3,
        background: { r: 20, g: 40, b: 60 },
      },
    }).jpeg().toBuffer()
    const storage = {
      upload: vi.fn().mockResolvedValue(undefined),
      delete: vi.fn(),
      signDownload: vi.fn(),
    }

    await saveHireIdentityPhoto({
      scope: IDS,
      body,
      declaredContentType: 'image/jpeg',
      now: new Date('2024-09-01T00:00:00.000Z'),
      storage,
    })

    expect(media.create).toHaveBeenCalledWith(
      [expect.objectContaining({
        jobId: IDS.jobId,
        purgeReason: 'job_closed',
        purgeEligibleAt: expectedPurgeAt,
        ...INGESTION_LEASE,
      })],
      { session },
    )
    expect(media.updateOne).toHaveBeenCalledWith(
      expect.objectContaining({
        state: 'staging',
        ingestionLeaseId: INGESTION_LEASE.ingestionLeaseId,
        ingestionLeaseExpiresAt: { $gt: expect.any(Date) },
      }),
      expect.objectContaining({
        $set: expect.objectContaining({
          state: 'ready',
          purgeReason: 'job_closed',
          purgeEligibleAt: expectedPurgeAt,
        }),
        $unset: expect.objectContaining({
          ingestionLeaseId: 1,
          ingestionLeaseExpiresAt: 1,
          purgeFailureCode: 1,
        }),
      }),
      { session },
    )
    expect(workspace.updateOne).toHaveBeenCalledWith(
      expect.objectContaining({ _id: IDS.workspaceId }),
      { $inc: { writeFenceVersion: 1 } },
      { session },
    )
  })

  it('clears the staged close deadline when the job reopens before attachment', async () => {
    const closedAt = new Date('2026-01-31T12:00:00.000Z')
    const expectedPurgeAt = new Date('2026-07-31T12:00:00.000Z')
    job.findOneAndUpdate
      .mockResolvedValueOnce({ status: 'closed', closedAt })
      .mockResolvedValueOnce({ status: 'open' })
    const body = await sharp({
      create: {
        width: 20,
        height: 20,
        channels: 3,
        background: { r: 20, g: 40, b: 60 },
      },
    }).jpeg().toBuffer()

    await saveHireIdentityPhoto({
      scope: IDS,
      body,
      declaredContentType: 'image/jpeg',
      now: NOW,
      storage: {
        upload: vi.fn().mockResolvedValue(undefined),
        delete: vi.fn(),
        signDownload: vi.fn(),
      },
    })

    expect(media.create).toHaveBeenCalledWith(
      [
        expect.objectContaining({
          purgeEligibleAt: expectedPurgeAt,
          purgeReason: 'job_closed',
        }),
      ],
      { session },
    )
    expect(media.updateOne).toHaveBeenCalledWith(
      expect.objectContaining({ state: 'staging' }),
      expect.objectContaining({
        $set: expect.not.objectContaining({
          purgeEligibleAt: expect.anything(),
          purgeReason: expect.anything(),
        }),
        $unset: expect.objectContaining({
          purgeEligibleAt: 1,
          purgeReason: 1,
        }),
      }),
      { session },
    )
  })

  it('stops before staging or upload when the candidate privacy fence is closed', async () => {
    job.findOne.mockReturnValue({
      select: vi.fn().mockReturnValue({
        lean: vi.fn().mockResolvedValue({ status: 'open' }),
      }),
    })
    candidateFence.mockRejectedValueOnce(
      new CandidatePiiTombstoneError('verified deletion already won'),
    )
    const body = await sharp({
      create: {
        width: 20,
        height: 20,
        channels: 3,
        background: { r: 20, g: 40, b: 60 },
      },
    }).jpeg().toBuffer()
    const storage = {
      upload: vi.fn().mockResolvedValue(undefined),
      delete: vi.fn().mockResolvedValue(undefined),
      signDownload: vi.fn(),
    }

    await expect(
      saveHireIdentityPhoto({
        scope: IDS,
        body,
        declaredContentType: 'image/jpeg',
        storage,
      }),
    ).rejects.toMatchObject({ code: 'ROUND_INVALID', status: 410 })

    expect(workspace.updateOne).toHaveBeenCalledOnce()
    expect(candidateFence).toHaveBeenCalledOnce()
    expect(media.create).not.toHaveBeenCalled()
    expect(storage.upload).not.toHaveBeenCalled()
    expect(storage.delete).not.toHaveBeenCalled()
  })

  it('does not attach an uploaded photo after workspace deletion wins the race', async () => {
    job.findOne.mockReturnValue({
      select: vi.fn().mockReturnValue({
        lean: vi.fn().mockResolvedValue({ status: 'open' }),
      }),
    })
    workspace.updateOne
      .mockResolvedValueOnce({ matchedCount: 1 })
      .mockResolvedValueOnce({ matchedCount: 0 })
    const body = await sharp({
      create: {
        width: 20,
        height: 20,
        channels: 3,
        background: { r: 20, g: 40, b: 60 },
      },
    }).jpeg().toBuffer()

    const storage = {
      upload: vi.fn().mockResolvedValue(undefined),
      delete: vi.fn().mockResolvedValue(undefined),
      signDownload: vi.fn(),
    }

    await expect(
      saveHireIdentityPhoto({
        scope: IDS,
        body,
        declaredContentType: 'image/jpeg',
        storage,
      }),
    ).rejects.toMatchObject({ code: 'ROUND_INVALID', status: 410 })
    expect(attempt.updateOne).not.toHaveBeenCalled()
    const staged = stagedAsset()
    expect(storage.delete).toHaveBeenCalledWith({
      key: staged.objectKey,
      coordinate: {
        workspaceId: IDS.workspaceId,
        applicationId: IDS.applicationId,
        roundId: IDS.roundId,
        attemptId: IDS.attemptId,
        assetId: staged._id.toString(),
      },
      kind: 'identity-photo',
      objectKeyNonce: staged.objectKeyNonce,
    })
    const purgeClaimId = cleanupClaimId()
    expect(media.findOneAndUpdate).toHaveBeenCalledWith(
      expect.objectContaining({
        _id: staged._id,
        state: 'staging',
        ingestionLeaseId: INGESTION_LEASE.ingestionLeaseId,
      }),
      expect.objectContaining({
        $set: expect.objectContaining({
          state: 'purge_claimed',
          purgeClaimId,
          purgeClaimedAt: expect.any(Date),
        }),
        $unset: expect.objectContaining({
          ingestionLeaseId: 1,
          ingestionLeaseExpiresAt: 1,
        }),
      }),
      { new: true },
    )
    expect(media.updateOne).toHaveBeenLastCalledWith(
      expect.objectContaining({
        _id: staged._id,
        workspaceId: IDS.workspaceId,
        applicationId: IDS.applicationId,
        jobId: IDS.jobId,
        candidateId: IDS.candidateId,
        roundId: IDS.roundId,
        attemptId: IDS.attemptId,
        kind: 'identity_photo',
        objectKey: staged.objectKey,
        state: 'purge_claimed',
        purgeClaimId,
      }),
      expect.objectContaining({
        $set: expect.objectContaining({ state: 'purged' }),
      }),
    )
  })

  it('seals the exact uploaded object when verified candidate deletion wins attachment', async () => {
    job.findOne.mockReturnValue({
      select: vi.fn().mockReturnValue({
        lean: vi.fn().mockResolvedValue({ status: 'open' }),
      }),
    })
    candidateFence
      .mockResolvedValueOnce(undefined)
      .mockRejectedValueOnce(
        new CandidatePiiTombstoneError('verified deletion won'),
      )
    const body = await sharp({
      create: {
        width: 20,
        height: 20,
        channels: 3,
        background: { r: 20, g: 40, b: 60 },
      },
    }).jpeg().toBuffer()
    const storage = {
      upload: vi.fn().mockResolvedValue(undefined),
      delete: vi.fn().mockResolvedValue(undefined),
      signDownload: vi.fn(),
    }

    await expect(
      saveHireIdentityPhoto({
        scope: IDS,
        body,
        declaredContentType: 'image/jpeg',
        storage,
      }),
    ).rejects.toMatchObject({ code: 'ROUND_INVALID', status: 410 })

    expect(candidateFence).toHaveBeenCalledWith({
      workspaceId: IDS.workspaceId,
      candidateId: IDS.candidateId,
      session,
    })
    expect(workspace.updateOne).toHaveBeenCalledTimes(2)
    expect(attempt.updateOne).not.toHaveBeenCalled()
    const staged = stagedAsset()
    expect(storage.delete).toHaveBeenCalledWith({
      key: staged.objectKey,
      coordinate: {
        workspaceId: IDS.workspaceId,
        applicationId: IDS.applicationId,
        roundId: IDS.roundId,
        attemptId: IDS.attemptId,
        assetId: staged._id.toString(),
      },
      kind: 'identity-photo',
      objectKeyNonce: staged.objectKeyNonce,
    })
    const purgeClaimId = cleanupClaimId()
    expect(media.updateOne).toHaveBeenLastCalledWith(
      expect.objectContaining({
        _id: staged._id,
        workspaceId: IDS.workspaceId,
        applicationId: IDS.applicationId,
        jobId: IDS.jobId,
        candidateId: IDS.candidateId,
        objectKey: staged.objectKey,
        state: 'purge_claimed',
        purgeClaimId,
      }),
      expect.objectContaining({
        $set: expect.objectContaining({
          state: 'purged',
          purgeReason: 'privacy_request',
        }),
      }),
    )
  })

  it('leaves a durable purge obligation when the tombstone ACK fails', async () => {
    job.findOne.mockReturnValue({
      select: vi.fn().mockReturnValue({
        lean: vi.fn().mockResolvedValue({ status: 'open' }),
      }),
    })
    candidateFence
      .mockResolvedValueOnce(undefined)
      .mockRejectedValueOnce(
        new CandidatePiiTombstoneError('verified deletion won'),
      )
    const body = await sharp({
      create: {
        width: 20,
        height: 20,
        channels: 3,
        background: { r: 20, g: 40, b: 60 },
      },
    }).jpeg().toBuffer()
    const storage = {
      upload: vi.fn().mockResolvedValue(undefined),
      delete: vi.fn().mockRejectedValue(new Error('R2 unavailable')),
      signDownload: vi.fn(),
    }

    await expect(
      saveHireIdentityPhoto({
        scope: IDS,
        body,
        declaredContentType: 'image/jpeg',
        storage,
      }),
    ).rejects.toMatchObject({ code: 'ROUND_INVALID', status: 410 })

    const staged = stagedAsset()
    const purgeClaimId = cleanupClaimId()
    expect(media.updateOne).toHaveBeenLastCalledWith(
      expect.objectContaining({
        _id: staged._id,
        workspaceId: IDS.workspaceId,
        applicationId: IDS.applicationId,
        jobId: IDS.jobId,
        candidateId: IDS.candidateId,
        roundId: IDS.roundId,
        attemptId: IDS.attemptId,
        kind: 'identity_photo',
        objectKey: staged.objectKey,
        state: 'purge_claimed',
        purgeClaimId,
      }),
      {
        $set: {
          state: 'purge_failed',
          purgeEligibleAt: expect.any(Date),
          purgeReason: 'privacy_request',
          purgeFailureCode: 'ATTACH_FAILED_TOMBSTONE_FAILED',
        },
        $unset: {
          active: 1,
          purgeClaimId: 1,
          purgeClaimedAt: 1,
          purgedAt: 1,
        },
      },
    )
  })

  it('seals an ambiguously acknowledged upload before terminaling its row', async () => {
    job.findOne.mockReturnValue({
      select: vi.fn().mockReturnValue({
        lean: vi.fn().mockResolvedValue({ status: 'open' }),
      }),
    })
    const body = await sharp({
      create: {
        width: 20,
        height: 20,
        channels: 3,
        background: { r: 20, g: 40, b: 60 },
      },
    }).jpeg().toBuffer()
    vi.useFakeTimers()
    const failedAt = new Date('2026-08-21T10:00:00.000Z')
    vi.setSystemTime(failedAt)
    INGESTION_LEASE.ingestionLeaseExpiresAt = new Date(
      failedAt.getTime() + 60 * 60 * 1000,
    )
    const uploadError = new Error('upload acknowledgement lost')
    const storage = {
      upload: vi.fn().mockRejectedValue(uploadError),
      delete: vi.fn().mockResolvedValue(undefined),
      signDownload: vi.fn(),
    }

    try {
      await expect(
        saveHireIdentityPhoto({
          scope: IDS,
          body,
          declaredContentType: 'image/jpeg',
          storage,
        }),
      ).rejects.toBe(uploadError)

      expect(candidateFence).toHaveBeenCalledOnce()
      const staged = stagedAsset()
      expect(media.findOneAndUpdate).toHaveBeenCalledOnce()
      expect(storage.delete).toHaveBeenCalledWith({
        key: staged.objectKey,
        coordinate: {
          workspaceId: IDS.workspaceId,
          applicationId: IDS.applicationId,
          roundId: IDS.roundId,
          attemptId: IDS.attemptId,
          assetId: staged._id.toString(),
        },
        kind: 'identity-photo',
        objectKeyNonce: staged.objectKeyNonce,
      })
      expect(media.updateOne).toHaveBeenCalledOnce()
      expect(media.updateOne).toHaveBeenCalledWith(
        expect.objectContaining({
          _id: staged._id,
          state: 'purge_claimed',
          purgeClaimId: expect.any(String),
        }),
        expect.objectContaining({
          $set: expect.objectContaining({ state: 'purged' }),
        }),
      )
      expect(
        media.findOneAndUpdate.mock.invocationCallOrder[0],
      ).toBeLessThan(storage.delete.mock.invocationCallOrder[0])
      expect(storage.delete.mock.invocationCallOrder[0]).toBeLessThan(
        media.updateOne.mock.invocationCallOrder[0],
      )
    } finally {
      vi.useRealTimers()
    }
  })

  it('preserves an attached photo when the final transaction committed with an unknown result', async () => {
    job.findOne.mockReturnValue({
      select: vi.fn().mockReturnValue({
        lean: vi.fn().mockResolvedValue({ status: 'open' }),
      }),
    })
    const body = await sharp({
      create: {
        width: 20,
        height: 20,
        channels: 3,
        background: { r: 20, g: 40, b: 60 },
      },
    }).jpeg().toBuffer()
    const unknownCommit = new Error('unknown transaction commit result')
    const storage = {
      upload: vi.fn().mockResolvedValue(undefined),
      delete: vi.fn().mockResolvedValue(undefined),
      signDownload: vi.fn(),
    }
    media.findOneAndUpdate.mockResolvedValueOnce(null)
    session.withTransaction
      .mockImplementationOnce(async (work: () => Promise<void>) => work())
      .mockImplementationOnce(async (work: () => Promise<void>) => {
        await work()
        throw unknownCommit
      })

    await expect(
      saveHireIdentityPhoto({
        scope: IDS,
        body,
        declaredContentType: 'image/jpeg',
        storage,
      }),
    ).rejects.toBe(unknownCommit)

    const staged = stagedAsset()
    expect(media.findOneAndUpdate).toHaveBeenCalledOnce()
    expect(media.findOneAndUpdate).toHaveBeenCalledWith(
      expect.objectContaining({
        _id: staged._id,
        objectKey: staged.objectKey,
        state: 'staging',
        ingestionLeaseId: INGESTION_LEASE.ingestionLeaseId,
      }),
      expect.objectContaining({
        $set: expect.objectContaining({ state: 'purge_claimed' }),
      }),
      { new: true },
    )
    expect(media.findOne).not.toHaveBeenCalled()
    expect(storage.delete).not.toHaveBeenCalled()
    expect(media.updateOne).toHaveBeenCalledOnce()
    expect(media.updateOne).toHaveBeenCalledWith(
      expect.objectContaining({
        _id: staged._id,
        state: 'staging',
        ingestionLeaseId: INGESTION_LEASE.ingestionLeaseId,
      }),
      expect.objectContaining({
        $set: expect.objectContaining({ state: 'ready', active: true }),
      }),
      { session },
    )
  })

  it('aborts and seals a timed-out upload without a quiet-period gap', async () => {
    job.findOne.mockReturnValue({
      select: vi.fn().mockReturnValue({
        lean: vi.fn().mockResolvedValue({ status: 'open' }),
      }),
    })
    const body = await sharp({
      create: {
        width: 20,
        height: 20,
        channels: 3,
        background: { r: 20, g: 40, b: 60 },
      },
    }).jpeg().toBuffer()
    vi.useFakeTimers()
    const writeStartedAt = new Date('2026-08-21T10:00:00.000Z')
    vi.setSystemTime(writeStartedAt)
    INGESTION_LEASE.ingestionLeaseExpiresAt = new Date(
      writeStartedAt.getTime() + 60 * 60 * 1000,
    )
    let notifyUploadStarted!: () => void
    const uploadStarted = new Promise<void>((resolve) => {
      notifyUploadStarted = resolve
    })
    let writeSignal: AbortSignal | undefined
    const storage = {
      upload: vi.fn((input: { signal?: AbortSignal }) => {
        writeSignal = input.signal
        notifyUploadStarted()
        return new Promise<void>((_resolve, reject) => {
          writeSignal?.addEventListener(
            'abort',
            () => reject(writeSignal?.reason),
            { once: true },
          )
        })
      }),
      delete: vi.fn().mockResolvedValue(undefined),
      signDownload: vi.fn(),
    }

    try {
      const saving = saveHireIdentityPhoto({
        scope: IDS,
        body,
        declaredContentType: 'image/jpeg',
        storage,
      })
      await uploadStarted
      expect(writeSignal?.aborted).toBe(false)

      const rejected = expect(saving).rejects.toThrow(
        'Hire identity media upload timed out',
      )
      await vi.advanceTimersByTimeAsync(HIRE_MEDIA_WRITE_TIMEOUT_MS)
      await rejected

      expect(writeSignal?.aborted).toBe(true)
      expect(candidateFence).toHaveBeenCalledOnce()
      expect(media.findOneAndUpdate).toHaveBeenCalledOnce()
      expect(storage.delete).toHaveBeenCalledOnce()
      expect(media.updateOne).toHaveBeenCalledOnce()
      expect(media.updateOne).toHaveBeenCalledWith(
        expect.objectContaining({
          state: 'purge_claimed',
          purgeClaimId: expect.any(String),
        }),
        expect.objectContaining({
          $set: expect.objectContaining({ state: 'purged' }),
        }),
      )
    } finally {
      vi.useRealTimers()
    }
  })

  it('refuses to begin an upload when staging consumed the lease cleanup margin', async () => {
    job.findOne.mockReturnValue({
      select: vi.fn().mockReturnValue({
        lean: vi.fn().mockResolvedValue({ status: 'open' }),
      }),
    })
    const body = await sharp({
      create: {
        width: 20,
        height: 20,
        channels: 3,
        background: { r: 20, g: 40, b: 60 },
      },
    }).jpeg().toBuffer()
    vi.useFakeTimers()
    const uploadCheckAt = new Date('2026-08-21T10:00:00.000Z')
    vi.setSystemTime(uploadCheckAt)
    INGESTION_LEASE.ingestionLeaseExpiresAt = new Date(
      uploadCheckAt.getTime() + HIRE_MEDIA_LEASE_CLEANUP_MARGIN_MS,
    )
    const storage = {
      upload: vi.fn().mockResolvedValue(undefined),
      delete: vi.fn().mockResolvedValue(undefined),
      signDownload: vi.fn(),
    }

    try {
      await expect(
        saveHireIdentityPhoto({
          scope: IDS,
          body,
          declaredContentType: 'image/jpeg',
          storage,
        }),
      ).rejects.toThrow(
        'Hire identity media lease has insufficient time to start an upload',
      )

      expect(candidateFence).toHaveBeenCalledOnce()
      expect(media.create).toHaveBeenCalledOnce()
      expect(storage.upload).not.toHaveBeenCalled()
      expect(storage.delete).toHaveBeenCalledOnce()
      expect(media.findOneAndUpdate).toHaveBeenCalledOnce()
      expect(media.updateOne).toHaveBeenCalledWith(
        expect.objectContaining({
          state: 'purge_claimed',
          purgeClaimId: expect.any(String),
        }),
        expect.objectContaining({
          $set: expect.objectContaining({ state: 'purged' }),
        }),
      )
    } finally {
      vi.useRealTimers()
    }
  })

  it('waits for a deferred upload to settle before compensating a deletion race', async () => {
    job.findOne.mockReturnValue({
      select: vi.fn().mockReturnValue({
        lean: vi.fn().mockResolvedValue({ status: 'open' }),
      }),
    })
    candidateFence
      .mockResolvedValueOnce(undefined)
      .mockRejectedValueOnce(
        new CandidatePiiTombstoneError('verified deletion won'),
      )
    const body = await sharp({
      create: {
        width: 20,
        height: 20,
        channels: 3,
        background: { r: 20, g: 40, b: 60 },
      },
    }).jpeg().toBuffer()
    let finishUpload!: () => void
    const uploadPending = new Promise<void>((resolve) => {
      finishUpload = resolve
    })
    const storage = {
      upload: vi.fn().mockReturnValue(uploadPending),
      delete: vi.fn().mockResolvedValue(undefined),
      signDownload: vi.fn(),
    }

    const saving = saveHireIdentityPhoto({
      scope: IDS,
      body,
      declaredContentType: 'image/jpeg',
      now: NOW,
      storage,
    })
    await vi.waitFor(() => expect(storage.upload).toHaveBeenCalledOnce())

    expect(candidateFence).toHaveBeenCalledOnce()
    expect(media.create).toHaveBeenCalledOnce()
    expect(storage.delete).not.toHaveBeenCalled()

    finishUpload()
    await expect(saving).rejects.toMatchObject({ code: 'ROUND_INVALID', status: 410 })
    expect(candidateFence).toHaveBeenCalledTimes(2)
    expect(storage.delete).toHaveBeenCalledOnce()
    expect(media.findOneAndUpdate).toHaveBeenCalledWith(
      expect.objectContaining({
        state: 'staging',
        ingestionLeaseId: INGESTION_LEASE.ingestionLeaseId,
      }),
      expect.objectContaining({
        $set: expect.objectContaining({ state: 'purge_claimed' }),
      }),
      { new: true },
    )
    expect(
      media.findOneAndUpdate.mock.invocationCallOrder[0],
    ).toBeLessThan(storage.delete.mock.invocationCallOrder[0])
    expect(storage.upload.mock.invocationCallOrder[0]).toBeLessThan(
      storage.delete.mock.invocationCallOrder[0],
    )
  })
})
