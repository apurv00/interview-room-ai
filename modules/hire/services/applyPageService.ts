import crypto from 'crypto'
import type mongoose from 'mongoose'
import { connectDB } from '@shared/db/connection'
import { AppError, NotFoundError } from '@shared/errors'
import { isJobsAccountActive } from '@shared/services/jobsAccountFence'
import { HireJob, HireWorkspace, HireWorkspaceMember, type IHireJob } from '../models'
import type { MembershipContext } from './workspaceService'

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
  /** Raw token — returned ONCE at mint time; never readable again. */
  token: string
  enabled: boolean
}

/** Enable (or rotate) the public apply link for a job. Admin/member action. */
export async function issueApplyLink(
  ctx: MembershipContext,
  jobId: string,
): Promise<ApplyLinkResult> {
  await connectDB()
  const job = await HireJob.findOne({ _id: jobId, workspaceId: ctx.workspace._id })
  if (!job) throw new NotFoundError('Job')
  if (job.status === 'closed') {
    throw new AppError('This job is closed', 409, 'JOB_CLOSED')
  }
  const token = crypto.randomBytes(32).toString('hex')
  job.applyTokenHash = sha256(token)
  job.applyPageEnabled = true
  await job.save()
  return { token, enabled: true }
}

/** Turn the page off. The hash is cleared so the old link cannot resume. */
export async function disableApplyLink(
  ctx: MembershipContext,
  jobId: string,
): Promise<{ enabled: false }> {
  await connectDB()
  const job = await HireJob.findOne({ _id: jobId, workspaceId: ctx.workspace._id })
  if (!job) throw new NotFoundError('Job')
  job.applyPageEnabled = false
  job.applyTokenHash = undefined
  await job.save()
  return { enabled: false }
}

export interface PublicJobView {
  job: IHireJob
  workspaceName: string
}

/**
 * Resolve a raw apply token to its job. Returns null for EVERY failure
 * mode — bad token, disabled page, closed job — so the public surface
 * cannot be probed to distinguish "never existed" from "turned off"
 * (same posture as the invite page).
 */
export async function resolveApplyToken(rawToken: string): Promise<PublicJobView | null> {
  await connectDB()
  if (!/^[a-f0-9]{64}$/i.test(rawToken)) return null
  const job = await HireJob.findOne({
    applyTokenHash: sha256(rawToken),
    applyPageEnabled: true,
    status: { $ne: 'closed' },
  })
  if (!job) return null
  const workspace = await HireWorkspace.findById(job.workspaceId).select('name')
  if (!workspace) return null
  return { job, workspaceName: workspace.name }
}


/**
 * Whose account state gates writes made on the workspace's behalf by an
 * anonymous applicant.
 *
 * NOT job.createdBy: a member who created a job and later deleted their
 * account leaves the job (and its live apply link) behind, and binding the
 * write barrier to that vanished User would fail EVERY submission —
 * silently, and only after the parse and model call had already been paid
 * for (Codex P1 on #615). The authority is therefore resolved at submit
 * time to a member who actually still exists: the workspace admin if
 * possible, else any linked member.
 *
 * Returns null when the workspace has no live member at all, which the
 * caller must treat as "not accepting applications" — checked BEFORE the
 * expensive work, not after.
 */
export async function resolveWorkspaceWriteAuthority(
  workspaceId: mongoose.Types.ObjectId,
): Promise<mongoose.Types.ObjectId | null> {
  await connectDB()
  const members = await HireWorkspaceMember.find({
    workspaceId,
    userId: { $exists: true },
  })
    // Admin first — the workspace's owner is the natural authority.
    .sort({ role: 1, createdAt: 1 })
  for (const member of members) {
    if (!member.userId) continue
    if (await isJobsAccountActive(member.userId.toString())) return member.userId
  }
  return null
}
