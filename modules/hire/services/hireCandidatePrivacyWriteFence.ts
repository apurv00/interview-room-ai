import mongoose, { type ClientSession } from 'mongoose'
import { HireCandidate } from '../models/HireCandidate'

export class HireCandidatePiiTombstoneError extends Error {
  readonly code = 'HIRE_CANDIDATE_PII_TOMBSTONED'

  constructor() {
    super(
      'Candidate personal data was deleted while interview data was finalizing',
    )
    this.name = 'HireCandidatePiiTombstoneError'
  }
}

/**
 * Claims the candidate row inside a caller-owned transaction.
 *
 * Verified deletion writes `piiAnonymizedAt` on this same row. MongoDB's
 * document write-conflict handling therefore serializes deletion against a
 * media/result finalizer: whichever loses retries against the winner's state.
 */
export async function claimHireCandidatePiiWriteFence(input: {
  workspaceId: string | mongoose.Types.ObjectId
  candidateId: string | mongoose.Types.ObjectId
  session: ClientSession
}): Promise<void> {
  const claim = await HireCandidate.updateOne(
    {
      _id: input.candidateId,
      workspaceId: input.workspaceId,
      piiAnonymizedAt: { $exists: false },
    },
    { $inc: { privacyWriteFenceVersion: 1 } },
    { session: input.session, timestamps: false },
  )
  if (claim.matchedCount !== 1) throw new HireCandidatePiiTombstoneError()
}
