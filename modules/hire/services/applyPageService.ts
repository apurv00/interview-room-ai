import crypto from 'crypto'
import type mongoose from 'mongoose'
import { connectDB } from '@shared/db/connection'
import { AppError, NotFoundError } from '@shared/errors'
import {
  HireJob,
  HireWorkspace,
  HireWorkspaceMember,
  type IHireJob,
} from '../models'
import type { MembershipContext } from './workspaceService'
import {
  decodeWorkspaceCapability,
  encodeWorkspaceCapability,
} from './workspaceCapability'

/**
 * Public apply page: a per-job shareable link that lets candidates submit
 * themselves into a workspace's pipeline without an account.
 *
 * Token model mirrors the AI-round invite (the pattern this repo already
 * trusts): 32 random bytes, shown to the recruiter ONCE, stored only as a
 * sha256 hash. A database dump therefore yields no working public URLs.
 * Rotating issues a new token and instantly kills every copy of the old
 * link — the only revocation mechanism a shared URL can have.
 */

export function sha256(value: string): string {
  return crypto.createHash('sha256').update(value).digest('hex')
}

export interface ApplyLinkResult {
  /** Workspace-scoped capability — returned ONCE; never stored or readable again. */
  capability: string
  enabled: boolean
}

/** Enable (or rotate) the public apply link for a job. Admin/member action. */
export async function issueApplyLink(
  ctx: MembershipContext,
  jobId: string,
): Promise<ApplyLinkResult> {
  await connectDB()
  const job = await HireJob.findOne({
    _id: jobId,
    workspaceId: ctx.workspace._id,
  })
  if (!job) throw new NotFoundError('Job')
  if (job.status === 'closed') {
    throw new AppError('This job is closed', 409, 'JOB_CLOSED')
  }
  const token = crypto.randomBytes(32).toString('hex')
  const update = await HireJob.updateOne(
    {
      _id: jobId,
      workspaceId: ctx.workspace._id,
      status: { $ne: 'closed' },
    },
    {
      $set: {
        applyTokenHash: sha256(token),
        applyPageEnabled: true,
      },
    },
    { runValidators: true },
  )
  if (update.matchedCount !== 1) {
    throw new AppError('This job is closed', 409, 'JOB_CLOSED')
  }
  return {
    capability: encodeWorkspaceCapability(ctx.workspace._id.toString(), token),
    enabled: true,
  }
}

/** Turn the page off. The hash is cleared so the old link cannot resume. */
export async function disableApplyLink(
  ctx: MembershipContext,
  jobId: string,
): Promise<{ enabled: false }> {
  await connectDB()
  const job = await HireJob.findOne({
    _id: jobId,
    workspaceId: ctx.workspace._id,
  })
  if (!job) throw new NotFoundError('Job')
  const update = await HireJob.updateOne(
    { _id: jobId, workspaceId: ctx.workspace._id },
    {
      $set: { applyPageEnabled: false },
      $unset: { applyTokenHash: 1 },
    },
    { runValidators: true },
  )
  if (update.matchedCount !== 1) throw new NotFoundError('Job')
  return { enabled: false }
}

export interface PublicJobView {
  job: IHireJob
  workspaceName: string
  applyTokenHash: string
}

/**
 * Resolve a raw apply token to its job. Returns null for EVERY failure
 * mode — bad token, disabled page, closed job — so the public surface
 * cannot be probed to distinguish "never existed" from "turned off"
 * (same posture as the invite page).
 */
export async function resolveApplyToken(
  rawCapability: string,
): Promise<PublicJobView | null> {
  await connectDB()
  const capability = decodeWorkspaceCapability(rawCapability)
  if (!capability) return null
  const applyTokenHash = sha256(capability.secret)
  const job = await HireJob.findOne({
    workspaceId: capability.workspaceId,
    applyTokenHash,
    applyPageEnabled: true,
    status: { $ne: 'closed' },
  })
  if (!job) return null
  const workspace = await HireWorkspace.findOne({
    _id: job.workspaceId,
    $or: [{ lifecycleState: 'active' }, { lifecycleState: { $exists: false } }],
  }).select('name')
  if (!workspace) return null
  return { job, workspaceName: workspace.name, applyTokenHash }
}

/**
 * Which active Hire member authorizes writes made on the workspace's behalf
 * by an anonymous applicant. This never queries or depends on a B2C User.
 *
 * Returns null when the workspace has no live member at all, which the
 * caller must treat as "not accepting applications" — checked BEFORE the
 * expensive work, not after.
 */
export async function resolveWorkspaceWriteAuthority(
  workspaceId: mongoose.Types.ObjectId,
): Promise<mongoose.Types.ObjectId | null> {
  await connectDB()
  const workspace = await HireWorkspace.exists({
    _id: workspaceId,
    $or: [{ lifecycleState: 'active' }, { lifecycleState: { $exists: false } }],
  })
  if (!workspace) return null
  const member = await HireWorkspaceMember.findOne({
    workspaceId,
    authState: 'active',
  }).sort({ role: 1, createdAt: 1 })
  return member?._id ?? null
}
