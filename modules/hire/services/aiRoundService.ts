import crypto from 'crypto'
import mongoose from 'mongoose'
import {
  INTERVIEW_ROLE_SLUG_MAX_CHARS,
  INTERVIEW_JOB_DESCRIPTION_MAX_CHARS,
} from '@shared/interviewContract'
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

/** How long past token expiry a mid-flow (post-auth) round stays usable
 * before the link finally dies. Keeps "resume my interview" working without
 * making invite links immortal. */
export const POST_AUTH_GRACE_DAYS = 14

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
export function guestEmailForRound(roundId: string): string {
  return `round-${roundId.toLowerCase()}@guests.interviewprep.internal`
}

/**
 * The JD text provisioned to the guest: the job's JD plus a per-round
 * reference line. The reference makes sha256(jdSnapshot) unique PER ROUND,
 * so reconciliation can only ever match an engine session to the one round
 * that provisioned it — two workspaces (or two rounds) with byte-identical
 * JDs can never claim each other's interviews. Clamped so the total stays
 * within the engine's jobDescription contract.
 */
export function buildJdSnapshot(jdText: string, roundId: string): string {
  const ref = `\n\n[Interview reference: HR-${roundId}]`
  return jdText.slice(0, INTERVIEW_JOB_DESCRIPTION_MAX_CHARS - ref.length) + ref
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
        {
          $set: { status: 'revoked', revokedAt: now, revokedBy: ctx.membership.userId },
          $unset: { live: 1 },
        }
      )
      await appendApplicationEvent(ctx.workspace._id, application._id, {
        type: 'ai_round_revoked',
        actorUserId: ctx.membership.userId,
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
  const jdSnapshot = buildJdSnapshot(job.jdText, roundId.toString())
  let round: IHireRound
  try {
    round = await HireRound.create({
      _id: roundId,
      workspaceId: ctx.workspace._id,
      applicationId: application._id,
      jobId: job._id,
      candidateId: candidate._id,
      candidateEmail: candidate.email,
      candidateName: candidate.name,
      kind: 'ai',
      status: 'invited',
      live: true,
      inviteTokenHash: sha256(token),
      inviteTokenExpiry: new Date(Date.now() + INVITE_TOKEN_EXPIRY_DAYS * 24 * 60 * 60 * 1000),
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
      createdBy: ctx.membership.userId,
    })
  } catch (err: unknown) {
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
  // Post-auth (mid-flow) rounds survive token expiry so "resume my
  // interview" works, but not forever — after the grace ceiling the link
  // dies like any other.
  if (
    !preAuth &&
    round.inviteTokenExpiry.getTime() + POST_AUTH_GRACE_DAYS * 24 * 60 * 60 * 1000 <=
      Date.now()
  ) {
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
  // Same grace ceiling verifyRoundToken enforces — a guest whose NextAuth
  // session outlives the round cannot keep re-preparing via this authed
  // endpoint after the link itself has died (Codex P2 on #603).
  if (
    round.inviteTokenExpiry.getTime() + POST_AUTH_GRACE_DAYS * 24 * 60 * 60 * 1000 <=
    Date.now()
  ) {
    throw new AppError('This interview link is no longer valid', 410, 'ROUND_LINK_INVALID')
  }

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
      // The immutable snapshot (with the per-round reference line), NOT the
      // live job.jdText — a JD edit after send can neither change what the
      // candidate is assessed against nor break reconciliation's hash match.
      jobDescription: round.jdSnapshot,
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
    {
      $set: { status: 'revoked', revokedAt: new Date(), revokedBy: ctx.membership.userId },
      $unset: { live: 1 },
    },
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
