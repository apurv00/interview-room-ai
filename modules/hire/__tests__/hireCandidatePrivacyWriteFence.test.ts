import type { ClientSession } from 'mongoose'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const updateOne = vi.hoisted(() => vi.fn())

vi.mock('../models/HireCandidate', () => ({
  HireCandidate: { updateOne },
}))

import {
  claimHireCandidatePiiWriteFence,
  HireCandidatePiiTombstoneError,
} from '../services/hireCandidatePrivacyWriteFence'

const WORKSPACE_ID = '111111111111111111111111'
const CANDIDATE_ID = '222222222222222222222222'
const session = {} as ClientSession

beforeEach(() => {
  vi.clearAllMocks()
  updateOne.mockResolvedValue({ matchedCount: 1 })
})

describe('candidate privacy write fence', () => {
  it('claims only the exact non-anonymized tenant candidate inside the caller transaction', async () => {
    await expect(
      claimHireCandidatePiiWriteFence({
        workspaceId: WORKSPACE_ID,
        candidateId: CANDIDATE_ID,
        session,
      }),
    ).resolves.toBeUndefined()

    expect(updateOne).toHaveBeenCalledWith(
      {
        _id: CANDIDATE_ID,
        workspaceId: WORKSPACE_ID,
        piiAnonymizedAt: { $exists: false },
      },
      { $inc: { privacyWriteFenceVersion: 1 } },
      { session, timestamps: false },
    )
  })

  it('fails closed after verified deletion has tombstoned the candidate', async () => {
    updateOne.mockResolvedValue({ matchedCount: 0 })

    await expect(
      claimHireCandidatePiiWriteFence({
        workspaceId: WORKSPACE_ID,
        candidateId: CANDIDATE_ID,
        session,
      }),
    ).rejects.toBeInstanceOf(HireCandidatePiiTombstoneError)
  })
})
