import mongoose from 'mongoose'
import { AppError, NotFoundError } from '@shared/errors'
import {
  HireMemberSession,
  HireMemberSetup,
  HireWorkspace,
  HireWorkspaceMember,
  type IHireWorkspace,
} from '../models'
import { connectHireControlDB } from './hireControlBoundary'
import { disableHireDigestDeliveryForScope } from '../../hire-digest/services/hireDigestService'
import {
  cancelHireOnboardingTestDrivesForMember,
  deliverHireOnboardingTestDriveRuntimeRevocations,
  kickDueHireOnboardingTestDriveCleanups,
} from '../../hire-onboarding/services/testDriveLifecycleService'
import {
  getWorkspaceForUser,
  softDeleteWorkspace,
  type MembershipContext,
} from './workspaceService'

const OPERATION_ID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i

export interface SelfDeleteHireMemberInput {
  operationId: string
  workspaceConfirmationName?: string
  acknowledgeWorkspaceDeletion?: boolean
}

export interface SelfDeleteHireMemberResult {
  workspaceDeletionScheduled: boolean
  purgeAfter?: Date
}

export class HireWorkspaceDeletionConfirmationError extends AppError {
  constructor(public readonly workspaceName: string) {
    super(
      'Enter the exact workspace name and acknowledge its 30-day deletion schedule',
      409,
      'HIRE_WORKSPACE_DELETE_CONFIRMATION_REQUIRED',
    )
    this.name = 'HireWorkspaceDeletionConfirmationError'
  }
}

async function deactivateMemberAccess(input: {
  workspaceId: mongoose.Types.ObjectId
  memberId: mongoose.Types.ObjectId
  expectedRole: 'admin' | 'member'
  actorName: string
  now: Date
}): Promise<void> {
  let testDriveRuntimeRoundIds: string[] = []
  const session = await mongoose.startSession()
  try {
    await session.withTransaction(async () => {
      // Touch the tenancy root in the same transaction as the membership.
      // Admin transfer, member add, and workspace deletion also touch this
      // row, so Mongo retries against their freshly-committed authority.
      const workspaceFence = await HireWorkspace.updateOne(
        { _id: input.workspaceId },
        { $inc: { writeFenceVersion: 1 } },
        { session },
      )
      if (workspaceFence.matchedCount !== 1) throw new NotFoundError('Workspace')

      const removed = await HireWorkspaceMember.updateOne(
        {
          _id: input.memberId,
          workspaceId: input.workspaceId,
          role: input.expectedRole,
          authState: 'active',
        },
        {
          $set: { authState: 'removed', removedAt: input.now },
          $inc: { sessionVersion: 1, digestEgressFenceVersion: 1 },
          $unset: { passwordHash: 1, passwordSetAt: 1, userId: 1 },
        },
        { session },
      )
      if (removed.modifiedCount !== 1) {
        throw new AppError(
          'Membership authority changed; refresh and try again',
          409,
          'MEMBER_RACE',
        )
      }
      await HireMemberSession.updateMany(
        {
          workspaceId: input.workspaceId,
          memberId: input.memberId,
          revokedAt: { $exists: false },
        },
        { $set: { revokedAt: input.now } },
        { session },
      )
      await HireMemberSetup.updateMany(
        {
          workspaceId: input.workspaceId,
          memberId: input.memberId,
          consumedAt: { $exists: false },
        },
        { $set: { consumedAt: input.now } },
        { session },
      )
      await disableHireDigestDeliveryForScope({
        workspaceId: input.workspaceId,
        memberId: input.memberId,
        now: input.now,
        session,
      })
      const testDriveCancellation = await cancelHireOnboardingTestDrivesForMember({
        workspaceId: input.workspaceId,
        memberId: input.memberId,
        at: input.now,
        cleanupAfter: input.now,
        reason: 'Workspace member removed',
        actor: { memberId: input.memberId, name: input.actorName },
        session,
      })
      testDriveRuntimeRoundIds = testDriveCancellation.runtimeRoundIds
    })
  } finally {
    await session.endSession()
  }
  await kickDueHireOnboardingTestDriveCleanups({
    workspaceId: input.workspaceId.toString(),
    now: input.now,
  })
  await deliverHireOnboardingTestDriveRuntimeRevocations({
    workspaceId: input.workspaceId.toString(),
    roundIds: testDriveRuntimeRoundIds,
  })
}

/**
 * Remove one HR member's access without erasing their actor row or any work.
 * A sole admin first schedules the ordinary 30-day workspace soft deletion;
 * an admin with any other pending/active member must transfer first.
 */
export async function selfDeleteHireMember(
  ctx: MembershipContext,
  input: SelfDeleteHireMemberInput,
  now = new Date(),
): Promise<SelfDeleteHireMemberResult> {
  if (!OPERATION_ID.test(input.operationId)) {
    throw new AppError('Invalid operation id', 400, 'INVALID_OPERATION_ID')
  }
  await connectHireControlDB()

  const [membership, workspace] = await Promise.all([
    HireWorkspaceMember.findOne({
      _id: ctx.membership._id,
      workspaceId: ctx.workspace._id,
      authState: 'active',
    }),
    HireWorkspace.findById(ctx.workspace._id),
  ])
  if (!membership) throw new NotFoundError('Membership')
  if (!workspace) throw new NotFoundError('Workspace')

  let deletedWorkspace: IHireWorkspace | undefined
  if (membership.role === 'admin') {
    const anotherMember = await HireWorkspaceMember.exists({
      workspaceId: workspace._id,
      _id: { $ne: membership._id },
      authState: { $in: ['pending', 'active'] },
    })
    if (anotherMember) {
      throw new AppError(
        'Transfer administrator access before deleting your account',
        409,
        'HIRE_ADMIN_TRANSFER_REQUIRED',
      )
    }
    if (
      input.workspaceConfirmationName !== workspace.name ||
      input.acknowledgeWorkspaceDeletion !== true
    ) {
      throw new HireWorkspaceDeletionConfirmationError(workspace.name)
    }
    deletedWorkspace = await softDeleteWorkspace(
      { workspace, membership },
      {
        confirmationName: input.workspaceConfirmationName,
        acknowledgePermanentPurge: true,
        operationId: input.operationId,
        requireSoleAdmin: true,
      },
      now,
    )
  }

  await deactivateMemberAccess({
    workspaceId: workspace._id,
    memberId: membership._id,
    expectedRole: membership.role,
    actorName: membership.name || membership.email,
    now,
  })
  return {
    workspaceDeletionScheduled: !!deletedWorkspace,
    ...(deletedWorkspace?.purgeAfter ? { purgeAfter: deletedWorkspace.purgeAfter } : {}),
  }
}

export interface LinkedB2CDeletionInput extends SelfDeleteHireMemberInput {
  b2cUserId: string
}

export type LinkedB2CDeletionResult =
  | { action: 'not_linked' }
  | {
      action: 'member_removed' | 'workspace_deletion_scheduled'
      purgeAfter?: Date
    }

export type LinkedB2CDeletionPreflightResult =
  | { action: 'not_linked' }
  | { action: 'member_removal_required' | 'workspace_deletion_required' }

async function linkedB2CDeletionContext(input: LinkedB2CDeletionInput) {
  if (!mongoose.Types.ObjectId.isValid(input.b2cUserId)) {
    throw new AppError('Invalid B2C member id', 400, 'INVALID_B2C_MEMBER_ID')
  }
  if (!OPERATION_ID.test(input.operationId)) {
    throw new AppError('Invalid operation id', 400, 'INVALID_OPERATION_ID')
  }
  await connectHireControlDB()
  const ctx = await getWorkspaceForUser({
    userId: input.b2cUserId,
    email: '',
  })
  return ctx
}

/** Read-only gate. No Hire or B2C lifecycle state changes in this phase. */
export async function preflightLinkedB2CAccountDeletion(
  input: LinkedB2CDeletionInput,
): Promise<LinkedB2CDeletionPreflightResult> {
  const ctx = await linkedB2CDeletionContext(input)
  if (!ctx) return { action: 'not_linked' }
  if (ctx.membership.role !== 'admin') return { action: 'member_removal_required' }

  const anotherMember = await HireWorkspaceMember.exists({
    workspaceId: ctx.workspace._id,
    _id: { $ne: ctx.membership._id },
    authState: { $in: ['pending', 'active'] },
  })
  if (anotherMember) {
    throw new AppError(
      'Transfer administrator access before deleting your account',
      409,
      'HIRE_ADMIN_TRANSFER_REQUIRED',
    )
  }
  if (
    input.workspaceConfirmationName !== ctx.workspace.name ||
    input.acknowledgeWorkspaceDeletion !== true
  ) {
    throw new HireWorkspaceDeletionConfirmationError(ctx.workspace.name)
  }
  return { action: 'workspace_deletion_required' }
}

/** Internal-service entrypoint. It resolves only the stored opaque B2C id. */
export async function commitLinkedB2CAccountDeletion(
  input: LinkedB2CDeletionInput,
  now = new Date(),
): Promise<LinkedB2CDeletionResult> {
  const ctx = await linkedB2CDeletionContext(input)
  if (!ctx) return { action: 'not_linked' }

  const result = await selfDeleteHireMember(
    ctx,
    input,
    now,
  )
  return result.workspaceDeletionScheduled
    ? {
        action: 'workspace_deletion_scheduled',
        ...(result.purgeAfter ? { purgeAfter: result.purgeAfter } : {}),
      }
    : { action: 'member_removed' }
}
