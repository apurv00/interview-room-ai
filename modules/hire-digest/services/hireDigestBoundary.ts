import mongoose, { type ClientSession } from 'mongoose'
import { AppError } from '@shared/errors'
import {
  HireWorkspace,
  HireWorkspaceMember,
  activeHireWorkspaceLifecycleFilter,
  connectHireControlDB,
} from '@hire-digest-boundary'

export interface HireDigestAuthority {
  workspaceId: mongoose.Types.ObjectId
  memberId: mongoose.Types.ObjectId
}

function privacyAggregateFenceFilter(version: number): Record<string, unknown> {
  // Workspaces created before Phase 5 have no persisted field. Treat that as
  // the documented initial epoch so the first digest and first invalidation
  // remain compatible with existing tenants.
  if (version === 0) {
    return {
      $or: [
        { privacyAggregateFenceVersion: 0 },
        { privacyAggregateFenceVersion: { $exists: false } },
      ],
    }
  }
  return { privacyAggregateFenceVersion: version }
}

export async function connectHireDigestDB(): Promise<void> {
  await connectHireControlDB()
}

/** Member-authorized preference mutation; no provider authorization happens here. */
export async function withActiveHireDigestMemberTransaction<T>(
  authority: HireDigestAuthority,
  work: (session: ClientSession) => Promise<T>,
): Promise<T> {
  await connectHireDigestDB()
  const session = await mongoose.startSession()
  try {
    let result: T | undefined
    await session.withTransaction(async () => {
      const workspaceClaim = await HireWorkspace.updateOne(
        { _id: authority.workspaceId, ...activeHireWorkspaceLifecycleFilter() },
        { $inc: { writeFenceVersion: 1 } },
        { session },
      )
      if (workspaceClaim.matchedCount !== 1) {
        throw new AppError('Workspace is unavailable', 410, 'WORKSPACE_DELETION_PENDING')
      }
      const member = await HireWorkspaceMember.exists({
        _id: authority.memberId,
        workspaceId: authority.workspaceId,
        authState: 'active',
      }).session(session)
      if (!member) throw new AppError('Member access is no longer active', 403, 'MEMBER_REMOVED')
      result = await work(session)
    })
    if (result === undefined) throw new Error('Digest member transaction completed without a result')
    return result
  } finally {
    await session.endSession()
  }
}

/**
 * Egress authorization writes both the workspace and member fence immediately
 * before an exact outbox claim. Removal/soft deletion use these same rows, so
 * either authorization commits while active or lifecycle cancellation wins.
 */
export async function authorizeHireDigestEgress<T>(input: {
  workspaceId: mongoose.Types.ObjectId
  memberId: mongoose.Types.ObjectId
  privacyAggregateFenceVersion: number
  work: (session: ClientSession) => Promise<T | null>
}): Promise<T | null> {
  await connectHireDigestDB()
  const session = await mongoose.startSession()
  try {
    let result: T | null = null
    await session.withTransaction(async () => {
      const workspaceClaim = await HireWorkspace.updateOne(
        {
          $and: [
            { _id: input.workspaceId },
            activeHireWorkspaceLifecycleFilter(),
            privacyAggregateFenceFilter(input.privacyAggregateFenceVersion),
          ],
        },
        { $inc: { writeFenceVersion: 1 } },
        { session },
      )
      if (workspaceClaim.matchedCount !== 1) return
      const memberClaim = await HireWorkspaceMember.updateOne(
        {
          _id: input.memberId,
          workspaceId: input.workspaceId,
          authState: 'active',
        },
        { $inc: { digestEgressFenceVersion: 1 } },
        { session, timestamps: false },
      )
      if (memberClaim.matchedCount !== 1) return
      result = await input.work(session)
    })
    return result
  } finally {
    await session.endSession()
  }
}
