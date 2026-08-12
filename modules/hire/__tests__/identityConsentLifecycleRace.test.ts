import mongoose from 'mongoose'
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  connect: vi.fn(),
  roundFindOne: vi.fn(),
  workspaceUpdateOne: vi.fn(),
  applicationExists: vi.fn(),
  attemptFindOne: vi.fn(),
  consentExists: vi.fn(),
  mediaExists: vi.fn(),
  guestUpdateMany: vi.fn(),
  guestCreate: vi.fn(),
  withTransaction: vi.fn(),
  endSession: vi.fn(),
}))

vi.mock('../services/hireControlBoundary', () => ({
  connectHireControlDB: mocks.connect,
}))
vi.mock('../models/HireRound', () => ({
  HireRound: { findOne: mocks.roundFindOne },
}))
vi.mock('../models/HireWorkspace', () => ({
  HireWorkspace: { updateOne: mocks.workspaceUpdateOne },
}))
vi.mock('../models/HireApplication', () => ({
  HireApplication: { exists: mocks.applicationExists },
}))
vi.mock('../models/HireInterviewAttempt', () => ({
  HireInterviewAttempt: { findOne: mocks.attemptFindOne },
}))
vi.mock('../models/HireConsentReceipt', () => ({
  HireConsentReceipt: { exists: mocks.consentExists },
}))
vi.mock('../models/HireMediaAsset', () => ({
  HireMediaAsset: { exists: mocks.mediaExists },
}))
vi.mock('../models/HireGuestSession', () => ({
  HireGuestSession: {
    updateMany: mocks.guestUpdateMany,
    create: mocks.guestCreate,
  },
}))

import {
  acceptHireConsentAndIssueGuestSession,
  HireGuestAccessError,
} from '../services/identityConsentService'

const startSessionSpy = vi.spyOn(mongoose, 'startSession')
const IDS = {
  workspaceId: '111111111111111111111111',
  applicationId: '222222222222222222222222',
  jobId: '333333333333333333333333',
  candidateId: '444444444444444444444444',
  roundId: '555555555555555555555555',
  attemptId: '666666666666666666666666',
  receiptId: '777777777777777777777777',
}
const now = new Date('2026-08-10T00:00:00.000Z')
const accepted = {
  recording: true,
  identityPhoto: true,
  attentionMonitoring: true,
  aiEvaluation: true,
} as const

afterAll(() => {
  startSessionSpy.mockRestore()
})

beforeEach(() => {
  vi.clearAllMocks()
  mocks.connect.mockResolvedValue(undefined)
  mocks.withTransaction.mockImplementation(async (work: () => Promise<void>) => work())
  mocks.endSession.mockResolvedValue(undefined)
  startSessionSpy.mockResolvedValue({
    withTransaction: mocks.withTransaction,
    endSession: mocks.endSession,
  } as never)
  mocks.roundFindOne.mockReturnValue({
    session: vi.fn().mockResolvedValue({
      _id: IDS.roundId,
      workspaceId: IDS.workspaceId,
      applicationId: IDS.applicationId,
      jobId: IDS.jobId,
      candidateId: IDS.candidateId,
      inviteTokenExpiry: new Date('2026-08-17T00:00:00.000Z'),
    }),
  })
  mocks.workspaceUpdateOne.mockResolvedValue({ matchedCount: 1 })
  mocks.applicationExists.mockReturnValue({ session: vi.fn().mockResolvedValue(true) })
  mocks.attemptFindOne.mockReturnValue({
    session: vi.fn().mockResolvedValue({
      _id: IDS.attemptId,
      consentReceiptId: IDS.receiptId,
      status: 'ready',
      identityPhotoAssetId: '888888888888888888888888',
    }),
  })
  mocks.consentExists.mockReturnValue({ session: vi.fn().mockResolvedValue(true) })
  mocks.mediaExists.mockReturnValue({ session: vi.fn().mockResolvedValue(true) })
  mocks.guestUpdateMany.mockResolvedValue({ modifiedCount: 0 })
  mocks.guestCreate.mockResolvedValue([{}])
})

describe('candidate authority versus workspace deletion', () => {
  it('claims the active workspace in the same transaction before minting a guest session', async () => {
    const result = await acceptHireConsentAndIssueGuestSession({
      roundId: IDS.roundId,
      inviteCapability: `${IDS.workspaceId}.${'a'.repeat(64)}`,
      accepted,
      now,
    })

    expect(result.scope).toMatchObject({
      workspaceId: IDS.workspaceId,
      applicationId: IDS.applicationId,
      roundId: IDS.roundId,
      attemptId: IDS.attemptId,
    })
    expect(result.next).toBe('resume')
    expect(mocks.mediaExists).toHaveBeenCalledWith(
      expect.objectContaining({
        workspaceId: IDS.workspaceId,
        applicationId: IDS.applicationId,
        roundId: IDS.roundId,
        attemptId: IDS.attemptId,
        kind: 'identity_photo',
        state: 'ready',
        active: true,
      }),
    )
    expect(mocks.roundFindOne).toHaveBeenCalledWith(
      expect.objectContaining({
        _id: IDS.roundId,
        workspaceId: IDS.workspaceId,
        inviteTokenHash: expect.stringMatching(/^[a-f0-9]{64}$/),
      }),
    )
    expect(mocks.workspaceUpdateOne).toHaveBeenCalledWith(
      expect.objectContaining({
        _id: IDS.workspaceId,
        $or: expect.arrayContaining([{ lifecycleState: 'active' }]),
      }),
      { $inc: { writeFenceVersion: 1 } },
      { session: expect.anything() },
    )
    expect(mocks.guestCreate).toHaveBeenCalledOnce()
  })

  it('returns a terminal link response and mints nothing when deletion wins', async () => {
    mocks.workspaceUpdateOne.mockResolvedValue({ matchedCount: 0 })

    await expect(
      acceptHireConsentAndIssueGuestSession({
        roundId: IDS.roundId,
        inviteCapability: `${IDS.workspaceId}.${'a'.repeat(64)}`,
        accepted,
        now,
      }),
    ).rejects.toMatchObject<HireGuestAccessError>({
      code: 'INVITE_EXPIRED',
      status: 410,
    })
    expect(mocks.applicationExists).not.toHaveBeenCalled()
    expect(mocks.guestCreate).not.toHaveBeenCalled()
  })

  it('fails closed instead of recapturing when an in-progress attempt is inconsistent', async () => {
    mocks.attemptFindOne.mockReturnValue({
      session: vi.fn().mockResolvedValue({
        _id: IDS.attemptId,
        consentReceiptId: IDS.receiptId,
        status: 'in_progress',
        identityPhotoAssetId: '888888888888888888888888',
      }),
    })

    await expect(
      acceptHireConsentAndIssueGuestSession({
        roundId: IDS.roundId,
        inviteCapability: `${IDS.workspaceId}.${'a'.repeat(64)}`,
        accepted,
        now,
      }),
    ).rejects.toMatchObject<HireGuestAccessError>({
      code: 'GUEST_SESSION_CONFLICT',
      status: 409,
    })
    expect(mocks.mediaExists).not.toHaveBeenCalled()
    expect(mocks.guestCreate).not.toHaveBeenCalled()
  })
})
