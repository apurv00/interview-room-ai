import mongoose, { type ClientSession } from 'mongoose'
import { AppError } from '@shared/errors'
import { HireCandidate } from '@hire/models/HireCandidate'
import { HireWorkspace } from '@hire/models/HireWorkspace'
import { HireWorkspaceMember } from '@hire/models/HireWorkspaceMember'
import { connectHireControlDB } from '@hire/services/hireControlBoundary'
import { activeHireWorkspaceLifecycleFilter } from '@hire/services/hireWorkspaceLifecycleFilter'

/**
 * Local, narrow Phase-5 control boundary. It intentionally does not import
 * `@hire`, apply-page services, interview-round services, guest sessions, or
 * B2C composition. Status reads use a small transaction so revocation,
 * workspace deletion, and candidate privacy claims serialize before a DTO is
 * returned.
 */
export async function connectHireStatusDB(): Promise<void> {
  await connectHireControlDB()
}

export class CandidateStatusLinkPiiTombstoneError extends Error {
  readonly code = 'HIRE_CANDIDATE_PII_TOMBSTONED'

  constructor() {
    super('Candidate personal data is unavailable')
    this.name = 'CandidateStatusLinkPiiTombstoneError'
  }
}

export async function resolveCandidateStatusWorkspaceAuthority(
  workspaceId: mongoose.Types.ObjectId,
): Promise<mongoose.Types.ObjectId | null> {
  await connectHireStatusDB()
  const workspace = await HireWorkspace.exists({
    _id: workspaceId,
    ...activeHireWorkspaceLifecycleFilter(),
  })
  if (!workspace) return null
  const member = await HireWorkspaceMember.findOne({
    workspaceId,
    authState: 'active',
  }).sort({ role: 1, createdAt: 1 })
  return member?._id ?? null
}

export async function withCandidateStatusLinkTransaction<T>(
  workspaceId: mongoose.Types.ObjectId,
  authorityMemberId: mongoose.Types.ObjectId,
  work: (session: ClientSession) => Promise<T>,
): Promise<T> {
  await connectHireStatusDB()
  const session = await mongoose.startSession()
  let result: T | undefined
  let completed = false
  try {
    await session.withTransaction(async () => {
      const member = await HireWorkspaceMember.exists({
        _id: authorityMemberId,
        workspaceId,
        authState: 'active',
      }).session(session)
      if (!member) {
        throw new AppError('Workspace write authority is no longer active', 403, 'MEMBER_REMOVED')
      }
      const workspaceClaim = await HireWorkspace.updateOne(
        { _id: workspaceId, ...activeHireWorkspaceLifecycleFilter() },
        { $inc: { writeFenceVersion: 1 } },
        { session },
      )
      if (workspaceClaim.matchedCount !== 1) {
        throw new AppError(
          'This workspace is scheduled for deletion',
          410,
          'WORKSPACE_DELETION_PENDING',
        )
      }
      result = await work(session)
      completed = true
    })
  } finally {
    await session.endSession()
  }
  if (!completed) throw new Error('Candidate status-link transaction completed without a result')
  return result as T
}

/**
 * Claims the candidate document in a public status read. Privacy deletion
 * mutates this same document, so a losing status transaction retries and
 * returns the uniform inactive outcome instead of stale application state.
 */
export async function claimCandidateStatusLinkPiiFence(input: {
  workspaceId: mongoose.Types.ObjectId
  candidateId: mongoose.Types.ObjectId
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
  if (claim.matchedCount !== 1) throw new CandidateStatusLinkPiiTombstoneError()
}
