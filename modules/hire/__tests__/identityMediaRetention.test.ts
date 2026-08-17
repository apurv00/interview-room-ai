import mongoose from 'mongoose'
import sharp from 'sharp'
import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('../services/hireControlBoundary', () => ({
  connectHireControlDB: vi.fn().mockResolvedValue(undefined),
}))

const { consent, attempt, job, media, round, workspace, session } = vi.hoisted(() => ({
  consent: { exists: vi.fn(), findOne: vi.fn() },
  attempt: { findOne: vi.fn(), updateOne: vi.fn() },
  job: { findOne: vi.fn() },
  media: {
    create: vi.fn(),
    updateMany: vi.fn(),
    updateOne: vi.fn(),
    findOne: vi.fn(),
  },
  round: { exists: vi.fn() },
  workspace: { updateOne: vi.fn() },
  session: {
    withTransaction: vi.fn(async (work: () => Promise<void>) => work()),
    endSession: vi.fn().mockResolvedValue(undefined),
  },
}))

vi.mock('../models/HireConsentReceipt', () => ({ HireConsentReceipt: consent }))
vi.mock('../models/HireInterviewAttempt', () => ({ HireInterviewAttempt: attempt }))
vi.mock('../models/HireJob', () => ({ HireJob: job }))
vi.mock('../models/HireMediaAsset', () => ({ HireMediaAsset: media }))
vi.mock('../models/HireRound', () => ({ HireRound: round }))
vi.mock('../models/HireWorkspace', () => ({ HireWorkspace: workspace }))

import { saveHireIdentityPhoto } from '../services/identityMediaService'
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

beforeEach(() => {
  vi.clearAllMocks()
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
  attempt.updateOne.mockResolvedValue({ matchedCount: 1 })
  media.findOne.mockResolvedValue({ _id: 'asset', state: 'ready' })
  workspace.updateOne.mockResolvedValue({ matchedCount: 1 })
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
        storage: {
          upload: vi.fn().mockResolvedValue(undefined),
          delete: vi.fn(),
          signRead: vi.fn(),
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
  })

  it('keeps the job-relative six-calendar-month deadline on a late-created photo', async () => {
    const closedAt = new Date('2024-08-31T12:00:00.000Z')
    const expectedPurgeAt = new Date('2025-02-28T12:00:00.000Z')
    job.findOne.mockReturnValue({
      select: vi.fn().mockReturnValue({
        lean: vi.fn().mockResolvedValue({ status: 'closed', closedAt }),
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
    const storage = {
      upload: vi.fn().mockResolvedValue(undefined),
      delete: vi.fn(),
      signRead: vi.fn(),
    }

    await saveHireIdentityPhoto({
      scope: IDS,
      body,
      declaredContentType: 'image/jpeg',
      now: new Date('2024-09-01T00:00:00.000Z'),
      storage,
    })

    expect(media.create).toHaveBeenCalledWith(expect.objectContaining({
      jobId: IDS.jobId,
      purgeReason: 'job_closed',
      purgeEligibleAt: expectedPurgeAt,
    }))
    expect(media.updateOne).toHaveBeenCalledWith(
      expect.objectContaining({ state: 'staging' }),
      expect.objectContaining({
        $set: expect.objectContaining({
          state: 'ready',
          purgeReason: 'job_closed',
          purgeEligibleAt: expectedPurgeAt,
        }),
        $unset: { purgeFailureCode: 1 },
      }),
      { session },
    )
    expect(workspace.updateOne).toHaveBeenCalledWith(
      expect.objectContaining({ _id: IDS.workspaceId }),
      { $inc: { writeFenceVersion: 1 } },
      { session },
    )
  })

  it('does not attach an uploaded photo after workspace deletion wins the race', async () => {
    job.findOne.mockReturnValue({
      select: vi.fn().mockReturnValue({
        lean: vi.fn().mockResolvedValue({ status: 'open' }),
      }),
    })
    workspace.updateOne.mockResolvedValue({ matchedCount: 0 })
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
        storage: {
          upload: vi.fn().mockResolvedValue(undefined),
          delete: vi.fn(),
          signDownload: vi.fn(),
        },
      }),
    ).rejects.toMatchObject({ code: 'ROUND_INVALID', status: 410 })
    expect(attempt.updateOne).not.toHaveBeenCalled()
    expect(media.updateOne).toHaveBeenLastCalledWith(
      expect.objectContaining({ workspaceId: IDS.workspaceId }),
      expect.objectContaining({
        $set: expect.objectContaining({ purgeFailureCode: 'ATTACH_FAILED' }),
      }),
    )
  })
})
