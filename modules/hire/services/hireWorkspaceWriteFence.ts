import mongoose, { type ClientSession } from 'mongoose'
import { AppError } from '@shared/errors'
import { HireWorkspace, HireWorkspaceMember } from '../models'
import { connectHireControlDB } from './hireControlBoundary'
import { activeHireWorkspaceLifecycleFilter } from './workspaceService'

/**
 * Race-free write authority for Hire-owned personal data.
 *
 * The workspace row is deliberately written inside the same transaction as
 * the caller's mutation. A concurrent workspace tombstone therefore either
 * commits first (this claim misses) or conflicts and retries after this write;
 * there is no check-then-write window. The authority is a Hire member, never a
 * B2C User, so password-only members and public apply links work on the
 * physically isolated control database.
 */
export async function withActiveHireWorkspaceWriteTransaction<T>(
  workspaceId: mongoose.Types.ObjectId,
  authorityMemberId: mongoose.Types.ObjectId,
  work: (session: ClientSession) => Promise<T>,
): Promise<T> {
  await connectHireControlDB()
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

      const claim = await HireWorkspace.updateOne(
        { _id: workspaceId, ...activeHireWorkspaceLifecycleFilter() },
        { $inc: { writeFenceVersion: 1 } },
        { session },
      )
      if (claim.matchedCount !== 1) {
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
  if (!completed) {
    throw new Error('Hire workspace write transaction completed without a result')
  }
  return result as T
}
