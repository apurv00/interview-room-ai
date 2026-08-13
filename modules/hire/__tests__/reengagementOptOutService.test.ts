import mongoose from 'mongoose'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  connect: vi.fn(),
  candidate: { findOne: vi.fn() },
  outbox: { exists: vi.fn(), updateMany: vi.fn() },
  optOut: { updateOne: vi.fn() },
  piiFence: vi.fn(),
  session: {
    withTransaction: vi.fn(),
    endSession: vi.fn(),
  },
}))

vi.mock('../services/hireControlBoundary', () => ({ connectHireControlDB: mocks.connect }))
vi.mock('../models/HireCandidate', () => ({ HireCandidate: mocks.candidate }))
vi.mock('../models/HireEmailOutbox', () => ({ HireEmailOutbox: mocks.outbox }))
vi.mock('../models/HireReengagementOptOut', () => ({ HireReengagementOptOut: mocks.optOut }))
vi.mock('../services/hireCandidatePrivacyWriteFence', () => ({
  claimHireCandidatePiiWriteFence: mocks.piiFence,
  HireCandidatePiiTombstoneError: class HireCandidatePiiTombstoneError extends Error {},
}))

import {
  applyHireReengagementOptOut,
  mintHireReengagementOptOutCapability,
  verifyHireReengagementOptOutCapability,
} from '../services/reengagementOptOutService'

const WORKSPACE_ID = '111111111111111111111111'
const CANDIDATE_ID = '222222222222222222222222'
const OUTBOX_ID = '333333333333333333333333'
const NOW = new Date('2026-08-13T10:00:00.000Z')

function candidateQuery(value: unknown) {
  return {
    select: vi.fn().mockReturnValue({ session: vi.fn().mockResolvedValue(value) }),
  }
}

function sessionValue(value: unknown) {
  return { session: vi.fn().mockResolvedValue(value) }
}

beforeEach(() => {
  vi.clearAllMocks()
  vi.stubEnv('HIRE_REENGAGEMENT_OPT_OUT_SECRET', 's'.repeat(64))
  mocks.connect.mockResolvedValue(undefined)
  mocks.session.withTransaction.mockImplementation(async (work: () => Promise<void>) => work())
  mocks.session.endSession.mockResolvedValue(undefined)
  vi.spyOn(mongoose, 'startSession').mockResolvedValue(mocks.session as unknown as mongoose.ClientSession)
  mocks.candidate.findOne.mockReturnValue(candidateQuery({ _id: CANDIDATE_ID }))
  mocks.outbox.exists.mockReturnValue(sessionValue({ _id: OUTBOX_ID }))
  mocks.optOut.updateOne.mockResolvedValue({ acknowledged: true, upsertedCount: 1 })
  mocks.outbox.updateMany.mockResolvedValue({ modifiedCount: 1 })
  mocks.piiFence.mockResolvedValue(undefined)
})

afterEach(() => {
  vi.unstubAllEnvs()
  vi.restoreAllMocks()
})

describe('Hire-only re-engagement opt-out capability', () => {
  it('signs a scoped expiring capability and refuses tampering without any B2C identity lookup', () => {
    const capability = mintHireReengagementOptOutCapability({
      workspaceId: WORKSPACE_ID,
      candidateId: CANDIDATE_ID,
      outboxId: OUTBOX_ID,
      now: NOW,
      ttlMs: 60_000,
    })

    expect(verifyHireReengagementOptOutCapability(capability, NOW)).toMatchObject({
      workspaceId: WORKSPACE_ID,
      candidateId: CANDIDATE_ID,
      outboxId: OUTBOX_ID,
      exp: NOW.getTime() + 60_000,
    })
    expect(verifyHireReengagementOptOutCapability(`${capability}x`, NOW)).toBeNull()
    expect(verifyHireReengagementOptOutCapability(capability, new Date(NOW.getTime() + 60_001))).toBeNull()
  })

  it('writes only the exact workspace/candidate suppression and cancels only that tenant’s pending re-engagement mail', async () => {
    const capability = mintHireReengagementOptOutCapability({
      workspaceId: WORKSPACE_ID,
      candidateId: CANDIDATE_ID,
      outboxId: OUTBOX_ID,
      now: NOW,
    })

    await expect(applyHireReengagementOptOut({ capability, now: NOW })).resolves.toEqual({ accepted: true })

    const scope = {
      workspaceId: new mongoose.Types.ObjectId(WORKSPACE_ID),
      candidateId: new mongoose.Types.ObjectId(CANDIDATE_ID),
    }
    expect(mocks.outbox.exists).toHaveBeenCalledWith({
      _id: OUTBOX_ID,
      ...scope,
      kind: 'job_reengagement',
    })
    expect(mocks.optOut.updateOne).toHaveBeenCalledWith(
      scope,
      { $setOnInsert: { ...scope, optedOutAt: NOW } },
      { upsert: true, session: mocks.session },
    )
    expect(mocks.outbox.updateMany).toHaveBeenCalledWith(
      {
        ...scope,
        kind: 'job_reengagement',
        status: 'pending',
      },
      {
        $set: {
          status: 'cancelled',
          lastError: 'Candidate opted out of talent-pool re-engagement',
        },
      },
      { session: mocks.session },
    )
  })

  it('does not connect or create a suppression record for an invalid capability', async () => {
    await expect(applyHireReengagementOptOut({ capability: 'forged', now: NOW })).resolves.toEqual({ accepted: false })
    expect(mocks.connect).not.toHaveBeenCalled()
    expect(mocks.optOut.updateOne).not.toHaveBeenCalled()
  })
})
