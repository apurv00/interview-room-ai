import { connectDB } from '@shared/db/connection'
import { AppError, ForbiddenError, NotFoundError } from '@shared/errors'
import mongoose from 'mongoose'
import {
  HireGuestSession,
  HireEngineHandoff,
  HireInterviewAttempt,
  HireJob,
  HireMemberSession,
  HireMemberSetup,
  HireRound,
  HireWorkspace,
  HireWorkspaceMember,
  normalizeHireMemberEmail,
  type GuestAuthMode,
  type IHireWorkspace,
  type IHireWorkspaceMember,
} from '../models'
import { issueMemberSetup, type MemberSetupResult } from './memberAuthService'
import { deliverRuntimeRevocation } from './engineRevocationService'

export const HIRE_WORKSPACE_SOFT_DELETE_DAYS = 30
const OPERATION_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i

/**
 * Compatibility-safe lifecycle predicate for transactional Hire writes.
 * Workspaces created before Phase 1 have no lifecycleState and are active.
 */
export function activeHireWorkspaceLifecycleFilter(): mongoose.QueryFilter<IHireWorkspace> {
  return {
    $or: [{ lifecycleState: 'active' }, { lifecycleState: { $exists: false } }],
  }
}

function workspaceLifecycleState(workspace: IHireWorkspace): 'active' | 'deletion_pending' {
  return workspace.lifecycleState ?? 'active'
}

function memberActorName(member: IHireWorkspaceMember): string {
  return member.name || member.email
}

/**
 * Workspace + membership layer. Flat permissions (build plan §Principles):
 * exactly one admin (the creator); every other member is identical. All
 * member-facing services take a MembershipContext produced by
 * requireMembership() — that is the single tenancy gate; nothing else in the
 * module trusts a client-supplied workspace id.
 */

export interface WorkspaceActor {
  userId: string
  email: string
  name?: string
}

export interface MembershipContext {
  workspace: IHireWorkspace
  membership: IHireWorkspaceMember
}

/**
 * Resolve the caller's workspace without ever performing a global member
 * lookup. Hire-password principals carry workspaceId in their credential.
 * The legacy B2C creator path enumerates tenancy roots, then performs one
 * workspace-scoped opaque-user-id lookup per root. It never reads a B2C User
 * or resolves an HR/candidate email across tenants.
 */
export async function getWorkspaceForUser(
  actor: WorkspaceActor
): Promise<MembershipContext | null> {
  await connectDB()

  // Hire-password sessions are represented by an opaque, Hire-owned member
  // principal. They never fall through to B2C email/user reconciliation.
  if (actor.userId.startsWith('hire-member:')) {
    const parts = actor.userId.split(':')
    if (
      parts.length !== 3 ||
      parts[0] !== 'hire-member' ||
      !/^[a-f0-9]{24}$/i.test(parts[1]) ||
      !/^[a-f0-9]{24}$/i.test(parts[2])
    ) return null
    const [, workspaceId, memberId] = parts
    const membership = await HireWorkspaceMember.findOne({
      _id: memberId,
      workspaceId,
      normalizedEmail: normalizeHireMemberEmail(actor.email),
      authState: 'active',
    })
    if (!membership) return null
    const workspace = await HireWorkspace.findOne({ _id: workspaceId })
    return workspace ? { workspace, membership } : null
  }

  if (!mongoose.Types.ObjectId.isValid(actor.userId)) return null
  const roots = await HireWorkspace.find({}, { _id: 1 }).sort({ _id: 1 }).lean()
  for (const root of roots) {
    const workspaceId = root._id
    const membership = await HireWorkspaceMember.findOne({
      workspaceId,
      userId: actor.userId,
      authState: 'active',
    })
    if (!membership) continue
    const workspace = await HireWorkspace.findOne({ _id: workspaceId })
    return workspace ? { workspace, membership } : null
  }
  return null
}

/** Tenancy gate for every member API route. */
export async function requireMembership(actor: WorkspaceActor): Promise<MembershipContext> {
  const ctx = await getWorkspaceForUser(actor)
  if (!ctx) {
    throw new ForbiddenError('Workspace membership required')
  }
  if (workspaceLifecycleState(ctx.workspace) !== 'active') {
    throw new AppError(
      'This workspace is scheduled for deletion. Restore it before accessing hiring data.',
      410,
      'WORKSPACE_DELETION_PENDING',
    )
  }
  return ctx
}

/** Lifecycle endpoints authenticate the membership but deliberately allow the
 * tombstoned workspace through so its admin can cancel deletion. */
export async function requireWorkspaceLifecycleMembership(
  actor: WorkspaceActor,
): Promise<MembershipContext> {
  const ctx = await getWorkspaceForUser(actor)
  if (!ctx) throw new ForbiddenError('Workspace membership required')
  return ctx
}

export async function createWorkspace(
  actor: WorkspaceActor,
  input: { name: string; guestAuthMode?: GuestAuthMode }
): Promise<MembershipContext> {
  await connectDB()

  const existing = await getWorkspaceForUser(actor)
  if (existing) {
    throw new AppError('You already belong to a workspace', 409, 'WORKSPACE_EXISTS')
  }

  const workspace = await HireWorkspace.create({
    name: input.name,
    guestAuthMode: input.guestAuthMode ?? 'magic_link',
    createdBy: actor.userId,
  })
  try {
    const normalizedEmail = normalizeHireMemberEmail(actor.email)
    const membership = await HireWorkspaceMember.create({
      workspaceId: workspace._id,
      email: normalizedEmail,
      normalizedEmail,
      name: actor.name?.trim() || actor.email.split('@')[0] || 'Workspace admin',
      userId: actor.userId,
      role: 'admin',
      authState: 'active',
      sessionVersion: 1,
      addedBy: actor.userId,
      addedByName: actor.name?.trim() || actor.email,
    })
    return { workspace, membership }
  } catch (err: unknown) {
    // The database decides concurrent ownership. Remove the orphaned
    // workspace, then surface a stable conflict instead of leaking an index
    // name or allowing an ambiguous email login.
    if (err && typeof err === 'object' && (err as { code?: number }).code === 11000) {
      await HireWorkspace.deleteOne({ _id: workspace._id })
      const owner = await HireWorkspaceMember.findOne({
        workspaceId: workspace._id,
        normalizedEmail: normalizeHireMemberEmail(actor.email),
        authState: { $in: ['pending', 'active'] },
      }).select('_id')
      throw new AppError(
        owner
          ? 'This email already belongs to a hiring workspace'
          : 'You already belong to a workspace',
        409,
        'WORKSPACE_EXISTS',
      )
    }
    throw err
  }
}

/**
 * Admin-only workspace settings. guestAuthMode governs FUTURE invites only —
 * every round snapshots the mode at send time, so links already in inboxes
 * keep the verification semantics they were sent with.
 */
export async function updateWorkspaceSettings(
  ctx: MembershipContext,
  input: { guestAuthMode?: GuestAuthMode; companyBlurb?: string },
): Promise<IHireWorkspace> {
  if (ctx.membership.role !== 'admin') {
    throw new ForbiddenError('Only the workspace admin can change settings')
  }
  await connectDB()
  const $set: { guestAuthMode?: GuestAuthMode; companyBlurb?: string } = {}
  const $unset: { companyBlurb?: 1 } = {}
  if (input.guestAuthMode !== undefined) $set.guestAuthMode = input.guestAuthMode
  if (input.companyBlurb !== undefined) {
    const companyBlurb = input.companyBlurb.trim()
    if (companyBlurb) $set.companyBlurb = companyBlurb
    else $unset.companyBlurb = 1
  }
  const workspace = await HireWorkspace.findOneAndUpdate(
    { _id: ctx.workspace._id, ...activeHireWorkspaceLifecycleFilter() },
    {
      ...(Object.keys($set).length > 0 ? { $set } : {}),
      ...(Object.keys($unset).length > 0 ? { $unset } : {}),
    },
    { new: true },
  )
  if (!workspace) throw new NotFoundError('Workspace')
  return workspace
}

export interface AddMemberInput {
  email: string
  name: string
}

export interface AddMemberResult extends MemberSetupResult {
  member: IHireWorkspaceMember
}

/**
 * Admin adds an HR-team member by name + email — no invite flow (build plan
 * §Permission model). We do not query or create a B2C User here. The member
 * receives Hire-owned credentials whose login coordinate is the workspace id.
 */
export async function addMember(
  ctx: MembershipContext,
  input: AddMemberInput
): Promise<AddMemberResult> {
  if (ctx.membership.role !== 'admin') {
    throw new ForbiddenError('Only the workspace admin can add members')
  }
  await connectDB()

  const email = normalizeHireMemberEmail(input.email)
  const existingMembership = await HireWorkspaceMember.findOne({
    workspaceId: ctx.workspace._id,
    normalizedEmail: email,
    authState: { $in: ['pending', 'active'] },
  }).select('_id')
  if (existingMembership) {
    throw new AppError(
      'This person is already a member',
      409,
      'MEMBER_EXISTS'
    )
  }
  const memberDoc = {
    workspaceId: ctx.workspace._id,
    email,
    normalizedEmail: email,
    name: input.name,
    role: 'member' as const,
    authState: 'pending' as const,
    sessionVersion: 1,
    ...(ctx.membership.userId ? { addedBy: ctx.membership.userId } : {}),
    addedByMemberId: ctx.membership._id,
    addedByName: ctx.membership.name || ctx.membership.email,
  }

  let member: IHireWorkspaceMember | undefined
  const session = await mongoose.startSession()
  try {
    await session.withTransaction(async () => {
      const currentAdmin = await HireWorkspaceMember.exists({
        _id: ctx.membership._id,
        workspaceId: ctx.workspace._id,
        role: 'admin',
        authState: 'active',
      }).session(session)
      if (!currentAdmin) {
        throw new AppError('Administrator access changed; refresh and try again', 409, 'ADMIN_RACE')
      }
      const workspaceFence = await HireWorkspace.updateOne(
        { _id: ctx.workspace._id, ...activeHireWorkspaceLifecycleFilter() },
        { $inc: { writeFenceVersion: 1 } },
        { session },
      )
      if (workspaceFence.matchedCount !== 1) {
        throw new AppError(
          'This workspace is scheduled for deletion',
          410,
          'WORKSPACE_DELETION_PENDING',
        )
      }
      const created = await HireWorkspaceMember.create([memberDoc], { session })
      member = created[0]
    })
  } catch (err: unknown) {
    if (err && typeof err === 'object' && (err as { code?: number }).code === 11000) {
      const winner = await HireWorkspaceMember.findOne({
        workspaceId: ctx.workspace._id,
        normalizedEmail: email,
        authState: { $in: ['pending', 'active'] },
      }).select('_id')
      throw new AppError(
        winner ? 'This person is already a member' : 'Member identity already exists',
        409,
        'MEMBER_EXISTS',
      )
    } else {
      throw err
    }
  } finally {
    await session.endSession()
  }
  if (!member) throw new Error('Member creation transaction completed without a result')
  try {
    const setup = await issueMemberSetup(member, ctx.workspace.name)
    return { member, ...setup }
  } catch (err) {
    // The membership has no history yet and cannot authenticate while
    // pending. Roll back this exact just-created row so an admin can retry.
    await HireWorkspaceMember.deleteOne({
      _id: member._id,
      workspaceId: ctx.workspace._id,
      authState: 'pending',
    })
    throw err
  }
}

/**
 * Recover a pending direct member after a provider failure or a process crash
 * made the original one-time credential unavailable. Issuing a replacement
 * consumes every older setup credential first, so the admin never has to
 * remove and recreate the membership just to retry delivery.
 */
export async function regenerateMemberSetup(
  ctx: MembershipContext,
  memberId: string,
): Promise<MemberSetupResult> {
  if (ctx.membership.role !== 'admin') {
    throw new ForbiddenError('Only the workspace admin can regenerate setup links')
  }
  await connectDB()

  const member = await HireWorkspaceMember.findOne({
    _id: memberId,
    workspaceId: ctx.workspace._id,
    role: 'member',
    authState: 'pending',
  })
  if (!member) {
    throw new AppError(
      'Password setup is no longer pending for this member',
      409,
      'MEMBER_SETUP_NOT_PENDING',
    )
  }

  return issueMemberSetup(member, ctx.workspace.name)
}

export async function listMembers(ctx: MembershipContext): Promise<IHireWorkspaceMember[]> {
  await connectDB()
  return HireWorkspaceMember.find({
    workspaceId: ctx.workspace._id,
    authState: { $ne: 'removed' },
  }).sort({ createdAt: 1 })
}

export async function removeMember(ctx: MembershipContext, memberId: string): Promise<void> {
  if (ctx.membership.role !== 'admin') {
    throw new ForbiddenError('Only the workspace admin can remove members')
  }
  await connectDB()

  const target = await HireWorkspaceMember.findOne({
    _id: memberId,
    workspaceId: ctx.workspace._id,
  })
  if (!target) throw new NotFoundError('Member')
  if (target.role === 'admin') {
    throw new AppError('The workspace admin cannot be removed', 400, 'CANNOT_REMOVE_ADMIN')
  }
  const removedAt = new Date()
  const session = await mongoose.startSession()
  try {
    await session.withTransaction(async () => {
      const removed = await HireWorkspaceMember.updateOne(
        {
          _id: target._id,
          workspaceId: ctx.workspace._id,
          role: 'member',
          authState: { $in: ['pending', 'active'] },
        },
        {
          $set: { authState: 'removed', removedAt },
          $inc: { sessionVersion: 1 },
          $unset: { passwordHash: 1, passwordSetAt: 1, userId: 1 },
        },
        { session },
      )
      if (removed.modifiedCount !== 1) {
        throw new AppError('Member access changed; refresh and try again', 409, 'MEMBER_RACE')
      }
      await HireMemberSession.updateMany(
        {
          workspaceId: ctx.workspace._id,
          memberId: target._id,
          revokedAt: { $exists: false },
        },
        { $set: { revokedAt: removedAt } },
        { session },
      )
      await HireMemberSetup.updateMany(
        {
          workspaceId: ctx.workspace._id,
          memberId: target._id,
          consumedAt: { $exists: false },
        },
        { $set: { consumedAt: removedAt } },
        { session },
      )
    })
  } finally {
    await session.endSession()
  }
}

export async function transferWorkspaceAdmin(
  ctx: MembershipContext,
  targetMemberId: string,
  input: { operationId: string },
): Promise<MembershipContext> {
  if (!/^[a-f0-9]{24}$/i.test(targetMemberId)) throw new NotFoundError('Member')
  if (!OPERATION_ID.test(input.operationId)) {
    throw new AppError('Invalid operation id', 400, 'INVALID_OPERATION_ID')
  }
  await connectDB()

  const prior = await HireWorkspace.findOne({
    _id: ctx.workspace._id,
    adminTransferEvents: { $elemMatch: { operationId: input.operationId } },
  })
  if (prior) {
    const event = prior.adminTransferEvents.find(
      (candidate) => candidate.operationId === input.operationId,
    )
    if (
      event?.fromMemberId.toString() !== ctx.membership._id.toString() ||
      event.toMemberId.toString() !== targetMemberId
    ) {
      throw new AppError(
        'That operation id was already used for another admin transfer',
        409,
        'OPERATION_ID_REUSED',
      )
    }
    const membership = await HireWorkspaceMember.findOne({
      _id: ctx.membership._id,
      workspaceId: ctx.workspace._id,
      authState: 'active',
    })
    if (!membership) throw new NotFoundError('Member')
    return { workspace: prior, membership }
  }
  if (ctx.membership.role !== 'admin') {
    throw new ForbiddenError('Only the workspace admin can transfer ownership')
  }

  const session = await mongoose.startSession()
  try {
    await session.withTransaction(async () => {
      const target = await HireWorkspaceMember.findOne({
        _id: targetMemberId,
        workspaceId: ctx.workspace._id,
        role: 'member',
        authState: 'active',
      }).session(session)
      if (!target) throw new NotFoundError('Active member')
      const demoted = await HireWorkspaceMember.updateOne(
        {
          _id: ctx.membership._id,
          workspaceId: ctx.workspace._id,
          role: 'admin',
          authState: 'active',
        },
        { $set: { role: 'member' } },
        { session }
      )
      if (demoted.modifiedCount !== 1) {
        throw new AppError('Admin changed; refresh and try again', 409, 'ADMIN_RACE')
      }
      const promoted = await HireWorkspaceMember.updateOne(
        {
          _id: target._id,
          workspaceId: ctx.workspace._id,
          role: 'member',
          authState: 'active',
        },
        { $set: { role: 'admin' } },
        { session }
      )
      if (promoted.modifiedCount !== 1) {
        throw new AppError('Member changed; refresh and try again', 409, 'ADMIN_RACE')
      }
      const workspace = await HireWorkspace.findOneAndUpdate(
        {
          _id: ctx.workspace._id,
          ...activeHireWorkspaceLifecycleFilter(),
          'adminTransferEvents.operationId': { $ne: input.operationId },
        },
        {
          $inc: { authorityVersion: 1 },
          $push: {
            adminTransferEvents: {
              fromMemberId: ctx.membership._id,
              toMemberId: target._id,
              actorName: memberActorName(ctx.membership),
              operationId: input.operationId,
              at: new Date(),
            },
          },
        },
        { new: true, session },
      )
      if (!workspace) {
        throw new AppError(
          'Workspace authority changed; refresh and try again',
          409,
          'ADMIN_RACE',
        )
      }
    })
  } finally {
    await session.endSession()
  }
  const [workspace, membership] = await Promise.all([
    HireWorkspace.findById(ctx.workspace._id),
    HireWorkspaceMember.findOne({
      _id: ctx.membership._id,
      workspaceId: ctx.workspace._id,
      authState: 'active',
    }),
  ])
  if (!workspace || !membership) throw new NotFoundError('Workspace')
  return { workspace, membership }
}

export interface SoftDeleteWorkspaceInput {
  confirmationName: string
  acknowledgePermanentPurge: true
  operationId: string
  /** Internal account-deletion fence; never accepted from a public schema. */
  requireSoleAdmin?: boolean
}

export async function softDeleteWorkspace(
  ctx: MembershipContext,
  input: SoftDeleteWorkspaceInput,
  now = new Date(),
): Promise<IHireWorkspace> {
  if (ctx.membership.role !== 'admin') {
    throw new ForbiddenError('Only the workspace admin can delete the workspace')
  }
  if (!OPERATION_ID.test(input.operationId)) {
    throw new AppError('Invalid operation id', 400, 'INVALID_OPERATION_ID')
  }
  if (!input.acknowledgePermanentPurge || input.confirmationName !== ctx.workspace.name) {
    throw new AppError(
      'Enter the exact workspace name and acknowledge permanent deletion',
      400,
      'WORKSPACE_DELETE_CONFIRMATION_REQUIRED',
    )
  }
  await connectDB()

  const prior = await HireWorkspace.findOne({
    _id: ctx.workspace._id,
    lifecycleEvents: { $elemMatch: { operationId: input.operationId } },
  })
  if (prior) {
    const event = prior.lifecycleEvents.find(
      (candidate) => candidate.operationId === input.operationId,
    )
    if (event?.type !== 'deletion_scheduled') {
      throw new AppError(
        'That operation id was already used for another workspace action',
        409,
        'OPERATION_ID_REUSED',
      )
    }
    return prior
  }

  const deletedAt = new Date(now)
  const purgeAfter = new Date(
    deletedAt.getTime() + HIRE_WORKSPACE_SOFT_DELETE_DAYS * 24 * 60 * 60 * 1000,
  )
  const session = await mongoose.startSession()
  let deleted: IHireWorkspace | undefined
  let runtimeRoundIds: string[] = []
  try {
    await session.withTransaction(async () => {
      const currentAdmin = await HireWorkspaceMember.exists({
        _id: ctx.membership._id,
        workspaceId: ctx.workspace._id,
        role: 'admin',
        authState: 'active',
      }).session(session)
      if (!currentAdmin) {
        throw new AppError('Admin changed; refresh and try again', 409, 'ADMIN_RACE')
      }
      if (input.requireSoleAdmin) {
        const anotherMember = await HireWorkspaceMember.exists({
          workspaceId: ctx.workspace._id,
          _id: { $ne: ctx.membership._id },
          authState: { $in: ['pending', 'active'] },
        }).session(session)
        if (anotherMember) {
          throw new AppError(
            'Transfer administrator access before deleting your account',
            409,
            'HIRE_ADMIN_TRANSFER_REQUIRED',
          )
        }
      }

      deleted =
        (await HireWorkspace.findOneAndUpdate(
          {
            _id: ctx.workspace._id,
            ...activeHireWorkspaceLifecycleFilter(),
            'lifecycleEvents.operationId': { $ne: input.operationId },
          },
          {
            $set: {
              lifecycleState: 'deletion_pending',
              deletedAt,
              purgeAfter,
              deletedByMemberId: ctx.membership._id,
              deletedByName: memberActorName(ctx.membership),
            },
            $inc: { authorityVersion: 1 },
            $push: {
              lifecycleEvents: {
                type: 'deletion_scheduled',
                from: 'active',
                to: 'deletion_pending',
                actorMemberId: ctx.membership._id,
                actorName: memberActorName(ctx.membership),
                operationId: input.operationId,
                at: deletedAt,
              },
            },
          },
          { new: true, session },
        )) ?? undefined
      if (!deleted) {
        throw new AppError(
          'Workspace lifecycle changed; refresh and try again',
          409,
          'WORKSPACE_LIFECYCLE_RACE',
        )
      }

      // Tokens are revoked in the same transaction as the tombstone. Apply
      // links never revive on restore; HR deliberately issues fresh links.
      // Mongo does not support parallel operations on one transaction
      // session. Keep these sequential so the tombstone + revocations are a
      // single, well-defined commit.
      await HireJob.updateMany(
        { workspaceId: ctx.workspace._id },
        { $set: { applyPageEnabled: false }, $unset: { applyTokenHash: 1 } },
        { session },
      )
      await HireGuestSession.updateMany(
        { workspaceId: ctx.workspace._id, active: true },
        { $set: { revokedAt: deletedAt }, $unset: { active: 1 } },
        { session },
      )
      const rounds = await HireRound.find(
        { workspaceId: ctx.workspace._id },
        { _id: 1 },
        { session },
      )
      runtimeRoundIds = rounds.map((round) => round._id.toString())
      await HireRound.updateMany(
        { workspaceId: ctx.workspace._id, status: { $ne: 'completed' } },
        {
          $set: {
            status: 'revoked',
            revokedAt: deletedAt,
            revocationState: 'pending',
            revocationReason: 'Workspace scheduled for deletion',
          },
          $unset: { live: 1 },
        },
        { session },
      )
      await HireRound.updateMany(
        { workspaceId: ctx.workspace._id, status: 'completed' },
        {
          $set: {
            revokedAt: deletedAt,
            revocationState: 'pending',
            revocationReason: 'Workspace scheduled for deletion',
          },
          $unset: { live: 1 },
        },
        { session },
      )
      await HireEngineHandoff.updateMany(
        { workspaceId: ctx.workspace._id, revokedAt: { $exists: false } },
        { $set: { revokedAt: deletedAt } },
        { session },
      )
      await HireInterviewAttempt.updateMany(
        { workspaceId: ctx.workspace._id, live: true, status: { $ne: 'completed' } },
        { $set: { status: 'revoked' }, $unset: { live: 1 } },
        { session },
      )
    })
  } finally {
    await session.endSession()
  }
  if (!deleted) throw new Error('Workspace deletion transaction completed without a result')
  // The control-plane transaction makes every raw link/handoff unusable
  // immediately. Best-effort synchronous delivery also kills already-issued
  // runtime cookies; failures stay durable as pending/failed rounds for the
  // registered retry worker.
  for (let offset = 0; offset < runtimeRoundIds.length; offset += 10) {
    await Promise.all(
      runtimeRoundIds.slice(offset, offset + 10).map((roundId) =>
        deliverRuntimeRevocation(ctx.workspace._id.toString(), roundId),
      ),
    )
  }
  return deleted
}

export async function restoreWorkspace(
  ctx: MembershipContext,
  input: { operationId: string },
  now = new Date(),
): Promise<IHireWorkspace> {
  if (ctx.membership.role !== 'admin') {
    throw new ForbiddenError('Only the workspace admin can restore the workspace')
  }
  if (!OPERATION_ID.test(input.operationId)) {
    throw new AppError('Invalid operation id', 400, 'INVALID_OPERATION_ID')
  }
  await connectDB()

  const prior = await HireWorkspace.findOne({
    _id: ctx.workspace._id,
    lifecycleEvents: { $elemMatch: { operationId: input.operationId } },
  })
  if (prior) {
    const event = prior.lifecycleEvents.find(
      (candidate) => candidate.operationId === input.operationId,
    )
    if (event?.type !== 'deletion_cancelled') {
      throw new AppError(
        'That operation id was already used for another workspace action',
        409,
        'OPERATION_ID_REUSED',
      )
    }
    return prior
  }

  const restoredAt = new Date(now)
  const session = await mongoose.startSession()
  let restored: IHireWorkspace | undefined
  try {
    await session.withTransaction(async () => {
      const currentAdmin = await HireWorkspaceMember.exists({
        _id: ctx.membership._id,
        workspaceId: ctx.workspace._id,
        role: 'admin',
        authState: 'active',
      }).session(session)
      if (!currentAdmin) {
        throw new AppError('Admin changed; refresh and try again', 409, 'ADMIN_RACE')
      }
      restored =
        (await HireWorkspace.findOneAndUpdate(
          {
            _id: ctx.workspace._id,
            lifecycleState: 'deletion_pending',
            purgeAfter: { $gt: restoredAt },
            'lifecycleEvents.operationId': { $ne: input.operationId },
          },
          {
            $set: { lifecycleState: 'active' },
            $unset: {
              deletedAt: 1,
              purgeAfter: 1,
              deletedByMemberId: 1,
              deletedByName: 1,
            },
            $inc: { authorityVersion: 1 },
            $push: {
              lifecycleEvents: {
                type: 'deletion_cancelled',
                from: 'deletion_pending',
                to: 'active',
                actorMemberId: ctx.membership._id,
                actorName: memberActorName(ctx.membership),
                operationId: input.operationId,
                at: restoredAt,
              },
            },
          },
          { new: true, session },
        )) ?? undefined
      if (!restored) {
        const current = await HireWorkspace.findById(ctx.workspace._id).session(session)
        if (!current) throw new NotFoundError('Workspace')
        if (
          workspaceLifecycleState(current) === 'deletion_pending' &&
          current.purgeAfter &&
          current.purgeAfter <= restoredAt
        ) {
          throw new AppError(
            'The 30-day recovery window has ended',
            410,
            'WORKSPACE_RECOVERY_EXPIRED',
          )
        }
        throw new AppError(
          'Workspace lifecycle changed; refresh and try again',
          409,
          'WORKSPACE_LIFECYCLE_RACE',
        )
      }
    })
  } finally {
    await session.endSession()
  }
  if (!restored) throw new Error('Workspace restore transaction completed without a result')
  return restored
}
