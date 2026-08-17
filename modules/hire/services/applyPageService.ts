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
import { withActiveHireWorkspaceWriteTransaction } from './hireWorkspaceWriteFence'
import {
  decodeWorkspaceCapability,
  encodeWorkspaceCapability,
} from './workspaceCapability'
import {
  assertHireOnboardingTestDriveWriteIsolation,
  isHireOnboardingTestDriveCoordinate,
} from '@hire-onboarding-boundary'

/**
 * Public apply page: a per-job shareable link that lets candidates submit
 * themselves into a workspace's pipeline without an account. The public
 * lookup stays hash-only. The current secret also stays on the job, hidden
 * from normal reads, so authenticated HR can copy the same URL again.
 */

export function sha256(value: string): string {
  return crypto.createHash('sha256').update(value).digest('hex')
}

export interface ApplyLinkResult {
  /** Workspace-scoped capability, retrievable later by workspace members. */
  capability: string
  enabled: boolean
}

/** Enable (or rotate) the public apply link for a job. Admin/member action. */
export async function issueApplyLink(
  ctx: MembershipContext,
  jobId: string,
): Promise<ApplyLinkResult> {
  await connectDB()
  const token = crypto.randomBytes(32).toString('hex')
  return withActiveHireWorkspaceWriteTransaction(
    ctx.workspace._id,
    ctx.membership._id,
    async (session) => {
      await assertHireOnboardingTestDriveWriteIsolation({
        workspaceId: ctx.workspace._id,
        jobId,
        session,
      })
      const job = await HireJob.findOne(
        {
          _id: jobId,
          workspaceId: ctx.workspace._id,
        },
        null,
        { session },
      )
      if (!job) throw new NotFoundError('Job')
      if (job.status === 'closed') {
        throw new AppError('This job is closed', 409, 'JOB_CLOSED')
      }
      const update = await HireJob.updateOne(
        {
          _id: jobId,
          workspaceId: ctx.workspace._id,
          status: { $ne: 'closed' },
        },
        {
          $set: {
            applyTokenHash: sha256(token),
            applyTokenSecret: token,
            applyPageEnabled: true,
          },
        },
        { runValidators: true, session },
      )
      if (update.matchedCount !== 1) {
        throw new AppError('This job is closed', 409, 'JOB_CLOSED')
      }
      return {
        capability: encodeWorkspaceCapability(ctx.workspace._id.toString(), token),
        enabled: true,
      }
    },
  )
}

/** Recover the active link only for a member of the owning workspace. */
export async function recoverApplyLink(
  ctx: MembershipContext,
  jobId: string,
): Promise<string | null> {
  await connectDB()
  const job = await HireJob.findOne({
    _id: jobId,
    workspaceId: ctx.workspace._id,
  }).select('+applyTokenSecret')
  if (!job) throw new NotFoundError('Job')
  if (job.status === 'closed' || !job.applyPageEnabled || !job.applyTokenSecret) return null
  return encodeWorkspaceCapability(ctx.workspace._id.toString(), job.applyTokenSecret)
}

/** Turn the page off and erase both public lookup and visible-link material. */
export async function disableApplyLink(
  ctx: MembershipContext,
  jobId: string,
): Promise<{ enabled: false }> {
  await connectDB()
  const update = await HireJob.updateOne(
    { _id: jobId, workspaceId: ctx.workspace._id },
    {
      $set: { applyPageEnabled: false },
      $unset: { applyTokenHash: 1, applyTokenSecret: 1 },
    },
    { runValidators: true },
  )
  if (update.matchedCount !== 1) throw new NotFoundError('Job')
  return { enabled: false }
}

export interface PublicJobView {
  job: IHireJob
  workspaceName: string
  /** Company-authored context, disclosed only after a valid apply capability. */
  companyDescription: string | null
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
  if (
    await isHireOnboardingTestDriveCoordinate({
      workspaceId: job.workspaceId,
      jobId: job._id,
    })
  ) {
    return null
  }
  const workspace = await HireWorkspace.findOne({
    _id: job.workspaceId,
    $or: [{ lifecycleState: 'active' }, { lifecycleState: { $exists: false } }],
  }).select('name companyDescription companyBlurb')
  if (!workspace) return null
  return {
    job,
    workspaceName: workspace.name,
    companyDescription: workspace.companyDescription ?? workspace.companyBlurb ?? null,
    applyTokenHash,
  }
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
