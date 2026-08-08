import { connectDB } from '@shared/db/connection'
import { User } from '@shared/db/models'
import { AppError, ForbiddenError, NotFoundError } from '@shared/errors'
import {
  HireWorkspace,
  HireWorkspaceMember,
  type GuestAuthMode,
  type IHireWorkspace,
  type IHireWorkspaceMember,
} from '../models'

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
 * Resolve the caller's workspace. Membership is matched by linked userId
 * first; otherwise by email, in which case the row is linked to the User on
 * the spot (the "provisioned or linked on the spot" behavior — the admin
 * added them by email before they ever signed in).
 */
export async function getWorkspaceForUser(
  actor: WorkspaceActor
): Promise<MembershipContext | null> {
  await connectDB()

  // Earliest-membership-wins on both lookups: one workspace per user is the
  // Phase 1 rule, and resolution must be deterministic even if data ever
  // holds more than one row (Codex P1 on #603).
  let membership = await HireWorkspaceMember.findOne({ userId: actor.userId }, null, {
    sort: { createdAt: 1 },
  })
  if (!membership && actor.email) {
    try {
      membership = await HireWorkspaceMember.findOneAndUpdate(
        {
          email: actor.email.toLowerCase(),
          $or: [{ userId: { $exists: false } }, { userId: null }],
        },
        { $set: { userId: actor.userId } },
        { new: true, sort: { createdAt: 1 } }
      )
    } catch (err: unknown) {
      // Unique sparse userId index: a concurrent request linked this user
      // elsewhere between our two lookups — resolve to that membership.
      if (err && typeof err === 'object' && (err as { code?: number }).code === 11000) {
        membership = await HireWorkspaceMember.findOne({ userId: actor.userId }, null, {
          sort: { createdAt: 1 },
        })
      } else {
        throw err
      }
    }
  }
  if (!membership) return null

  const workspace = await HireWorkspace.findById(membership.workspaceId)
  if (!workspace) return null
  return { workspace, membership }
}

/** Tenancy gate for every member API route. */
export async function requireMembership(actor: WorkspaceActor): Promise<MembershipContext> {
  const ctx = await getWorkspaceForUser(actor)
  if (!ctx) {
    throw new ForbiddenError('Workspace membership required')
  }
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
    const membership = await HireWorkspaceMember.create({
      workspaceId: workspace._id,
      email: actor.email.toLowerCase(),
      name: actor.name,
      userId: actor.userId,
      role: 'admin',
      addedBy: actor.userId,
    })
    return { workspace, membership }
  } catch (err: unknown) {
    // Unique sparse userId index: a concurrent createWorkspace won the race.
    // Remove the now-orphaned workspace and surface the same 409 the
    // fast-path check gives.
    if (err && typeof err === 'object' && (err as { code?: number }).code === 11000) {
      await HireWorkspace.deleteOne({ _id: workspace._id })
      throw new AppError('You already belong to a workspace', 409, 'WORKSPACE_EXISTS')
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
  input: { guestAuthMode: GuestAuthMode }
): Promise<IHireWorkspace> {
  if (ctx.membership.role !== 'admin') {
    throw new ForbiddenError('Only the workspace admin can change settings')
  }
  await connectDB()
  const workspace = await HireWorkspace.findOneAndUpdate(
    { _id: ctx.workspace._id },
    { $set: { guestAuthMode: input.guestAuthMode } },
    { new: true }
  )
  if (!workspace) throw new NotFoundError('Workspace')
  return workspace
}

export interface AddMemberInput {
  email: string
  name?: string
}

/**
 * Admin adds an HR-team member by name + email — no invite flow (build plan
 * §Permission model). We do NOT create a B2C User here: minting a bare-email
 * user would break the member's later OAuth sign-in (OAuthAccountNotLinked).
 * If a User with that email already exists we link it; otherwise the row
 * links lazily on their first sign-in via getWorkspaceForUser.
 */
export async function addMember(
  ctx: MembershipContext,
  input: AddMemberInput
): Promise<IHireWorkspaceMember> {
  if (ctx.membership.role !== 'admin') {
    throw new ForbiddenError('Only the workspace admin can add members')
  }
  await connectDB()

  const email = input.email.toLowerCase()
  const linked = await User.findOne({ email }).select('_id').lean()

  // Link the User only if they aren't already a linked member of ANY
  // workspace — one workspace per user (Phase 1 rule). Eagerly linking a
  // second workspace would make getWorkspaceForUser's resolution ambiguous;
  // instead the row stays email-only and visibly "not signed in yet".
  let linkableUserId = linked?._id
  if (linkableUserId) {
    const alreadyLinked = await HireWorkspaceMember.findOne({ userId: linkableUserId })
      .select('_id')
      .lean()
    if (alreadyLinked) linkableUserId = undefined
  }

  const memberDoc = (userId?: typeof linkableUserId) => ({
    workspaceId: ctx.workspace._id,
    email,
    name: input.name,
    userId,
    role: 'member' as const,
    addedBy: ctx.membership.userId,
  })

  try {
    return await HireWorkspaceMember.create(memberDoc(linkableUserId))
  } catch (err: unknown) {
    if (err && typeof err === 'object' && (err as { code?: number }).code === 11000) {
      // Which unique index fired? {workspaceId,email} → genuine duplicate.
      // {userId} → a concurrent request linked this user elsewhere between
      // our pre-check and create — fall back to an email-only row (same
      // outcome as the pre-check path: "not signed in yet").
      const keyPattern = (err as { keyPattern?: Record<string, unknown> }).keyPattern ?? {}
      if (linkableUserId && 'userId' in keyPattern) {
        return await HireWorkspaceMember.create(memberDoc(undefined))
      }
      throw new AppError('This person is already a member', 409, 'MEMBER_EXISTS')
    }
    throw err
  }
}

export async function listMembers(ctx: MembershipContext): Promise<IHireWorkspaceMember[]> {
  await connectDB()
  return HireWorkspaceMember.find({ workspaceId: ctx.workspace._id }).sort({ createdAt: 1 })
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
  await HireWorkspaceMember.deleteOne({ _id: target._id, workspaceId: ctx.workspace._id })
}
