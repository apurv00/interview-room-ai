import crypto from 'crypto'
import { connectDB } from '@shared/db/connection'
import { AppError, NotFoundError } from '@shared/errors'
import { sendEmail } from '@shared/services/emailService'
import { logger } from '@shared/logger'
import {
  HireCandidate,
  HireJob,
  HireRound,
  HireApplication,
  HireWorkspace,
  type IHireRound,
} from '../models'
import { buildAiInviteEmail } from '../emails/aiInviteEmail'
import { appendApplicationEvent } from './pipelineService'
import type { MembershipContext } from './workspaceService'

/**
 * AI interview rounds — the hire side of the engine seams.
 *
 * Seam discipline (goal item 2): this service writes ONLY hire tables. The
 * engine is consumed through (1) session provisioning — the guest enters the
 * engine's own public flow with a config this service hands out at prepare
 * time; (2) the completion event — roundLinkService reconciles the engine's
 * completed session read-only; (3) guest-session auth — the app-layer
 * verify-otp route reuses the existing OTP + ticket + `invite-otp` provider.
 * No engine file is modified and no B2C row is written from this module.
 */

export const HIRE_CONSENT_VERSION = 'hire-ai-v1-2026-08'

/** Fixed depth for Phase 1 AI screening rounds (build plan: fixed over
 * configurable). 'behavioral' is unrestricted across experience bands. */
export const AI_ROUND_INTERVIEW_TYPE = 'behavioral'

export const INVITE_TOKEN_EXPIRY_DAYS = 7

export function sha256(value: string): string {
  return crypto.createHash('sha256').update(value).digest('hex')
}

function appBaseUrl(): string {
  return (
    process.env.APP_URL || process.env.NEXTAUTH_URL || 'https://www.interviewprep.guru'
  ).replace(/\/$/, '')
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
  await connectDB()

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
        { $set: { status: 'revoked', revokedAt: now, revokedBy: ctx.membership.userId } }
      )
    } else {
      throw new AppError(
        'An AI interview is already in flight for this candidate. Revoke it before sending a new one.',
        409,
        'ROUND_IN_FLIGHT'
      )
    }
  }

  const token = crypto.randomBytes(32).toString('hex')
  const round = await HireRound.create({
    workspaceId: ctx.workspace._id,
    applicationId: application._id,
    jobId: job._id,
    candidateId: candidate._id,
    candidateEmail: candidate.email,
    candidateName: candidate.name,
    kind: 'ai',
    status: 'invited',
    inviteTokenHash: sha256(token),
    inviteTokenExpiry: new Date(Date.now() + INVITE_TOKEN_EXPIRY_DAYS * 24 * 60 * 60 * 1000),
    invitedAt: now,
    config: {
      role: job.title,
      interviewType: AI_ROUND_INTERVIEW_TYPE,
      experience: input.experience,
      duration: input.duration,
    },
    jdHash: sha256(job.jdText),
    createdBy: ctx.membership.userId,
  })

  const inviteUrl = `${appBaseUrl()}/candidate/${round._id.toString()}?token=${token}`
  const email = buildAiInviteEmail({
    candidateName: candidate.name,
    jobTitle: job.title,
    workspaceName: ctx.workspace.name,
    inviteUrl,
    expiryDays: INVITE_TOKEN_EXPIRY_DAYS,
  })
  const sent = await sendEmail({
    to: candidate.email,
    subject: email.subject,
    html: email.html,
  })
  if (!sent.ok) {
    logger.warn(
      { roundId: round._id.toString() },
      'hire: AI invite email not sent (send failed or email not configured) — link available in UI'
    )
  }

  await appendApplicationEvent(ctx.workspace._id, application._id, {
    type: 'ai_round_sent',
    actorUserId: ctx.membership.userId,
    actorName: ctx.membership.name || ctx.membership.email,
    note: `AI interview invite sent to ${candidate.email}`,
  })

  return { round, inviteUrl, emailSent: sent.ok }
}

// ─── Guest-side: token verification, consent, auth binding, prepare ──────────

/**
 * Verify a raw invite token against a round. Constant-shape: callers render a
 * generic invalid page for null; state distinguishes only presentable cases.
 */
export async function verifyRoundToken(
  roundId: string,
  rawToken: string
): Promise<VerifiedRound | null> {
  await connectDB()
  if (!/^[a-f0-9]{24}$/i.test(roundId) || !/^[a-f0-9]{64}$/i.test(rawToken)) return null
  const round = await HireRound.findOne({
    _id: roundId,
    inviteTokenHash: sha256(rawToken),
  })
  if (!round) return null
  if (round.revokedAt) return { round, state: 'revoked' }
  if (round.status === 'completed') return { round, state: 'completed' }
  const preAuth = (PRE_AUTH_STATUSES as readonly string[]).includes(round.status)
  if (preAuth && round.inviteTokenExpiry <= new Date()) {
    return { round, state: 'expired' }
  }
  return { round, state: 'ok' }
}

/**
 * Record consent + recording disclosure acceptance. Idempotent — the first
 * acceptance wins and the timestamp never moves. OTP issuance and everything
 * downstream requires consentAt to be set: consent gates the AI interview.
 */
export async function recordConsent(
  roundId: string,
  rawToken: string,
  meta: { userAgent?: string }
): Promise<IHireRound> {
  const verified = await verifyRoundToken(roundId, rawToken)
  if (!verified || verified.state !== 'ok') {
    throw new AppError('This interview link is no longer valid', 410, 'ROUND_LINK_INVALID')
  }
  const updated = await HireRound.findOneAndUpdate(
    { _id: verified.round._id, consentAt: { $exists: false } },
    {
      $set: {
        consentAt: new Date(),
        consentVersion: HIRE_CONSENT_VERSION,
        consentUserAgent: meta.userAgent?.slice(0, 512),
        status: 'consented',
      },
    },
    { new: true }
  )
  return updated ?? verified.round
}

/**
 * Bind the guest User minted by the guest-auth seam (app-layer verify-otp
 * route) to the round. Requires recorded consent — the gate cannot be skipped
 * by calling the OTP endpoints directly.
 */
export async function bindGuestUser(
  roundId: string,
  rawToken: string,
  guestUserId: string
): Promise<IHireRound> {
  const verified = await verifyRoundToken(roundId, rawToken)
  if (!verified || verified.state !== 'ok') {
    throw new AppError('This interview link is no longer valid', 410, 'ROUND_LINK_INVALID')
  }
  if (!verified.round.consentAt) {
    throw new AppError('Consent is required before verification', 409, 'CONSENT_REQUIRED')
  }
  const updated = await HireRound.findOneAndUpdate(
    { _id: verified.round._id },
    { $set: { guestUserId, authVerifiedAt: new Date(), status: 'auth_verified' } },
    { new: true }
  )
  if (!updated) throw new NotFoundError('Round')
  return updated
}

export interface GuestInterviewConfig {
  role: string
  interviewType: string
  experience: string
  duration: number
  jobDescription: string
  targetCompany: string
}

/**
 * Session-provisioning seam, hire side: hand the authenticated guest the
 * exact InterviewConfig the engine's own setup flow would have written, and
 * open the reconciliation window (preparedAt, first call wins). The guest
 * then enters the engine's public lobby → room flow untouched.
 */
export async function prepareRound(
  roundId: string,
  guestUserId: string
): Promise<{ round: IHireRound; config: GuestInterviewConfig }> {
  await connectDB()
  const round = await HireRound.findOne({ _id: roundId, guestUserId })
  if (!round) throw new NotFoundError('Round')
  if (round.revokedAt || round.status === 'revoked') {
    throw new AppError('This interview link was revoked', 410, 'ROUND_LINK_INVALID')
  }
  if (round.status === 'completed') {
    throw new AppError('This interview is already completed', 409, 'ROUND_COMPLETED')
  }
  if (!round.consentAt) {
    throw new AppError('Consent is required before starting', 409, 'CONSENT_REQUIRED')
  }

  const job = await HireJob.findOne({ _id: round.jobId, workspaceId: round.workspaceId })
  if (!job) throw new NotFoundError('Round')
  const workspace = await HireWorkspace.findById(round.workspaceId)

  const updated = await HireRound.findOneAndUpdate(
    { _id: round._id, preparedAt: { $exists: false } },
    { $set: { preparedAt: new Date(), status: 'prepared' } },
    { new: true }
  )

  return {
    round: updated ?? round,
    config: {
      role: round.config.role,
      interviewType: round.config.interviewType,
      experience: round.config.experience,
      duration: round.config.duration,
      jobDescription: job.jdText,
      targetCompany: workspace?.name ?? '',
    },
  }
}

// ─── Member-side: revoke ─────────────────────────────────────────────────────

export async function revokeRound(
  ctx: MembershipContext,
  roundId: string
): Promise<IHireRound> {
  await connectDB()
  const round = await HireRound.findOneAndUpdate(
    {
      _id: roundId,
      workspaceId: ctx.workspace._id,
      status: { $nin: ['completed', 'revoked'] },
    },
    { $set: { status: 'revoked', revokedAt: new Date(), revokedBy: ctx.membership.userId } },
    { new: true }
  )
  if (!round) throw new NotFoundError('Round')

  await appendApplicationEvent(ctx.workspace._id, round.applicationId, {
    type: 'ai_round_revoked',
    actorUserId: ctx.membership.userId,
    actorName: ctx.membership.name || ctx.membership.email,
    note: 'AI interview link revoked',
  })
  return round
}
