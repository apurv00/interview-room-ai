import { connectDB } from '@shared/db/connection'
import { User } from '@shared/db/models'
import { AppError, ForbiddenError, NotFoundError } from '@shared/errors'
import {
  HireWorkspace,
  HireWorkspaceMember,
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

  let membership = await HireWorkspaceMember.findOne({ userId: actor.userId })
  if (!membership && actor.email) {
    membership = await HireWorkspaceMember.findOneAndUpdate(
      {
        email: actor.email.toLowerCase(),
        $or: [{ userId: { $exists: false } }, { userId: null }],
      },
      { $set: { userId: actor.userId } },
      { new: true }
    )
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
  name: string
): Promise<MembershipContext> {
  await connectDB()

  const existing = await getWorkspaceForUser(actor)
  if (existing) {
    throw new AppError('You already belong to a workspace', 409, 'WORKSPACE_EXISTS')
  }

  const workspace = await HireWorkspace.create({ name, createdBy: actor.userId })
  const membership = await HireWorkspaceMember.create({
    workspaceId: workspace._id,
    email: actor.email.toLowerCase(),
    name: actor.name,
    userId: actor.userId,
    role: 'admin',
    addedBy: actor.userId,
  })
  return { workspace, membership }
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

  try {
    return await HireWorkspaceMember.create({
      workspaceId: ctx.workspace._id,
      email,
      name: input.name,
      userId: linked?._id,
      role: 'member',
      addedBy: ctx.membership.userId,
    })
  } catch (err: unknown) {
    if (err && typeof err === 'object' && (err as { code?: number }).code === 11000) {
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
