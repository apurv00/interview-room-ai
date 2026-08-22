import crypto from 'crypto'
import mongoose, { type ClientSession } from 'mongoose'
import { AppError, NotFoundError } from '@shared/errors'
import {
  HireApplication,
  HireCandidate,
  HireHumanKitDelivery,
  HireHumanRound,
  HireHumanScorecard,
  HireInterviewKit,
  HireJob,
  HirePrivacyRequest,
  HireWorkspace,
  HIRE_HUMAN_SCORECARD_DIMENSIONS,
  type HireHumanScorecardRecommendation,
  type IHireHumanRound,
  type IHireHumanScorecardDimension,
  type IHireInterviewKit,
} from '../models'
import { appendApplicationEvent } from './pipelineService'
import type { MembershipContext } from './workspaceService'
import { activeHireWorkspaceLifecycleFilter } from './workspaceService'
import { connectHireControlDB } from './hireControlBoundary'
import { withActiveHireWorkspaceWriteTransaction } from './hireWorkspaceWriteFence'
import {
  claimHireCandidatePiiWriteFence,
  HireCandidatePiiTombstoneError,
} from './hireCandidatePrivacyWriteFence'
import { claimNonTerminalHireApplicationDispatchFence } from './hireApplicationDispatchFence'
import { decodeWorkspaceResourceCapability } from './workspaceCapability'
import { resolveWorkspaceWriteAuthority } from './applyPageService'
import {
  createHumanInterviewKitDelivery,
  kickHumanInterviewKitDelivery,
} from './humanKitDeliveryService'
import { assertHireOnboardingTestDriveWriteIsolation } from '@hire-onboarding-boundary'

export const HUMAN_INTERVIEW_KIT_EXPIRY_DAYS = 7

const OBJECT_ID = /^[a-f0-9]{24}$/i

function sha256(value: string): string {
  return crypto.createHash('sha256').update(value).digest('hex')
}

function memberName(ctx: MembershipContext): string {
  return ctx.membership.name || ctx.membership.email
}

function requireObjectId(value: string, label: string): mongoose.Types.ObjectId {
  if (!OBJECT_ID.test(value)) throw new AppError(`Invalid ${label}`, 400, 'INVALID_ID')
  return new mongoose.Types.ObjectId(value)
}

function friendlyTombstone(error: unknown): never {
  if (error instanceof HireCandidatePiiTombstoneError) {
    throw new AppError('Candidate personal data is unavailable', 410, 'HIRE_CANDIDATE_PII_TOMBSTONED')
  }
  throw error
}

export interface CreateGuestHumanRoundInput {
  applicationId: string
  interviewerName: string
  interviewerEmail: string
  operationId: string
}

export interface CreateGuestHumanRoundResult {
  humanRound: IHireHumanRound
  kit: IHireInterviewKit
  /** Delivery is durable and initially pending; recovery owns provider I/O. */
  deliveryQueued: boolean
}

export interface CreateMemberHumanRoundInput {
  applicationId: string
  operationId: string
}

export interface SubmitMemberHumanRoundScorecardInput {
  humanRoundId: string
  dimensions: IHireHumanScorecardDimension[]
  recommendation: HireHumanScorecardRecommendation
  overallComment: string
}

const PUBLIC_KIT_INACTIVE_CODES = new Set([
  'HUMAN_KIT_NOT_ACTIVE',
  'HUMAN_ROUND_NOT_ACTIVE',
  'WORKSPACE_DELETION_PENDING',
  'APPLICATION_NOT_ELIGIBLE',
  'CANDIDATE_PRIVACY_PENDING',
  'HIRE_CANDIDATE_PII_TOMBSTONED',
])

function inactiveKitError(): AppError {
  return new AppError('The interview kit is no longer active', 410, 'HUMAN_KIT_NOT_ACTIVE')
}

function isPublicKitInactiveError(error: unknown): boolean {
  return error instanceof AppError && PUBLIC_KIT_INACTIVE_CODES.has(error.code)
}

function hasCanonicalScorecard(
  dimensions: IHireHumanScorecardDimension[],
  recommendation: HireHumanScorecardRecommendation,
  overallComment: string,
): boolean {
  return dimensions.length === HIRE_HUMAN_SCORECARD_DIMENSIONS.length &&
    dimensions.every((dimension, index) => (
      dimension.key === HIRE_HUMAN_SCORECARD_DIMENSIONS[index] &&
      Number.isInteger(dimension.rating) &&
      dimension.rating >= 1 &&
      dimension.rating <= 5 &&
      typeof dimension.evidence === 'string' &&
      dimension.evidence.trim().length > 0 &&
      dimension.evidence.trim().length <= 2_000
    )) &&
    ['strong_yes', 'yes', 'no', 'strong_no'].includes(recommendation) &&
    overallComment.trim().length > 0 &&
    overallComment.trim().length <= 4_000
}

/**
 * Create one guest-owned human interview round and its hash-only kit inside a
 * single Hire transaction. The unencrypted capability is held only long
 * enough to derive the link and encrypted delivery recovery row.
 */
export async function createGuestHumanRound(
  ctx: MembershipContext,
  input: CreateGuestHumanRoundInput,
): Promise<CreateGuestHumanRoundResult> {
  await connectHireControlDB()
  const applicationId = requireObjectId(input.applicationId, 'application id')
  const application = await HireApplication.findOne({
    _id: applicationId,
    workspaceId: ctx.workspace._id,
  })
  if (!application) throw new NotFoundError('Application')
  const [job, candidate] = await Promise.all([
    HireJob.findOne({ _id: application.jobId, workspaceId: ctx.workspace._id }),
    HireCandidate.findOne({ _id: application.candidateId, workspaceId: ctx.workspace._id }),
  ])
  if (!job || !candidate) throw new NotFoundError('Application')
  if (job.status !== 'open') {
    throw new AppError('Human rounds can only be created for open jobs', 409, 'JOB_NOT_OPEN')
  }

  const now = new Date()
  const humanRoundId = new mongoose.Types.ObjectId()
  const kitId = new mongoose.Types.ObjectId()
  const rawSecret = crypto.randomBytes(32).toString('hex')
  const expiresAt = new Date(now.getTime() + HUMAN_INTERVIEW_KIT_EXPIRY_DAYS * 86_400_000)
  let created: {
    humanRound: IHireHumanRound
    kit: IHireInterviewKit
    deliveryId: mongoose.Types.ObjectId
  }
  try {
    created = await withActiveHireWorkspaceWriteTransaction(
      ctx.workspace._id,
      ctx.membership._id,
      async (session) => {
        // A guest kit is an external email/possession capability. Practice
        // coordinates must not create one, including for a legacy marker that
        // was removed but is still retained for aggregate exclusion/cleanup.
        await assertHireOnboardingTestDriveWriteIsolation({
          workspaceId: ctx.workspace._id,
          applicationId: application._id,
          jobId: job._id,
          candidateId: candidate._id,
          session,
        })
        const jobClaim = await HireJob.updateOne(
          { _id: job._id, workspaceId: ctx.workspace._id, status: 'open' },
          { $inc: { intakeWriteVersion: 1 } },
          { session },
        )
        if (jobClaim.matchedCount !== 1) {
          throw new AppError('Human rounds can only be created for open jobs', 409, 'JOB_NOT_OPEN')
        }
        await claimNonTerminalHireApplicationDispatchFence({
          workspaceId: ctx.workspace._id,
          applicationId: application._id,
          jobId: job._id,
          candidateId: candidate._id,
          now,
          session,
        })
        const privacy = await HirePrivacyRequest.exists({
          workspaceId: ctx.workspace._id,
          candidateId: candidate._id,
          live: true,
        }).session(session)
        if (privacy) {
          throw new AppError('A candidate privacy request is in progress', 409, 'CANDIDATE_PRIVACY_PENDING')
        }
        await claimHireCandidatePiiWriteFence({
          workspaceId: ctx.workspace._id,
          candidateId: candidate._id,
          session,
        })
        const existing = await HireHumanRound.findOne({
          workspaceId: ctx.workspace._id,
          creationOperationId: input.operationId,
        }, null, { session })
        if (existing) {
          if (existing.applicationId.toString() !== application._id.toString() || existing.mode !== 'guest_kit') {
            throw new AppError('That operation id was used for another human round', 409, 'OPERATION_ID_REUSED')
          }
          const existingKit = await HireInterviewKit.findOne({
            workspaceId: ctx.workspace._id,
            humanRoundId: existing._id,
            active: true,
          }, null, { session }).select('+secretHash')
          if (!existingKit) {
            throw new AppError('This human round no longer has an active kit', 409, 'HUMAN_KIT_NOT_ACTIVE')
          }
          // An idempotent POST cannot recreate the raw secret. The durable
          // delivery recovery view is the member-only copy/retry mechanism.
          const existingDelivery = await HireHumanKitDelivery.findOne({
            workspaceId: ctx.workspace._id,
            kitId: existingKit._id,
            purpose: 'initial',
          }, null, { session })
          if (!existingDelivery) {
            throw new AppError('This human round no longer has its initial delivery record', 409, 'HUMAN_KIT_NOT_ACTIVE')
          }
          return { humanRound: existing, kit: existingKit, deliveryId: existingDelivery._id }
        }
        const [humanRound] = await HireHumanRound.create([{
          _id: humanRoundId,
          workspaceId: ctx.workspace._id,
          applicationId: application._id,
          jobId: job._id,
          candidateId: candidate._id,
          mode: 'guest_kit',
          status: 'pending_scorecard',
          creationOperationId: input.operationId,
          briefSnapshot: {
            candidateName: candidate.name,
            jobTitle: job.title,
            ...(job.screeningSettings?.location ? { location: job.screeningSettings.location } : {}),
            ...(candidate.screeningProfile?.experienceYears !== undefined
              ? { experienceYears: candidate.screeningProfile.experienceYears }
              : {}),
            ...(candidate.resumeText ? { sourceResumeHash: sha256(candidate.resumeText) } : {}),
          },
          createdByMemberId: ctx.membership._id,
          createdByName: memberName(ctx),
        }], { session })
        const [kit] = await HireInterviewKit.create([{
          _id: kitId,
          workspaceId: ctx.workspace._id,
          applicationId: application._id,
          jobId: job._id,
          candidateId: candidate._id,
          humanRoundId,
          secretHash: sha256(rawSecret),
          expiresAt,
          status: 'active',
          active: true,
        }], { session })
        const delivery = await createHumanInterviewKitDelivery({
          workspaceId: ctx.workspace._id.toString(),
          applicationId: application._id.toString(),
          jobId: job._id.toString(),
          candidateId: candidate._id.toString(),
          humanRoundId: humanRoundId.toString(),
          kitId: kitId.toString(),
          purpose: 'initial',
          recipientName: input.interviewerName,
          recipientEmail: input.interviewerEmail,
          workspaceName: ctx.workspace.name,
          jobTitle: job.title,
          dueAt: now,
          expiresAt,
          rawSecret,
          session,
        })
        return { humanRound, kit, deliveryId: delivery._id }
      },
    )
  } catch (error) {
    friendlyTombstone(error)
  }

  await kickHumanInterviewKitDelivery({
    workspaceId: ctx.workspace._id.toString(),
    deliveryId: created.deliveryId.toString(),
  })
  await appendApplicationEvent(ctx.workspace._id, application._id, {
    type: 'human_round_logged',
    ...(ctx.membership.userId ? { actorUserId: ctx.membership.userId } : {}),
    actorMemberId: ctx.membership._id,
    actorName: memberName(ctx),
    note: 'Guest human interview kit queued for durable delivery',
    operationId: input.operationId,
  })
  return { humanRound: created.humanRound, kit: created.kit, deliveryQueued: true }
}

/** A member who conducts the call opens a draft scorecard inside Hire. */
export async function createMemberHumanRound(
  ctx: MembershipContext,
  input: CreateMemberHumanRoundInput,
): Promise<IHireHumanRound> {
  await connectHireControlDB()
  const applicationId = requireObjectId(input.applicationId, 'application id')
  const application = await HireApplication.findOne({ _id: applicationId, workspaceId: ctx.workspace._id })
  if (!application) throw new NotFoundError('Application')
  const [job, candidate] = await Promise.all([
    HireJob.findOne({ _id: application.jobId, workspaceId: ctx.workspace._id }),
    HireCandidate.findOne({ _id: application.candidateId, workspaceId: ctx.workspace._id }),
  ])
  if (!job || !candidate) throw new NotFoundError('Application')
  const now = new Date()
  const roundId = new mongoose.Types.ObjectId()
  try {
    const round = await withActiveHireWorkspaceWriteTransaction(
      ctx.workspace._id,
      ctx.membership._id,
      async (session) => {
        const jobClaim = await HireJob.updateOne(
          { _id: job._id, workspaceId: ctx.workspace._id, status: 'open' },
          { $inc: { intakeWriteVersion: 1 } },
          { session },
        )
        if (jobClaim.matchedCount !== 1) throw new AppError('Human rounds require an open job', 409, 'JOB_NOT_OPEN')
        await claimNonTerminalHireApplicationDispatchFence({
          workspaceId: ctx.workspace._id,
          applicationId: application._id,
          jobId: job._id,
          candidateId: candidate._id,
          now,
          session,
        })
        const privacy = await HirePrivacyRequest.exists({
          workspaceId: ctx.workspace._id,
          candidateId: candidate._id,
          live: true,
        }).session(session)
        if (privacy) throw new AppError('A candidate privacy request is in progress', 409, 'CANDIDATE_PRIVACY_PENDING')
        await claimHireCandidatePiiWriteFence({ workspaceId: ctx.workspace._id, candidateId: candidate._id, session })
        const existing = await HireHumanRound.findOne({
          workspaceId: ctx.workspace._id,
          creationOperationId: input.operationId,
        }, null, { session })
        if (existing) {
          if (existing.applicationId.toString() !== application._id.toString() || existing.mode !== 'member_room') {
            throw new AppError('That operation id was used for another human round', 409, 'OPERATION_ID_REUSED')
          }
          return existing
        }
        const [created] = await HireHumanRound.create([{
          _id: roundId,
          workspaceId: ctx.workspace._id,
          applicationId: application._id,
          jobId: job._id,
          candidateId: candidate._id,
          mode: 'member_room',
          status: 'pending_scorecard',
          creationOperationId: input.operationId,
          briefSnapshot: {
            candidateName: candidate.name,
            jobTitle: job.title,
            ...(job.screeningSettings?.location ? { location: job.screeningSettings.location } : {}),
            ...(candidate.screeningProfile?.experienceYears !== undefined
              ? { experienceYears: candidate.screeningProfile.experienceYears }
              : {}),
            ...(candidate.resumeText ? { sourceResumeHash: sha256(candidate.resumeText) } : {}),
          },
          openedAt: now,
          createdByMemberId: ctx.membership._id,
          createdByName: memberName(ctx),
        }], { session })
        await HireHumanScorecard.create([{
          workspaceId: ctx.workspace._id,
          applicationId: application._id,
          jobId: job._id,
          candidateId: candidate._id,
          humanRoundId: created._id,
          reviewerKey: `member:${ctx.membership._id.toString()}`,
          reviewerKind: 'member',
          memberId: ctx.membership._id,
          reviewerName: memberName(ctx),
          status: 'draft',
        }], { session })
        return created
      },
    )
    await appendApplicationEvent(ctx.workspace._id, application._id, {
      type: 'human_round_logged',
      ...(ctx.membership.userId ? { actorUserId: ctx.membership.userId } : {}),
      actorMemberId: ctx.membership._id,
      actorName: memberName(ctx),
      note: 'Member-led human interview round opened',
      operationId: input.operationId,
    })
    return round
  } catch (error) {
    friendlyTombstone(error)
  }
}

/**
 * Submit the draft owned by the authenticated member who opened a member-room
 * round. The scorecard and round complete together; no guest capability or
 * engine session participates in this path.
 */
export async function submitMemberHumanRoundScorecard(
  ctx: MembershipContext,
  input: SubmitMemberHumanRoundScorecardInput,
): Promise<IHireHumanRound> {
  await connectHireControlDB()
  if (!hasCanonicalScorecard(input.dimensions, input.recommendation, input.overallComment)) {
    throw new AppError('The scorecard is incomplete or invalid', 400, 'INVALID_HUMAN_SCORECARD')
  }
  const humanRoundId = requireObjectId(input.humanRoundId, 'human round id')
  const now = new Date()
  let completed: IHireHumanRound
  try {
    completed = await withActiveHireWorkspaceWriteTransaction(
      ctx.workspace._id,
      ctx.membership._id,
      async (session) => {
        const round = await HireHumanRound.findOne({
          _id: humanRoundId,
          workspaceId: ctx.workspace._id,
          mode: 'member_room',
          status: 'pending_scorecard',
          revokedAt: { $exists: false },
        }, null, { session })
        if (!round) throw new NotFoundError('Pending member human round')

        // Write the job row so a close decision and a scorecard submission
        // serialize; a closed job cannot gain new human evidence.
        const jobClaim = await HireJob.updateOne(
          { _id: round.jobId, workspaceId: ctx.workspace._id, status: 'open' },
          { $inc: { intakeWriteVersion: 1 } },
          { session },
        )
        if (jobClaim.matchedCount !== 1) {
          throw new AppError('The job is no longer open', 409, 'JOB_NOT_OPEN')
        }
        await claimHireCandidatePiiWriteFence({
          workspaceId: ctx.workspace._id,
          candidateId: round.candidateId,
          session,
        })
        const privacy = await HirePrivacyRequest.exists({
          workspaceId: ctx.workspace._id,
          candidateId: round.candidateId,
          live: true,
        }).session(session)
        if (privacy) {
          throw new AppError('A candidate privacy request is in progress', 409, 'CANDIDATE_PRIVACY_PENDING')
        }
        await claimNonTerminalHireApplicationDispatchFence({
          workspaceId: ctx.workspace._id,
          applicationId: round.applicationId,
          jobId: round.jobId,
          candidateId: round.candidateId,
          now,
          session,
        })
        const scorecard = await HireHumanScorecard.updateOne(
          {
            workspaceId: ctx.workspace._id,
            applicationId: round.applicationId,
            jobId: round.jobId,
            candidateId: round.candidateId,
            humanRoundId: round._id,
            reviewerKey: `member:${ctx.membership._id.toString()}`,
            reviewerKind: 'member',
            memberId: ctx.membership._id,
            status: 'draft',
          },
          {
            $set: {
              status: 'submitted',
              dimensions: input.dimensions.map((dimension) => ({
                ...dimension,
                evidence: dimension.evidence.trim(),
              })),
              recommendation: input.recommendation,
              overallComment: input.overallComment.trim(),
              submittedAt: now,
            },
          },
          { session, runValidators: true },
        )
        if (scorecard.matchedCount !== 1) {
          throw new AppError('This member scorecard is no longer available', 409, 'HUMAN_SCORECARD_NOT_DRAFT')
        }
        const updated = await HireHumanRound.findOneAndUpdate(
          {
            _id: round._id,
            workspaceId: ctx.workspace._id,
            mode: 'member_room',
            status: 'pending_scorecard',
            revokedAt: { $exists: false },
          },
          { $set: { status: 'completed', scorecardSubmittedAt: now } },
          { new: true, session },
        )
        if (!updated) {
          throw new AppError('The human round changed while submitting the scorecard', 409, 'HUMAN_ROUND_RACE')
        }
        await HireApplication.updateOne(
          {
            _id: round.applicationId,
            workspaceId: ctx.workspace._id,
            jobId: round.jobId,
            candidateId: round.candidateId,
          },
          {
            $push: {
              events: {
                type: 'human_scorecard_submitted',
                ...(ctx.membership.userId ? { actorUserId: ctx.membership.userId } : {}),
                actorMemberId: ctx.membership._id,
                actorName: memberName(ctx),
                note: 'Member submitted a human interview scorecard',
                at: now,
              },
            },
          },
          { session },
        )
        return updated
      },
    )
  } catch (error) {
    friendlyTombstone(error)
  }

  return completed
}

function isActiveKit(kit: IHireInterviewKit, now: Date): boolean {
  return kit.active === true && kit.status === 'active' && !kit.revokedAt && kit.expiresAt > now
}

export interface HumanKitBootstrapView {
  workspaceName: string
  jobTitle: string
  interviewerName?: string
  brief: {
    candidateName: string
    location?: string
    experienceYears?: number
  }
}

async function loadActiveKit(input: {
  kitId: string
  capability: string
  now: Date
  session?: ClientSession
}): Promise<{ kit: IHireInterviewKit; round: IHireHumanRound } | null> {
  if (!OBJECT_ID.test(input.kitId)) return null
  const capability = decodeWorkspaceResourceCapability(input.capability)
  if (!capability || capability.resourceId !== input.kitId.toLowerCase()) return null
  const kit = await HireInterviewKit.findOne({
    _id: input.kitId,
    workspaceId: capability.workspaceId,
    secretHash: sha256(capability.secret),
    active: true,
    status: 'active',
    expiresAt: { $gt: input.now },
    revokedAt: { $exists: false },
  }, null, input.session ? { session: input.session } : undefined).select('+secretHash')
  if (!kit) return null
  // Mongoose explicitly forbids parallel operations on the same transaction
  // session. These reads are deliberately sequential when `session` exists;
  // that also keeps the full kit authority snapshot stable under lifecycle
  // writers.
  const workspace = await HireWorkspace.exists({
    _id: kit.workspaceId,
    ...activeHireWorkspaceLifecycleFilter(),
  }).session(input.session ?? null)
  const job = await HireJob.exists({
    _id: kit.jobId,
    workspaceId: kit.workspaceId,
    status: 'open',
  }).session(input.session ?? null)
  const application = await HireApplication.exists({
    _id: kit.applicationId,
    workspaceId: kit.workspaceId,
    jobId: kit.jobId,
    candidateId: kit.candidateId,
    stage: { $nin: ['hired', 'rejected', 'withdrawn'] },
  }).session(input.session ?? null)
  const round = await HireHumanRound.findOne({
    _id: kit.humanRoundId,
    workspaceId: kit.workspaceId,
    applicationId: kit.applicationId,
    jobId: kit.jobId,
    candidateId: kit.candidateId,
    status: 'pending_scorecard',
    revokedAt: { $exists: false },
  }, null, input.session ? { session: input.session } : undefined)
  if (!workspace || !job || !application || !round) return null
  const privacy = await HirePrivacyRequest.exists({
    workspaceId: kit.workspaceId,
    candidateId: kit.candidateId,
    live: true,
  }).session(input.session ?? null)
  if (privacy) return null
  return { kit, round }
}

export async function bootstrapHumanInterviewKit(input: {
  kitId: string
  capability: string
}): Promise<HumanKitBootstrapView | null> {
  await connectHireControlDB()
  const now = new Date()
  const capability = decodeWorkspaceResourceCapability(input.capability)
  if (!capability || capability.resourceId !== input.kitId.toLowerCase() || !OBJECT_ID.test(input.kitId)) {
    return null
  }
  const workspaceId = new mongoose.Types.ObjectId(capability.workspaceId)
  const authorityMemberId = await resolveWorkspaceWriteAuthority(workspaceId)
  if (!authorityMemberId) return null

  try {
    return await withActiveHireWorkspaceWriteTransaction(
      workspaceId,
      authorityMemberId,
      async (session) => {
        // Bootstrap is a write (first-open audit), so it must obtain the same
        // workspace/candidate/application authority as submission. That makes
        // a close, terminal stage move, or privacy deletion win before a
        // least-disclosure brief can be returned.
        const active = await loadActiveKit({ ...input, now, session })
        if (!active) throw inactiveKitError()
        await claimHireCandidatePiiWriteFence({
          workspaceId: active.kit.workspaceId,
          candidateId: active.kit.candidateId,
          session,
        })
        await claimNonTerminalHireApplicationDispatchFence({
          workspaceId: active.kit.workspaceId,
          applicationId: active.kit.applicationId,
          jobId: active.kit.jobId,
          candidateId: active.kit.candidateId,
          now,
          session,
        })
        // Always claim the active kit row, even after its first open. This
        // creates a write conflict with revoke/close and means a terminal
        // application decision cannot commit between an earlier passive read
        // and returning this public brief.
        const opened = await HireInterviewKit.updateOne(
          {
            _id: active.kit._id,
            workspaceId: active.kit.workspaceId,
            active: true,
            status: 'active',
            expiresAt: { $gt: now },
          },
          { $set: { openedAt: active.kit.openedAt ?? now } },
          { session },
        )
        if (opened.matchedCount !== 1) throw inactiveKitError()
        const workspace = await HireWorkspace.findOne({
          _id: active.kit.workspaceId,
          ...activeHireWorkspaceLifecycleFilter(),
        }, null, { session }).select('name').lean()
        const job = await HireJob.findOne({
          _id: active.kit.jobId,
          workspaceId: active.kit.workspaceId,
          status: 'open',
        }, null, { session }).select('title').lean()
        const initialDelivery = await HireHumanKitDelivery.findOne({
          workspaceId: active.kit.workspaceId,
          kitId: active.kit._id,
          purpose: 'initial',
        }, null, { session }).select('recipientName').lean()
        if (!workspace || !job) throw inactiveKitError()
        return {
          workspaceName: workspace.name,
          jobTitle: job.title,
          ...(initialDelivery?.recipientName ? { interviewerName: initialDelivery.recipientName } : {}),
          brief: {
            candidateName: active.round.briefSnapshot.candidateName,
            ...(active.round.briefSnapshot.location ? { location: active.round.briefSnapshot.location } : {}),
            ...(active.round.briefSnapshot.experienceYears !== undefined
              ? { experienceYears: active.round.briefSnapshot.experienceYears }
              : {}),
          },
        }
      },
    )
  } catch (error) {
    if (error instanceof HireCandidatePiiTombstoneError || isPublicKitInactiveError(error)) return null
    throw error
  }
}

export interface SubmitHumanInterviewKitScorecardInput {
  kitId: string
  capability: string
  dimensions: IHireHumanScorecardDimension[]
  recommendation: HireHumanScorecardRecommendation
  overallComment: string
}

/**
 * Atomically consumes a public possession link. All lifecycle and PII fences
 * are repeated under one transaction; a stale bootstrap is never authority to
 * submit after a decision, workspace tombstone, or privacy deletion.
 */
export async function submitHumanInterviewKitScorecard(
  input: SubmitHumanInterviewKitScorecardInput,
): Promise<{ state: 'submitted' } | null> {
  await connectHireControlDB()
  if (!hasCanonicalScorecard(input.dimensions, input.recommendation, input.overallComment)) return null
  const now = new Date()
  const capability = decodeWorkspaceResourceCapability(input.capability)
  if (!capability || capability.resourceId !== input.kitId.toLowerCase() || !OBJECT_ID.test(input.kitId)) return null
  // Public workflows still need a live Hire member to hold the workspace
  // transaction authority, exactly as queued public apply does.
  const authorityMemberId = await resolveWorkspaceWriteAuthority(new mongoose.Types.ObjectId(capability.workspaceId))
  if (!authorityMemberId) return null

  try {
    await withActiveHireWorkspaceWriteTransaction(
      new mongoose.Types.ObjectId(capability.workspaceId),
      authorityMemberId,
      async (session) => {
        const active = await loadActiveKit({
          kitId: input.kitId,
          capability: input.capability,
          now,
          session,
        })
        if (!active) throw inactiveKitError()
        await claimHireCandidatePiiWriteFence({
          workspaceId: active.kit.workspaceId,
          candidateId: active.kit.candidateId,
          session,
        })
        await claimNonTerminalHireApplicationDispatchFence({
          workspaceId: active.kit.workspaceId,
          applicationId: active.kit.applicationId,
          jobId: active.kit.jobId,
          candidateId: active.kit.candidateId,
          now,
          session,
        })

        // Consume the capability BEFORE writing scorecard evidence. A missed
        // conditional consume must throw, not return, so the transaction
        // aborts rather than committing an orphan scorecard after a concurrent
        // revoke/submit/close decision won.
        const consumed = await HireInterviewKit.updateOne(
          {
            _id: active.kit._id,
            workspaceId: active.kit.workspaceId,
            secretHash: sha256(capability.secret),
            active: true,
            status: 'active',
            expiresAt: { $gt: now },
            revokedAt: { $exists: false },
          },
          {
            $set: {
              status: 'submitted',
              submittedAt: now,
              active: false,
            },
          },
          { session },
        )
        if (consumed.matchedCount !== 1) throw inactiveKitError()

        const initialDelivery = await HireHumanKitDelivery.findOne({
          workspaceId: active.kit.workspaceId,
          kitId: active.kit._id,
          purpose: 'initial',
        }, null, { session }).select('recipientName')
        if (!initialDelivery) throw inactiveKitError()

        await HireHumanScorecard.create([{
          workspaceId: active.kit.workspaceId,
          applicationId: active.kit.applicationId,
          jobId: active.kit.jobId,
          candidateId: active.kit.candidateId,
          humanRoundId: active.round._id,
          reviewerKey: `kit:${active.kit._id.toString()}`,
          reviewerKind: 'kit',
          kitId: active.kit._id,
          reviewerName: initialDelivery.recipientName,
          status: 'submitted',
          dimensions: input.dimensions.map((dimension) => ({
            ...dimension,
            evidence: dimension.evidence.trim(),
          })),
          recommendation: input.recommendation,
          overallComment: input.overallComment.trim(),
          submittedAt: now,
        }], { session })

        const completedRound = await HireHumanRound.updateOne(
          {
            _id: active.round._id,
            workspaceId: active.kit.workspaceId,
            applicationId: active.kit.applicationId,
            jobId: active.kit.jobId,
            candidateId: active.kit.candidateId,
            status: 'pending_scorecard',
            revokedAt: { $exists: false },
          },
          {
            $set: { status: 'completed', scorecardSubmittedAt: now },
          },
          { session },
        )
        if (completedRound.matchedCount !== 1) throw inactiveKitError()
        await HireHumanKitDelivery.updateMany(
          {
            workspaceId: active.kit.workspaceId,
            kitId: active.kit._id,
            purpose: 'reminder',
            status: { $in: ['pending', 'sending', 'failed'] },
          },
          {
            $set: { status: 'cancelled', cancelledAt: now },
            $unset: { claimToken: 1, leaseExpiresAt: 1 },
          },
          { session },
        )
        await HireApplication.updateOne(
          {
            _id: active.kit.applicationId,
            workspaceId: active.kit.workspaceId,
            jobId: active.kit.jobId,
            candidateId: active.kit.candidateId,
          },
          {
            $push: {
              events: {
                type: 'human_scorecard_submitted',
                actorName: 'Guest interviewer',
                note: 'Guest interviewer submitted a human interview scorecard',
                at: now,
              },
            },
          },
          { session },
        )
        return {
          workspaceId: active.kit.workspaceId,
          applicationId: active.kit.applicationId,
        }
      },
    )
    return { state: 'submitted' }
  } catch (error) {
    if (error instanceof HireCandidatePiiTombstoneError || isPublicKitInactiveError(error)) return null
    throw error
  }
}

/** Member-facing revoke endpoint. It never reaches engine revocation. */
export async function revokeHumanInterviewKit(
  ctx: MembershipContext,
  humanRoundId: string,
): Promise<IHireHumanRound> {
  await connectHireControlDB()
  const now = new Date()
  const round = await withActiveHireWorkspaceWriteTransaction(
    ctx.workspace._id,
    ctx.membership._id,
    async (session) => {
      const current = await HireHumanRound.findOne({
        _id: humanRoundId,
        workspaceId: ctx.workspace._id,
        status: { $nin: ['completed', 'revoked'] },
      }, null, { session })
      if (!current) throw new NotFoundError('Human round')
      await HireInterviewKit.updateMany(
        { workspaceId: ctx.workspace._id, humanRoundId: current._id, active: true },
        {
          $set: {
            active: false,
            status: 'revoked',
            revokedAt: now,
            revokedByMemberId: ctx.membership._id,
            revokedByName: memberName(ctx),
            revocationReason: 'Recruiter revoked the interview kit',
          },
        },
        { session },
      )
      await HireHumanKitDelivery.updateMany(
        {
          workspaceId: ctx.workspace._id,
          humanRoundId: current._id,
          status: { $in: ['pending', 'sending', 'failed'] },
        },
        {
          $set: { status: 'cancelled', cancelledAt: now, lastError: 'Interview kit revoked' },
          $unset: { claimToken: 1, leaseExpiresAt: 1 },
        },
        { session },
      )
      const updated = await HireHumanRound.findOneAndUpdate(
        { _id: current._id, workspaceId: ctx.workspace._id, status: 'pending_scorecard' },
        {
          $set: {
            status: 'revoked',
            revokedAt: now,
            revokedByMemberId: ctx.membership._id,
            revokedByName: memberName(ctx),
            revocationReason: 'Recruiter revoked the interview kit',
          },
        },
        { new: true, session },
      )
      if (!updated) throw new AppError('The human round changed while revoking it', 409, 'HUMAN_ROUND_RACE')
      return updated
    },
  )
  await appendApplicationEvent(ctx.workspace._id, round.applicationId, {
    type: 'human_kit_revoked',
    ...(ctx.membership.userId ? { actorUserId: ctx.membership.userId } : {}),
    actorMemberId: ctx.membership._id,
    actorName: memberName(ctx),
    note: 'Human interview kit revoked',
  })
  return round
}

export const __humanRound = {
  sha256,
  isActiveKit,
}
