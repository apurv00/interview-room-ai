import crypto from 'crypto'
import mongoose from 'mongoose'
import {
  INTERVIEW_ROLE_SLUG_MAX_CHARS,
  INTERVIEW_JOB_DESCRIPTION_MAX_CHARS,
} from '@shared/interviewContract'
import { AppError, NotFoundError } from '@shared/errors'
import {
  HireCandidate,
  HireJob,
  HireRound,
  HireApplication,
  HireJobRequirementVersion,
  HirePrivacyRequest,
  HireWorkspace,
  type IHireRound,
} from '../models'
import { appendApplicationEvent } from './pipelineService'
import type { MembershipContext } from './workspaceService'
import { connectHireControlDB } from './hireControlBoundary'
import {
  deliverRuntimeRevocation,
  revokeControlPlaneGuestAccess,
} from './engineRevocationService'
import { withActiveHireWorkspaceWriteTransaction } from './hireWorkspaceWriteFence'
import {
  claimHireCandidatePiiWriteFence,
  HireCandidatePiiTombstoneError,
} from './hireCandidatePrivacyWriteFence'
import { claimNonTerminalHireApplicationDispatchFence } from './hireApplicationDispatchFence'
import {
  decodeWorkspaceCapability,
} from './workspaceCapability'
import {
  createAiInviteDeliveryRecord,
  deliverAiInvite,
} from './aiInviteDeliveryService'

/**
 * AI interview rounds — the hire side of the engine seams.
 *
 * Seam discipline (goal item 2): this service writes ONLY hire tables. The
 * engine is consumed through (1) session provisioning — the guest enters the
 * engine's own public flow with a config this service hands out at prepare
 * time; (2) the completion event — roundLinkService reconciles the engine's
 * completed session read-only; (3) guest-session auth — candidate verification
 * issues a Hire-scoped guest cookie, and the isolated runtime later exchanges
 * its own one-time handoff ticket through the runtime-only `invite-otp`
 * provider. No B2C row is written from this module.
 */

/** Fixed depth for Phase 1 AI screening rounds (build plan: fixed over
 * configurable). 'behavioral' is unrestricted across experience bands. */
export const AI_ROUND_INTERVIEW_TYPE = 'behavioral'

export const INVITE_TOKEN_EXPIRY_DAYS = 7

export function sha256(value: string): string {
  return crypto.createHash('sha256').update(value).digest('hex')
}

/**
 * Synthetic per-round guest identity. The engine requires a User row +
 * NextAuth session for every interview API call, but guests must not be
 * keyed by their real email: sharing a User across workspaces/rounds caused
 * the whole identity edge-case class (cross-workspace ambiguity, OAuth
 * account-linking hazards, real-email accounts left roaming the B2C
 * product). One synthetic user per round makes round↔session attribution
 * exact by userId alone, and keeps candidate PII in workspace-scoped hire
 * tables only. `.internal` is ICANN-reserved — never routable.
 */
export function buildJdSnapshot(input: {
  proseJd: string
  version: number
  contentHash: string
  requirements: Array<{ id: string; text: string; importance: string }>
}): string {
  const contract = [
    '## Immutable interview scoring contract',
    `Requirement version: ${input.version}`,
    `Requirement hash: ${input.contentHash}`,
    ...input.requirements.map(
      (requirement) =>
        `- [${requirement.importance.toUpperCase()}][${requirement.id}] ${requirement.text}`,
    ),
  ].join('\n')
  const proseBudget = INTERVIEW_JOB_DESCRIPTION_MAX_CHARS - contract.length - 1
  if (proseBudget < 1) {
    throw new AppError(
      'The structured requirement contract exceeds the interview engine limit',
      422,
      'JOB_REQUIREMENTS_TOO_LARGE',
    )
  }
  return `${input.proseJd.trim().slice(0, proseBudget)}\n${contract}`
}

const PRE_AUTH_STATUSES = ['invited', 'consented'] as const

export type RoundTokenState = 'ok' | 'expired' | 'completed' | 'revoked'

export interface VerifiedRound {
  round: IHireRound
  state: RoundTokenState
}

// ─── Send ─────────────────────────────────────────────────────────────────────

export interface SendAiRoundInput {
  applicationId: string
  experience: '0-2' | '3-6' | '7+'
  duration: number
}

export interface SendAiRoundResult {
  round: IHireRound
  inviteUrl: string
  emailSent: boolean
}

export async function sendAiRound(
  ctx: MembershipContext,
  input: SendAiRoundInput
): Promise<SendAiRoundResult> {
  await connectHireControlDB()

  const application = await HireApplication.findOne({
    _id: input.applicationId,
    workspaceId: ctx.workspace._id,
  })
  if (!application) throw new NotFoundError('Application')

  const [job, candidate] = await Promise.all([
    HireJob.findOne({ _id: application.jobId, workspaceId: ctx.workspace._id }),
    HireCandidate.findOne({ _id: application.candidateId, workspaceId: ctx.workspace._id }),
  ])
  if (!job || !candidate) throw new NotFoundError('Application')
  if (job.status !== 'open') {
    throw new AppError('AI interviews can only be sent for open jobs', 409, 'JOB_NOT_OPEN')
  }
  if (!job.activeRequirementVersionId || !job.activeRequirementVersion) {
    throw new AppError(
      'Review and activate the structured job requirements before sending an interview',
      409,
      'JOB_REQUIREMENTS_NOT_ACTIVE',
    )
  }
  const requirementVersion = await HireJobRequirementVersion.findOne({
    _id: job.activeRequirementVersionId,
    workspaceId: ctx.workspace._id,
    jobId: job._id,
    version: job.activeRequirementVersion,
    state: 'active',
  })
  if (!requirementVersion) {
    throw new AppError(
      'The active job requirements are unavailable; review the job before sending',
      409,
      'JOB_REQUIREMENTS_NOT_ACTIVE',
    )
  }

  // One live AI round per application. A pre-auth round whose link expired is
  // superseded explicitly (revoked + re-sent), never silently reused.
  const existing = await HireRound.find({
    workspaceId: ctx.workspace._id,
    applicationId: application._id,
    kind: 'ai',
    status: { $nin: ['completed', 'revoked'] },
  })
  const now = new Date()
  for (const r of existing) {
    const preAuth = (PRE_AUTH_STATUSES as readonly string[]).includes(r.status)
    if (preAuth && r.inviteTokenExpiry <= now) {
      await HireRound.updateOne(
        { _id: r._id, workspaceId: ctx.workspace._id },
        {
          $set: {
            status: 'revoked',
            revokedAt: now,
            revocationState: 'confirmed',
            revocationConfirmedAt: now,
            revocationReason: 'Interview invitation expired and was superseded',
            ...(ctx.membership.userId ? { revokedBy: ctx.membership.userId } : {}),
            revokedByMemberId: ctx.membership._id,
            revokedByName: ctx.membership.name || ctx.membership.email,
          },
          $unset: { live: 1 },
        }
      )
      await revokeControlPlaneGuestAccess({
        workspaceId: r.workspaceId.toString(),
        applicationId: r.applicationId.toString(),
        roundId: r._id.toString(),
        revokedAt: now,
      })
      await appendApplicationEvent(ctx.workspace._id, application._id, {
        type: 'ai_round_revoked',
        ...(ctx.membership.userId ? { actorUserId: ctx.membership.userId } : {}),
        actorMemberId: ctx.membership._id,
        actorName: ctx.membership.name || ctx.membership.email,
        note: 'Previous AI interview link expired — superseded by a new invite',
      })
    } else {
      throw new AppError(
        'An AI interview is already in flight for this candidate. Revoke it before sending a new one.',
        409,
        'ROUND_IN_FLIGHT'
      )
    }
  }

  const token = crypto.randomBytes(32).toString('hex')
  const roundId = new mongoose.Types.ObjectId()
  const jdSnapshot = buildJdSnapshot({
    proseJd: requirementVersion.proseJd,
    version: requirementVersion.version,
    contentHash: requirementVersion.contentHash,
    requirements: requirementVersion.requirements,
  })
  const inviteTokenExpiry = new Date(
    now.getTime() + INVITE_TOKEN_EXPIRY_DAYS * 24 * 60 * 60 * 1000,
  )
  let round: IHireRound
  try {
    round = await withActiveHireWorkspaceWriteTransaction(
      ctx.workspace._id,
      ctx.membership._id,
      async (session) => {
        const jobClaim = await HireJob.updateOne(
          { _id: job._id, workspaceId: ctx.workspace._id, status: 'open' },
          { $inc: { intakeWriteVersion: 1 } },
          { session },
        )
        if (jobClaim.matchedCount !== 1) {
          throw new AppError('AI interviews can only be sent for open jobs', 409, 'JOB_NOT_OPEN')
        }
        // This is the creation-side half of the stage/egress fence. The
        // application was read before this transaction, so it must be
        // conditionally claimed here rather than trusting that stale read.
        await claimNonTerminalHireApplicationDispatchFence({
          workspaceId: ctx.workspace._id,
          applicationId: application._id,
          jobId: job._id,
          candidateId: candidate._id,
          now,
          session,
        })
        // The candidate row is the deletion/egress serialization point. A
        // verified privacy deletion that commits first makes this transaction
        // fail before it creates either a round or its encrypted delivery
        // recovery record. A live request is also a hard stop: it avoids
        // creating a fresh invitation while deletion is being verified.
        const privacyRequest = await HirePrivacyRequest.exists({
          workspaceId: ctx.workspace._id,
          candidateId: candidate._id,
          live: true,
        }).session(session)
        if (privacyRequest) {
          throw new AppError(
            'A candidate privacy request is in progress',
            409,
            'CANDIDATE_PRIVACY_PENDING',
          )
        }
        await claimHireCandidatePiiWriteFence({
          workspaceId: ctx.workspace._id,
          candidateId: candidate._id,
          session,
        })
        const authMode = ctx.workspace.guestAuthMode === 'otp' ? 'otp' : 'magic_link'
        const created = await HireRound.create([{
          _id: roundId,
          workspaceId: ctx.workspace._id,
          applicationId: application._id,
          jobId: job._id,
          candidateId: candidate._id,
          candidateEmail: candidate.email,
          candidateName: candidate.name,
          kind: 'ai',
          status: 'invited',
          // Snapshot the workspace's verification mode — links already in
          // inboxes must keep the semantics they were sent with.
          authMode,
          live: true,
          inviteTokenHash: sha256(token),
          inviteTokenExpiry,
          invitedAt: now,
          config: {
            // The engine's role contract caps at 100 chars; job titles are the
            // role in Phase 1, so clamp — a longer title must never produce a
            // config the engine's CreateSessionSchema would reject mid-flow.
            role: job.title.slice(0, INTERVIEW_ROLE_SLUG_MAX_CHARS),
            interviewType: AI_ROUND_INTERVIEW_TYPE,
            experience: input.experience,
            duration: input.duration,
          },
          jdHash: sha256(jdSnapshot),
          jdSnapshot,
          requirementVersionId: requirementVersion._id,
          requirementVersion: requirementVersion.version,
          requirementHash: requirementVersion.contentHash,
          ...(ctx.membership.userId ? { createdBy: ctx.membership.userId } : {}),
          createdByMemberId: ctx.membership._id,
          createdByName: ctx.membership.name || ctx.membership.email,
        }], { session })
        // This encrypted recovery record commits atomically with the
        // hash-only round. A crash after commit can no longer strand it.
        await createAiInviteDeliveryRecord({
          workspaceId: ctx.workspace._id.toString(),
          applicationId: application._id.toString(),
          jobId: job._id.toString(),
          candidateId: candidate._id.toString(),
          roundId: roundId.toString(),
          recipientEmail: candidate.email,
          recipientName: candidate.name,
          jobTitle: job.title,
          workspaceName: ctx.workspace.name,
          verifyByCode: authMode === 'otp',
          expiresAt: inviteTokenExpiry,
          rawToken: token,
          session,
        })
        return created[0]
      },
    )
  } catch (err: unknown) {
    if (err instanceof HireCandidatePiiTombstoneError) {
      throw new AppError(
        'Candidate personal data is unavailable',
        410,
        'HIRE_CANDIDATE_PII_TOMBSTONED',
      )
    }
    // Partial unique index {workspaceId, applicationId, live:true}: a
    // concurrent send won the race — same outcome as the fast-path check.
    if (err && typeof err === 'object' && (err as { code?: number }).code === 11000) {
      throw new AppError(
        'An AI interview is already in flight for this candidate. Revoke it before sending a new one.',
        409,
        'ROUND_IN_FLIGHT'
      )
    }
    throw err
  }

  const delivery = await deliverAiInvite(ctx, round._id.toString())
  const inviteUrl = delivery.view.inviteUrl
  if (!inviteUrl) {
    throw new AppError(
      'The invitation was created but its copyable link is unavailable',
      503,
      'INVITE_DELIVERY_RECOVERY_FAILED',
    )
  }

  // The audit log must never claim a delivery that didn't happen — after a
  // reload, this event is the only record of whether the candidate was
  // actually contacted.
  await appendApplicationEvent(ctx.workspace._id, application._id, {
    type: 'ai_round_sent',
    ...(ctx.membership.userId ? { actorUserId: ctx.membership.userId } : {}),
    actorMemberId: ctx.membership._id,
    actorName: ctx.membership.name || ctx.membership.email,
    note: delivery.emailSent
      ? 'AI interview invite sent'
      : 'AI interview invite created — EMAIL DELIVERY FAILED; copy the saved link or retry delivery',
  })

  return { round, inviteUrl, emailSent: delivery.emailSent }
}

// ─── Guest-side: token verification, consent, auth binding, prepare ──────────

/**
 * Verify a raw invite token against a round. Constant-shape: callers render a
 * generic invalid page for null; state distinguishes only presentable cases.
 */
export async function verifyRoundToken(
  roundId: string,
  rawCapability: string
): Promise<VerifiedRound | null> {
  await connectHireControlDB()
  const capability = decodeWorkspaceCapability(rawCapability)
  if (!/^[a-f0-9]{24}$/i.test(roundId) || !capability) return null
  const round = await HireRound.findOne({
    _id: roundId,
    workspaceId: capability.workspaceId,
    inviteTokenHash: sha256(capability.secret),
  })
  if (!round) return null
  const workspaceActive = await HireWorkspace.exists({
    _id: round.workspaceId,
    $or: [{ lifecycleState: 'active' }, { lifecycleState: { $exists: false } }],
  })
  if (!workspaceActive) return null
  if (round.revokedAt) return { round, state: 'revoked' }
  if (round.status === 'completed') return { round, state: 'completed' }
  // The RAW emailed credential dies at inviteTokenExpiry, full stop —
  // regardless of round status. A copied or leaked link must not outlive
  // its advertised deadline (Codex P1 on #604). Mid-flow candidates resume
  // via their authenticated session on /prepare, which has its own
  // POST_AUTH_GRACE_DAYS ceiling and never takes the raw token.
  if (round.inviteTokenExpiry <= new Date()) {
    return { round, state: 'expired' }
  }
  return { round, state: 'ok' }
}

// ─── Member-side: revoke ─────────────────────────────────────────────────────

export async function revokeRound(
  ctx: MembershipContext,
  roundId: string
): Promise<IHireRound> {
  await connectHireControlDB()
  const round = await HireRound.findOneAndUpdate(
    {
      _id: roundId,
      workspaceId: ctx.workspace._id,
      status: { $nin: ['completed', 'revoked'] },
    },
    {
      $set: {
        status: 'revoked',
        revokedAt: new Date(),
        revocationState: 'pending',
        revocationReason: 'Recruiter revoked the interview invitation',
        ...(ctx.membership.userId ? { revokedBy: ctx.membership.userId } : {}),
        revokedByMemberId: ctx.membership._id,
        revokedByName: ctx.membership.name || ctx.membership.email,
      },
      $unset: { live: 1 },
    },
    { new: true }
  )
  if (!round) throw new NotFoundError('Round')

  await revokeControlPlaneGuestAccess({
    workspaceId: round.workspaceId.toString(),
    applicationId: round.applicationId.toString(),
    roundId: round._id.toString(),
    revokedAt: round.revokedAt!,
  })
  await deliverRuntimeRevocation(
    ctx.workspace._id.toString(),
    round._id.toString(),
  )

  await appendApplicationEvent(ctx.workspace._id, round.applicationId, {
    type: 'ai_round_revoked',
    ...(ctx.membership.userId ? { actorUserId: ctx.membership.userId } : {}),
    actorMemberId: ctx.membership._id,
    actorName: ctx.membership.name || ctx.membership.email,
    note: 'AI interview link revoked',
  })
  return (await HireRound.findOne({
    _id: round._id,
    workspaceId: ctx.workspace._id,
  })) ?? round
}
