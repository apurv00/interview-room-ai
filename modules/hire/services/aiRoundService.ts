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

export const AI_ROUND_INTERVIEW_TYPE = 'behavioral'
export const INVITE_TOKEN_EXPIRY_DAYS = 7
export function sha256(value: string): string {
  return crypto.createHash('sha256').update(value).digest('hex')
}

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
      await withActiveHireWorkspaceWriteTransaction(
        ctx.workspace._id,
        ctx.membership._id,
        async (session) => {
          const revoked = await HireRound.updateOne(
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
            },
            { session },
          )
          if (revoked.matchedCount !== 1) throw new NotFoundError('Round')
          const version = await HireJob.updateOne(
            { _id: job._id, workspaceId: ctx.workspace._id },
            { $inc: { candidateReadVersion: 1 } },
            { session },
          )
          if (version.matchedCount !== 1) throw new NotFoundError('Job')
        },
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
          { $inc: { intakeWriteVersion: 1, candidateReadVersion: 1 } },
          { session },
        )
        if (jobClaim.matchedCount !== 1) {
          throw new AppError('AI interviews can only be sent for open jobs', 409, 'JOB_NOT_OPEN')
        }
        await claimNonTerminalHireApplicationDispatchFence({
          workspaceId: ctx.workspace._id,
          applicationId: application._id,
          jobId: job._id,
          candidateId: candidate._id,
          now,
          session,
        })
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
          authMode,
          live: true,
          inviteTokenHash: sha256(token),
          inviteTokenExpiry,
          invitedAt: now,
          config: {
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
  if (round.inviteTokenExpiry <= new Date()) {
    return { round, state: 'expired' }
  }
  return { round, state: 'ok' }
}

export async function revokeRound(
  ctx: MembershipContext,
  roundId: string
): Promise<IHireRound> {
  await connectHireControlDB()
  const round = await withActiveHireWorkspaceWriteTransaction(
    ctx.workspace._id,
    ctx.membership._id,
    async (session) => {
      const claimed = await HireRound.findOneAndUpdate(
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
        { new: true, session },
      )
      if (!claimed) throw new NotFoundError('Round')
      const job = await HireJob.updateOne(
        { _id: claimed.jobId, workspaceId: ctx.workspace._id },
        { $inc: { intakeWriteVersion: 1, candidateReadVersion: 1 } },
        { session },
      )
      if (job.matchedCount !== 1) throw new NotFoundError('Job')
      return claimed
    },
  )

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
