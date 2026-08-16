import crypto from 'crypto'
import mongoose, { type ClientSession } from 'mongoose'
import { connectDB } from '@shared/db/connection'
import { AppError, ForbiddenError, NotFoundError } from '@shared/errors'
import { HireSharePacket } from '@hire-decisions/models'
import {
  HireApplication,
  HireCandidate,
  HireEngineHandoff,
  HireGuestSession,
  HireHumanKitDelivery,
  HireHumanRound,
  HireHumanScorecard,
  HireInterviewAttempt,
  HireInterviewKit,
  HireInvitationBatch,
  HireInvitationBatchItem,
  HireJob,
  HireRound,
  HIRE_STAGES,
  TERMINAL_STAGES,
  type HireStage,
  type HireCandidateProvenanceSource,
  type IHireApplication,
  type IHireCandidate,
  type IHireHumanKitDelivery,
  type IHireHumanRound,
  type IHireHumanScorecard,
  type IHireJob,
  type IHireRound,
} from '../models'
import {
  HireJobRequirementVersion,
  type IHireJobBuilderInput,
  type IHireStructuredRequirement,
  type HireWorkMode,
} from '../models/HireJobRequirementVersion'
import { HireEmailOutbox } from '../models/HireEmailOutbox'
import {
  assertValidHireCloseEmailTemplate,
  resolveJobCloseRejectionEmailSnapshot,
  type JobCloseRejectionEmailTemplate,
} from '../emails/jobCloseRejectionEmail'
import { finalizeSmartJd } from './jdBuilderService'
import type { MembershipContext } from './workspaceService'
import {
  cancelFutureHireJobMediaPurge,
  scheduleHireJobMediaPurge,
} from './mediaLifecycleService'
import { withActiveHireWorkspaceWriteTransaction } from './hireWorkspaceWriteFence'
import { deliverRuntimeRevocation } from './engineRevocationService'
import { encodeWorkspaceCapability } from './workspaceCapability'
import {
  claimHireCandidatePiiWriteFence,
  HireCandidatePiiTombstoneError,
} from './hireCandidatePrivacyWriteFence'
import { assertHireOnboardingTestDriveWriteIsolation } from '@hire-onboarding-boundary'
import {
  cancelHireAssessmentExports,
  deleteHireAssessmentExportObjects,
  type HireAssessmentExportCleanupTarget,
} from './assessmentExportLifecycleService'
import {
  cancelHirePipelineStatusReportsForTerminalTransition,
  createHireJobCloseoutReportForLifecycle,
} from '../../hire-reports/services/hireReportLifecycleService'
import {
  kickHireReportExport,
  type HireReportExportRequestResult,
} from '../../hire-reports/services/hireReportExportService'
import { cancelHireDigestOutboxesForScope } from '../../hire-digest/services/hireDigestService'
import { assertAssignableHireDepartment } from '@hire-departments'

/**
 * Jobs, candidates, applications, and the fixed pipeline. Every query in this
 * file threads ctx.workspace._id — the cross-tenant isolation suite asserts
 * exactly that on each function. Stage moves are explicit member actions with
 * actor + timestamp recorded; nothing here moves a card automatically.
 */

function actorName(ctx: MembershipContext): string {
  return ctx.membership.name || ctx.membership.email
}

function actorSnapshot(ctx: MembershipContext) {
  return {
    actorMemberId: ctx.membership._id,
    ...(ctx.membership.userId ? { actorUserId: ctx.membership.userId } : {}),
    actorName: actorName(ctx),
  }
}

async function withHireTransaction<T>(
  ctx: MembershipContext,
  work: (session: ClientSession) => Promise<T>,
): Promise<T> {
  return withActiveHireWorkspaceWriteTransaction(
    ctx.workspace._id,
    ctx.membership._id,
    work,
  )
}

// ─── Jobs ─────────────────────────────────────────────────────────────────────

export async function createJob(
  ctx: MembershipContext,
  input: {
    title: string
    level: string
    mustHaves: string[]
    niceToHaves: string[]
    location: string
    workMode: HireWorkMode
    compensation?: string
    companyBlurb?: string
    departmentId: string
    jdText: string
    screeningSettings?: IHireJob['screeningSettings']
  }
): Promise<IHireJob> {
  await connectDB()
  const jobId = new mongoose.Types.ObjectId()
  const requirementVersionId = new mongoose.Types.ObjectId()
  const builderInput = {
    role: input.title,
    level: input.level,
    mustHaves: input.mustHaves,
    niceToHaves: input.niceToHaves,
    location: input.location,
    workMode: input.workMode,
    ...(input.compensation ? { compensation: input.compensation } : {}),
    ...(input.companyBlurb ? { companyBlurb: input.companyBlurb } : {}),
  }
  const artifact = finalizeSmartJd(builderInput, input.jdText)

  return withHireTransaction(ctx, async (session) => {
    const department = await assertAssignableHireDepartment({
      workspaceId: ctx.workspace._id,
      departmentId: input.departmentId,
      session,
    })
    const jobs = await HireJob.create(
      [
        {
          _id: jobId,
          workspaceId: ctx.workspace._id,
          departmentId: department._id,
          title: input.title,
          jdText: artifact.jdText,
          activeRequirementVersionId: requirementVersionId,
          activeRequirementVersion: 1,
          status: 'open',
          ...(input.screeningSettings
            ? { screeningSettings: cloneScreeningSettings(input.screeningSettings) }
            : {}),
          ...(ctx.membership.userId ? { createdBy: ctx.membership.userId } : {}),
          createdByMemberId: ctx.membership._id,
          createdByName: actorName(ctx),
        },
      ],
      { session },
    )
    await HireJobRequirementVersion.create(
      [
        {
          _id: requirementVersionId,
          workspaceId: ctx.workspace._id,
          jobId,
          version: 1,
          state: 'active',
          input: builderInput,
          proseJd: artifact.jdText,
          requirements: artifact.requirements,
          contentHash: artifact.contentHash,
          createdByMemberId: ctx.membership._id,
          createdByName: actorName(ctx),
        },
      ],
      { session },
    )
    return jobs[0]
  })
}

export interface DuplicateJobResult {
  job: IHireJob
  /** A fresh workspace-scoped public apply capability, returned exactly once. */
  capability: string
}

function cloneRequirementInput(input: IHireJobBuilderInput): IHireJobBuilderInput {
  return {
    role: input.role,
    level: input.level,
    mustHaves: [...input.mustHaves],
    niceToHaves: [...input.niceToHaves],
    location: input.location,
    workMode: input.workMode,
    ...(input.compensation !== undefined ? { compensation: input.compensation } : {}),
    ...(input.companyBlurb !== undefined ? { companyBlurb: input.companyBlurb } : {}),
  }
}

function cloneRequirements(
  requirements: IHireStructuredRequirement[],
): IHireStructuredRequirement[] {
  return requirements.map((requirement) => ({
    id: requirement.id,
    text: requirement.text,
    importance: requirement.importance,
  }))
}

/**
 * Screening settings are job-owned configuration, never a shared Mongoose
 * subdocument. A duplicated requisition gets an independent plain-object
 * copy so later gate defaults can diverge without mutating its source job.
 */
function cloneScreeningSettings(
  settings: IHireJob['screeningSettings'],
): IHireJob['screeningSettings'] {
  if (!settings) return undefined
  const plain = (
    settings as unknown as {
      location?: unknown
      experienceFloorYears?: unknown
      toObject?: () => { location?: unknown; experienceFloorYears?: unknown }
    }
  ).toObject?.() ?? settings
  return {
    ...(typeof plain.location === 'string' ? { location: plain.location } : {}),
    ...(typeof plain.experienceFloorYears === 'number'
      ? { experienceFloorYears: plain.experienceFloorYears }
      : {}),
  }
}

/**
 * Create a fresh job requisition from the source job's active scoring
 * contract. It deliberately copies configuration only: no candidates,
 * applications, rounds, history, close state, or prior public-link secret
 * crosses into the new job.
 */
export async function duplicateJob(
  ctx: MembershipContext,
  sourceJobId: string,
  input: { departmentId: string },
): Promise<DuplicateJobResult> {
  await connectDB()
  const jobId = new mongoose.Types.ObjectId()
  const requirementVersionId = new mongoose.Types.ObjectId()
  const rawApplySecret = crypto.randomBytes(32).toString('hex')
  const applyTokenHash = crypto
    .createHash('sha256')
    .update(rawApplySecret)
    .digest('hex')
  const capability = encodeWorkspaceCapability(
    ctx.workspace._id.toString(),
    rawApplySecret,
  )

  return withHireTransaction(ctx, async (session) => {
    const department = await assertAssignableHireDepartment({
      workspaceId: ctx.workspace._id,
      departmentId: input.departmentId,
      session,
    })
    const sourceJob = await HireJob.findOne(
      { _id: sourceJobId, workspaceId: ctx.workspace._id },
      null,
      { session },
    )
    if (!sourceJob) throw new NotFoundError('Job')
    if (
      !sourceJob.activeRequirementVersionId ||
      !sourceJob.activeRequirementVersion
    ) {
      throw new AppError(
        'The source job has no active requirement version to duplicate',
        409,
        'JOB_REQUIREMENT_VERSION_MISSING',
      )
    }

    const sourceRequirement = await HireJobRequirementVersion.findOne(
      {
        _id: sourceJob.activeRequirementVersionId,
        workspaceId: ctx.workspace._id,
        jobId: sourceJob._id,
        version: sourceJob.activeRequirementVersion,
        state: 'active',
      },
      null,
      { session },
    )
    if (!sourceRequirement) {
      throw new AppError(
        'The source job requirement version is no longer active',
        409,
        'JOB_REQUIREMENT_VERSION_INVALID',
      )
    }

    const jobs = await HireJob.create(
      [
        {
          _id: jobId,
          workspaceId: ctx.workspace._id,
          departmentId: department._id,
          title: sourceJob.title,
          jdText: sourceJob.jdText,
          activeRequirementVersionId: requirementVersionId,
          activeRequirementVersion: 1,
          status: 'open',
          intakeWriteVersion: 0,
          applyTokenHash,
          applyPageEnabled: true,
          ...(sourceJob.screeningSettings
            ? { screeningSettings: cloneScreeningSettings(sourceJob.screeningSettings) }
            : {}),
          events: [],
          ...(ctx.membership.userId ? { createdBy: ctx.membership.userId } : {}),
          createdByMemberId: ctx.membership._id,
          createdByName: actorName(ctx),
        },
      ],
      { session },
    )
    await HireJobRequirementVersion.create(
      [
        {
          _id: requirementVersionId,
          workspaceId: ctx.workspace._id,
          jobId,
          version: 1,
          state: 'active',
          input: cloneRequirementInput(sourceRequirement.input),
          proseJd: sourceRequirement.proseJd,
          requirements: cloneRequirements(sourceRequirement.requirements),
          contentHash: sourceRequirement.contentHash,
          createdByMemberId: ctx.membership._id,
          createdByName: actorName(ctx),
        },
      ],
      { session },
    )
    return { job: jobs[0], capability }
  })
}

/**
 * Department ownership is metadata, not a lifecycle transition. Keeping this
 * as a small dedicated command avoids coupling reassignment to close/reopen
 * revocations, report cleanup, or public-apply state in updateJobStatus().
 */
export async function updateJobDepartment(
  ctx: MembershipContext,
  jobId: string,
  input: { departmentId: string },
): Promise<IHireJob> {
  await connectDB()
  if (ctx.membership.role !== 'admin') {
    throw new ForbiddenError('Only the workspace admin can reassign a job department')
  }

  return withHireTransaction(ctx, async (session) => {
    const department = await assertAssignableHireDepartment({
      workspaceId: ctx.workspace._id,
      departmentId: input.departmentId,
      session,
    })
    const job = await HireJob.findOne(
      { _id: jobId, workspaceId: ctx.workspace._id },
      null,
      { session },
    )
    if (!job) throw new NotFoundError('Job')

    if (String(job.departmentId) === String(department._id)) return job
    const priorDepartmentId = job.departmentId
    job.departmentId = department._id
    job.events.push({
      type: 'department_change',
      fromDepartmentId: priorDepartmentId,
      toDepartmentId: department._id,
      ...actorSnapshot(ctx),
      at: new Date(),
    })
    await job.save({ session })
    return job
  })
}

export interface JobListItem {
  job: IHireJob
  applicationCount: number
  byStage: Partial<Record<HireStage, number>>
}

export async function listJobs(ctx: MembershipContext): Promise<JobListItem[]> {
  await connectDB()
  const jobs = await HireJob.find({ workspaceId: ctx.workspace._id }).sort({ createdAt: -1 })
  const counts = await HireApplication.aggregate([
    { $match: { workspaceId: ctx.workspace._id } },
    { $group: { _id: { jobId: '$jobId', stage: '$stage' }, n: { $sum: 1 } } },
  ])
  const byJob = new Map<string, Partial<Record<HireStage, number>>>()
  for (const row of counts) {
    const key = String(row._id.jobId)
    const entry = byJob.get(key) ?? {}
    entry[row._id.stage as HireStage] = row.n
    byJob.set(key, entry)
  }
  return jobs.map((job) => {
    const byStage = byJob.get(String(job._id)) ?? {}
    const applicationCount = Object.values(byStage).reduce((a, b) => a + (b ?? 0), 0)
    return { job, applicationCount, byStage }
  })
}

export interface PipelineEntry {
  application: IHireApplication
  candidate: IHireCandidate | null
  latestRound: Pick<
    IHireRound,
    '_id' | 'status' | 'invitedAt' | 'linkedAt' | 'results' | 'inviteTokenExpiry' | 'revokedAt'
  > | null
  /**
   * Human-side evidence stays separate from engine-backed `latestRound`.
   * The board gets enough state to render R1/R2 chips without pretending a
   * scorecard is an AI result or calculating a Phase-4 aggregate verdict.
   */
  humanRoundSummary: HumanRoundSummary
  /**
   * A JD-match result is only ranked when it still refers to a résumé we
   * retain. Stale and unscored records remain visible below the fresh scored
   * queue; neither is silently filtered or rejected.
   */
  scoreState: 'scored' | 'stale' | 'unscored'
  /** One-based rank within the fresh, scored portion of this job's queue. */
  rank: number | null
  /**
   * Other applications for this same workspace candidate. This is assembled
   * in bulk in getJobPipeline so a board never performs an N+1 lookup and a
   * candidate can never reveal another tenant's history.
   */
  previouslySeenIn: Array<{
    jobId: string
    jobTitle: string
    stage: HireStage
  }>
}

export interface HumanRoundSummary {
  total: number
  completed: number
  pendingScorecard: number
  revoked: number
  rounds: Array<Pick<
    IHireHumanRound,
    | '_id'
    | 'mode'
    | 'status'
    | 'openedAt'
    | 'scorecardSubmittedAt'
    | 'revokedAt'
    | 'createdAt'
  >>
}

export interface JobPipeline {
  job: IHireJob
  entries: PipelineEntry[]
}

function summarizeHumanRounds(rounds: IHireHumanRound[]): HumanRoundSummary {
  return {
    total: rounds.length,
    completed: rounds.filter((round) => round.status === 'completed').length,
    pendingScorecard: rounds.filter((round) => round.status === 'pending_scorecard').length,
    revoked: rounds.filter((round) => round.status === 'revoked').length,
    rounds,
  }
}

function assertJobStatusTransition(
  from: IHireJob['status'],
  to: IHireJob['status'],
): void {
  if (from === to) {
    throw new AppError('The job is already in that status', 409, 'JOB_STATUS_NOOP')
  }
  if (from === 'closed' && to !== 'open') {
    throw new AppError('A closed job must be reopened before it can be put on hold', 409, 'JOB_STATUS_INVALID')
  }
}

export async function getJobPipeline(
  ctx: MembershipContext,
  jobId: string
): Promise<JobPipeline> {
  await connectDB()
  const job = await HireJob.findOne({ _id: jobId, workspaceId: ctx.workspace._id })
  if (!job) throw new NotFoundError('Job')

  const applications = await HireApplication.find({
    workspaceId: ctx.workspace._id,
    jobId: job._id,
  }).sort({ createdAt: 1, _id: 1 })

  const candidateIds = applications.map((a) => a.candidateId)
  const appIds = applications.map((a) => a._id)
  const [candidates, rounds, humanRounds, otherApplications] = await Promise.all([
    HireCandidate.find({ workspaceId: ctx.workspace._id, _id: { $in: candidateIds } }),
    HireRound.find({ workspaceId: ctx.workspace._id, applicationId: { $in: appIds } })
      .sort({ createdAt: -1 })
      .select('applicationId status invitedAt linkedAt results inviteTokenExpiry revokedAt'),
    HireHumanRound.find({ workspaceId: ctx.workspace._id, applicationId: { $in: appIds } })
      .sort({ createdAt: 1, _id: 1 })
      .select(
        'applicationId mode status openedAt scorecardSubmittedAt revokedAt createdAt',
      ),
    candidateIds.length > 0
      ? HireApplication.find({
          workspaceId: ctx.workspace._id,
          candidateId: { $in: candidateIds },
          jobId: { $ne: job._id },
        }).select('candidateId jobId stage createdAt _id')
      : Promise.resolve([]),
  ])
  const candidateById = new Map(candidates.map((c) => [String(c._id), c]))
  const latestRoundByApp = new Map<string, IHireRound>()
  for (const r of rounds) {
    const key = String(r.applicationId)
    if (!latestRoundByApp.has(key)) latestRoundByApp.set(key, r)
  }
  const humanRoundsByApp = new Map<string, IHireHumanRound[]>()
  for (const round of humanRounds) {
    const key = String(round.applicationId)
    const current = humanRoundsByApp.get(key) ?? []
    current.push(round)
    humanRoundsByApp.set(key, current)
  }

  const otherJobIds = Array.from(
    new Set(otherApplications.map((application) => String(application.jobId))),
  )
  const otherJobs = otherJobIds.length > 0
    ? await HireJob.find({
        workspaceId: ctx.workspace._id,
        _id: { $in: otherJobIds },
      }).select('_id title')
    : []
  const otherJobTitleById = new Map(otherJobs.map((otherJob) => [
    String(otherJob._id),
    otherJob.title,
  ]))
  const previouslySeenByCandidateId = new Map<
    string,
    Array<{ jobId: string; jobTitle: string; stage: HireStage }>
  >()
  for (const otherApplication of otherApplications) {
    const otherJobId = String(otherApplication.jobId)
    const jobTitle = otherJobTitleById.get(otherJobId)
    // A concurrently purged/hidden job must not produce an orphaned label.
    if (!jobTitle) continue
    const candidateKey = String(otherApplication.candidateId)
    const current = previouslySeenByCandidateId.get(candidateKey) ?? []
    current.push({
      jobId: otherJobId,
      jobTitle,
      stage: otherApplication.stage,
    })
    previouslySeenByCandidateId.set(candidateKey, current)
  }
  for (const entries of Array.from(previouslySeenByCandidateId.values())) {
    entries.sort((left, right) =>
      left.jobTitle.localeCompare(right.jobTitle) || left.jobId.localeCompare(right.jobId),
    )
  }

  const ranked = applications.map((application) => {
    const candidate = candidateById.get(String(application.candidateId)) ?? null
    return {
      application,
      candidate,
      scoreState: pipelineScoreState(application, candidate, job.jdText),
    }
  })
  ranked.sort(comparePipelineEntries)

  let nextRank = 1
  return {
    job,
    entries: ranked.map(({ application, candidate, scoreState }) => {
      const rank = scoreState === 'scored' ? nextRank++ : null
      return {
        application,
        candidate,
        latestRound: latestRoundByApp.get(String(application._id)) ?? null,
        humanRoundSummary: summarizeHumanRounds(
          humanRoundsByApp.get(String(application._id)) ?? [],
        ),
        scoreState,
        rank,
        previouslySeenIn: previouslySeenByCandidateId.get(String(application.candidateId)) ?? [],
      }
    }),
  }
}

function resumeHash(resumeText: string | undefined): string | null {
  return resumeText
    ? crypto.createHash('sha256').update(resumeText).digest('hex')
    : null
}

function pipelineScoreState(
  application: IHireApplication,
  candidate: IHireCandidate | null,
  currentJdText: string,
): PipelineEntry['scoreState'] {
  const match = application.resumeMatch
  if (!match || match.score === null) return 'unscored'
  if (match.jdHash !== resumeHash(currentJdText)) return 'stale'
  const currentSources = [
    resumeHash(candidate?.resumeText),
    ...(application.applicantSubmissions ?? []).map((submission) => resumeHash(submission.resumeText)),
  ].filter((hash): hash is string => hash !== null)
  return currentSources.includes(match.resumeHash) ? 'scored' : 'stale'
}

function comparePipelineEntries(
  left: {
    application: IHireApplication
    scoreState: PipelineEntry['scoreState']
  },
  right: {
    application: IHireApplication
    scoreState: PipelineEntry['scoreState']
  },
): number {
  const bucket = (state: PipelineEntry['scoreState']) => state === 'scored' ? 0 : 1
  const bucketDifference = bucket(left.scoreState) - bucket(right.scoreState)
  if (bucketDifference !== 0) return bucketDifference

  if (left.scoreState === 'scored' && right.scoreState === 'scored') {
    const scoreDifference = (right.application.resumeMatch?.score ?? -1) -
      (left.application.resumeMatch?.score ?? -1)
    if (scoreDifference !== 0) return scoreDifference
  }

  const createdDifference = left.application.createdAt.getTime() - right.application.createdAt.getTime()
  return createdDifference || String(left.application._id).localeCompare(String(right.application._id))
}

export async function updateJobStatus(
  ctx: MembershipContext,
  jobId: string,
  input: {
    status: IHireJob['status']
    expectedStatus: IHireJob['status']
    operationId: string
    closeNote?: string
    closeEmailTemplate?: JobCloseRejectionEmailTemplate
  }
): Promise<IHireJob> {
  await connectDB()
  assertJobStatusTransition(input.expectedStatus, input.status)
  const closeNote = input.closeNote?.trim()
  if (input.status === 'closed' && !closeNote) {
    throw new AppError('A decision note is required when closing a job', 400, 'CLOSE_NOTE_REQUIRED')
  }
  if (input.status !== 'closed' && input.closeEmailTemplate !== undefined) {
    throw new AppError(
      'An email template may only be supplied when closing a job',
      400,
      'CLOSE_EMAIL_TEMPLATE_NOT_ALLOWED',
    )
  }
  // The HTTP validator supplies precise field errors. This duplicate service
  // check protects any future internal caller from persisting malformed copy.
  const closeEmailTemplate = input.closeEmailTemplate
    ? assertValidHireCloseEmailTemplate(input.closeEmailTemplate)
    : undefined

  let runtimeRoundIds: string[] = []
  let assessmentExportCleanupTargets: HireAssessmentExportCleanupTarget[] = []
  const closeoutReportResult: { value: HireReportExportRequestResult | null } = { value: null }
  const updatedJob = await withHireTransaction(ctx, async (session) => {
    // A transaction callback can retry after an aborted attempt. Keep only the
    // durable result from its final callback execution for the post-commit kick.
    closeoutReportResult.value = null
    // Closing a synthetic practice job would otherwise create candidate PII
    // email-outbox rows and lifecycle work that do not belong to onboarding.
    // The marker remains a fence in every retained state until the dedicated
    // cleanup has removed its graph.
    await assertHireOnboardingTestDriveWriteIsolation({
      workspaceId: ctx.workspace._id,
      jobId,
      session,
    })
    const prior = await HireJob.findOne(
      {
        _id: jobId,
        workspaceId: ctx.workspace._id,
        events: { $elemMatch: { operationId: input.operationId } },
      },
      null,
      { session },
    )
    if (prior) {
      const event = (prior.events ?? []).find(
        (candidate) => candidate.operationId === input.operationId,
      )
      if (event?.from !== input.expectedStatus || event.to !== input.status) {
        throw new AppError(
          'That operation id was already used for another job status change',
          409,
          'OPERATION_ID_REUSED',
        )
      }
      return prior
    }

    const now = new Date()
    const actor = actorSnapshot(ctx)
    const set: Record<string, unknown> = { status: input.status }
    const unset: Record<string, 1> = {}
    if (input.status === 'closed') {
      set.closeNote = closeNote
      set.closedAt = now
      set.closedByMemberId = ctx.membership._id
      set.closedByName = actor.actorName
      if (ctx.membership.userId) set.closedBy = ctx.membership.userId
    } else if (input.expectedStatus === 'closed') {
      // Close history remains in events; these fields describe only the
      // current status and must not label a reopened job as still closed.
      unset.closeNote = 1
      unset.closedAt = 1
      unset.closedBy = 1
      unset.closedByMemberId = 1
      unset.closedByName = 1
    }

    const job = await HireJob.findOneAndUpdate(
      {
        _id: jobId,
        workspaceId: ctx.workspace._id,
        status: input.expectedStatus,
      },
      {
        $set: set,
        ...(Object.keys(unset).length > 0 ? { $unset: unset } : {}),
        $inc: { intakeWriteVersion: 1 },
        $push: {
          events: {
            type: 'status_change',
            from: input.expectedStatus,
            to: input.status,
            ...actor,
            note: closeNote,
            operationId: input.operationId,
            at: now,
          },
        },
      },
      { new: true, session },
    )
    if (!job) {
      const exists = await HireJob.exists({ _id: jobId, workspaceId: ctx.workspace._id }).session(
        session,
      )
      if (!exists) throw new NotFoundError('Job')
      throw new AppError('The job status changed — refresh and retry', 409, 'JOB_STATUS_RACE')
    }

    if (input.status !== 'closed') return job

    const rounds = await HireRound.find(
      { workspaceId: ctx.workspace._id, jobId: job._id },
      { _id: 1, status: 1, revokedAt: 1 },
      { session },
    )
    const roundIds = rounds.map((round) => round._id)
    runtimeRoundIds = rounds
      .filter(
        (round) =>
          !round.revokedAt && round.status !== 'completed' && round.status !== 'revoked',
      )
      .map((round) => round._id.toString())
    await HireRound.updateMany(
      {
        workspaceId: ctx.workspace._id,
        jobId: job._id,
        status: { $nin: ['completed', 'revoked'] },
        revokedAt: { $exists: false },
      },
      {
        $set: {
          status: 'revoked',
          revokedAt: now,
          revocationState: 'pending',
          revocationReason: 'Job closed by recruiter',
        },
        $unset: { live: 1 },
      },
      { session },
    )
    await HireGuestSession.updateMany(
      { workspaceId: ctx.workspace._id, jobId: job._id, active: true },
      { $set: { revokedAt: now }, $unset: { active: 1 } },
      { session },
    )
    if (roundIds.length > 0) {
      await HireEngineHandoff.updateMany(
        {
          workspaceId: ctx.workspace._id,
          roundId: { $in: roundIds },
          revokedAt: { $exists: false },
        },
        { $set: { revokedAt: now } },
        { session },
      )
    }
    await HireInterviewAttempt.updateMany(
      {
        workspaceId: ctx.workspace._id,
        jobId: job._id,
        live: true,
        status: { $ne: 'completed' },
      },
      { $set: { status: 'revoked' }, $unset: { live: 1 } },
      { session },
    )
    // Human rounds deliberately have no engine/runtime counterpart. Closing a
    // job therefore revokes their possession capabilities and cancels all
    // pending delivery work in this same authority transaction, without ever
    // adding their IDs to `runtimeRoundIds` below.
    await HireHumanKitDelivery.updateMany(
      {
        workspaceId: ctx.workspace._id,
        jobId: job._id,
        status: { $in: ['pending', 'sending', 'failed'] },
      },
      {
        $set: {
          status: 'cancelled',
          cancelledAt: now,
          lastError: 'Job closed before interview-kit delivery',
        },
        $unset: { claimToken: 1, leaseExpiresAt: 1 },
      },
      { session },
    )
    await HireInterviewKit.updateMany(
      {
        workspaceId: ctx.workspace._id,
        jobId: job._id,
        active: true,
      },
      {
        $set: {
          status: 'revoked',
          active: false,
          revokedAt: now,
          revokedByMemberId: ctx.membership._id,
          revokedByName: actor.actorName,
          revocationReason: 'Job closed by recruiter',
        },
      },
      { session },
    )
    await HireHumanScorecard.updateMany(
      {
        workspaceId: ctx.workspace._id,
        jobId: job._id,
        status: 'draft',
      },
      { $set: { status: 'cancelled', cancelledAt: now } },
      { session },
    )
    await HireHumanRound.updateMany(
      {
        workspaceId: ctx.workspace._id,
        jobId: job._id,
        status: { $nin: ['completed', 'revoked'] },
        revokedAt: { $exists: false },
      },
      {
        $set: {
          status: 'revoked',
          revokedAt: now,
          revokedByMemberId: ctx.membership._id,
          revokedByName: actor.actorName,
          revocationReason: 'Job closed by recruiter',
        },
      },
      { session },
    )
    // Share packets are independent possession capabilities. A closed job
    // must invalidate every still-active packet in the same authority
    // transaction, including packets whose expiry has not yet elapsed.
    await HireSharePacket.updateMany(
      {
        workspaceId: ctx.workspace._id,
        jobId: job._id,
        active: true,
        status: 'active',
        revokedAt: { $exists: false },
      },
      {
        $set: {
          active: false,
          status: 'revoked',
          revokedAt: now,
          revokedByMemberId: ctx.membership._id,
          revokedByName: actor.actorName,
          revocationReason: 'Job closed by recruiter',
        },
      },
      { session },
    )
    assessmentExportCleanupTargets = await cancelHireAssessmentExports({
      scope: {
        workspaceId: ctx.workspace._id,
        jobId: job._id,
      },
      cancelledAt: now,
      session,
    })
    // A close changes the aggregate projection for both the workspace-wide
    // pipeline report and this job's report. Preserve prior closeout history;
    // the one new closeout obligation is created below after the final stage
    // writes have committed inside this transaction.
    await cancelHirePipelineStatusReportsForTerminalTransition({
      workspaceId: ctx.workspace._id,
      jobId: job._id,
      cancelledAt: now,
      session,
    })
    // A daily digest snapshot is workspace-aggregate only. Keep member opt-in
    // unchanged, but cancel any unfinished stale aggregate before its exact
    // provider-authorization transaction can race this job close.
    await cancelHireDigestOutboxesForScope({
      workspaceId: ctx.workspace._id,
      now,
      session,
    })
    // Screening confirmation is not a permission to mail after the human
    // closes a requisition. Cancel every unsent reservation in the same job
    // close transaction; a concurrently claimed worker also rechecks this
    // open-job fence before it can create a round.
    await HireInvitationBatchItem.updateMany(
      {
        workspaceId: ctx.workspace._id,
        jobId: job._id,
        status: { $in: ['pending', 'sending', 'failed'] },
      },
      {
        $set: { status: 'cancelled', cancelledAt: now },
        $unset: { claimToken: 1, leaseExpiresAt: 1 },
      },
      { session },
    )
    await HireInvitationBatch.updateMany(
      {
        workspaceId: ctx.workspace._id,
        jobId: job._id,
        status: { $in: ['planned', 'scheduled', 'dispatching', 'failed'] },
      },
      {
        $set: {
          status: 'cancelled',
          cancelledAt: now,
          cancelledByMemberId: ctx.membership._id,
          cancelledByName: actor.actorName,
          cancelNote: 'Job closed before screening invitation dispatch',
        },
        $unset: { claimToken: 1, leaseExpiresAt: 1 },
      },
      { session },
    )

    const applications = await HireApplication.find(
      {
        workspaceId: ctx.workspace._id,
        jobId: job._id,
        // A manual stage rejection has no earlier email path in Phase 1, so
        // it still belongs in the close notification batch. Hired and
        // withdrawn candidates must never receive a rejection notice.
        stage: { $nin: ['hired', 'withdrawn'] },
      },
      null,
      { session },
    )
    if (applications.length === 0) {
      closeoutReportResult.value = await createHireJobCloseoutReportForLifecycle({
        workspaceId: ctx.workspace._id,
        job,
        operationId: input.operationId,
        requestedBy: { memberId: ctx.membership._id.toString(), name: actor.actorName },
        session,
        now,
      })
      return job
    }

    const undecidedApplications = applications.filter(
      (application) => application.stage !== 'rejected',
    )
    const priorNotifications = await HireEmailOutbox.find(
      {
        workspaceId: ctx.workspace._id,
        jobId: job._id,
        applicationId: { $in: applications.map((application) => application._id) },
        kind: 'job_close_rejection',
      },
      { applicationId: 1 },
      { session },
    )
    const notifiedApplicationIds = new Set(
      priorNotifications.map((notification) => notification.applicationId.toString()),
    )
    const notificationApplications = applications.filter(
      (application) => !notifiedApplicationIds.has(application._id.toString()),
    )

    const candidates = notificationApplications.length > 0
      ? await HireCandidate.find(
        {
          workspaceId: ctx.workspace._id,
          _id: {
            $in: notificationApplications.map((application) => application.candidateId),
          },
        },
        null,
        { session },
      )
      : []
    const candidateById = new Map(candidates.map((candidate) => [String(candidate._id), candidate]))
    for (const application of notificationApplications) {
      if (!candidateById.has(String(application.candidateId))) {
        throw new AppError(
          'A candidate record is missing; the job was not closed',
          409,
          'CLOSE_CANDIDATE_MISSING',
        )
      }
    }

    if (undecidedApplications.length > 0) {
      const batch = await HireApplication.bulkWrite(
        undecidedApplications.map((application) => ({
          updateOne: {
            filter: {
              _id: application._id,
              workspaceId: ctx.workspace._id,
              jobId: job._id,
              stage: application.stage,
            },
            update: {
              $set: { stage: 'rejected', decisionNote: closeNote },
              $push: {
                events: {
                  type: 'stage_move',
                  from: application.stage,
                  to: 'rejected',
                  ...actor,
                  note: closeNote,
                  operationId: input.operationId,
                  at: now,
                },
              },
            },
          },
        })),
        { session },
      )
      if (batch.modifiedCount !== undecidedApplications.length) {
        throw new AppError(
          'A candidate stage changed while the job was closing — retry',
          409,
          'CLOSE_STAGE_RACE',
        )
      }
    }

    if (notificationApplications.length > 0) {
      await HireEmailOutbox.create(
        notificationApplications.map((application, index) => {
          const candidate = candidateById.get(String(application.candidateId))!
          return {
            workspaceId: ctx.workspace._id,
            jobId: job._id,
            applicationId: application._id,
            candidateId: candidate._id,
            kind: 'job_close_rejection',
            operationId: input.operationId,
            recipientEmail: candidate.email,
            recipientName: candidate.name,
            payload: {
              jobTitle: job.title,
              workspaceName: ctx.workspace.name,
              // Resolve from the candidate/job/workspace snapshots visible in
              // THIS transaction. A later retry never consults mutable HR
              // input or candidate records to change sent copy.
              emailSnapshot: resolveJobCloseRejectionEmailSnapshot({
                candidateName: candidate.name,
                jobTitle: job.title,
                workspaceName: ctx.workspace.name,
                ...(closeEmailTemplate ? { template: closeEmailTemplate } : {}),
              }),
              // This remains internal audit evidence. It is deliberately not
              // an argument to the candidate-facing email renderer.
              decisionNote: closeNote!,
              actorName: actor.actorName,
            },
            status: 'pending',
            // Deliberately stagger even a manual close batch. The worker may
            // apply a larger provider-aware delay but never sends earlier.
            sendAfter: new Date(now.getTime() + index * 2_000),
            attempts: 0,
          }
        }),
        { session },
      )
    }
    closeoutReportResult.value = await createHireJobCloseoutReportForLifecycle({
      workspaceId: ctx.workspace._id,
      job,
      operationId: input.operationId,
      requestedBy: { memberId: ctx.membership._id.toString(), name: actor.actorName },
      session,
      now,
    })
    return job
  })
  const closeoutReportExport = closeoutReportResult.value
  if (closeoutReportExport?.created) {
    await kickHireReportExport({
      workspaceId: ctx.workspace._id.toString(),
      exportId: closeoutReportExport.export.id,
    })
  }
  await deleteHireAssessmentExportObjects(assessmentExportCleanupTargets)
  if (input.status === 'closed' && updatedJob.closedAt) {
    await scheduleHireJobMediaPurge({
      workspaceId: ctx.workspace._id.toString(),
      jobId: updatedJob._id.toString(),
      closedAt: updatedJob.closedAt,
    })
    for (let offset = 0; offset < runtimeRoundIds.length; offset += 10) {
      await Promise.all(
        runtimeRoundIds
          .slice(offset, offset + 10)
          .map((roundId) =>
            deliverRuntimeRevocation(ctx.workspace._id.toString(), roundId),
          ),
      )
    }
  } else if (input.expectedStatus === 'closed') {
    await cancelFutureHireJobMediaPurge({
      workspaceId: ctx.workspace._id.toString(),
      jobId: updatedJob._id.toString(),
    })
  }
  return updatedJob
}

// ─── Candidates ───────────────────────────────────────────────────────────────

export async function addCandidate(
  ctx: MembershipContext,
  input: {
    name: string
    email: string
    phone?: string
    resumeText?: string
    resumeFileName?: string
  }
): Promise<IHireCandidate> {
  await connectDB()
  try {
    return await withHireTransaction(ctx, async (session) => {
      const created = await HireCandidate.create([{
        workspaceId: ctx.workspace._id,
        name: input.name,
        email: input.email.toLowerCase(),
        phone: input.phone,
        resumeText: input.resumeText,
        resumeFileName: input.resumeFileName,
        source: 'manual',
        ...(ctx.membership.userId ? { createdBy: ctx.membership.userId } : {}),
        createdByMemberId: ctx.membership._id,
        createdByName: actorName(ctx),
      }], { session })
      return created[0]
    })
  } catch (err: unknown) {
    if (err && typeof err === 'object' && (err as { code?: number }).code === 11000) {
      throw new AppError(
        'A candidate with this email already exists in your workspace',
        409,
        'CANDIDATE_EXISTS'
      )
    }
    throw err
  }
}

export async function listCandidates(ctx: MembershipContext): Promise<IHireCandidate[]> {
  await connectDB()
  return HireCandidate.find({ workspaceId: ctx.workspace._id }).sort({ createdAt: -1 })
}

// ─── Applications + stage moves ──────────────────────────────────────────────

export async function createApplication(
  ctx: MembershipContext,
  input: { jobId: string; candidateId: string }
): Promise<IHireApplication> {
  await connectDB()
  const [job, candidate] = await Promise.all([
    HireJob.findOne({ _id: input.jobId, workspaceId: ctx.workspace._id }),
    HireCandidate.findOne({ _id: input.candidateId, workspaceId: ctx.workspace._id }),
  ])
  if (!job) throw new NotFoundError('Job')
  if (!candidate) throw new NotFoundError('Candidate')
  if (job.status !== 'open') {
    throw new AppError(
      job.status === 'closed' ? 'This job is closed' : 'This job is on hold',
      409,
      job.status === 'closed' ? 'JOB_CLOSED' : 'JOB_ON_HOLD',
    )
  }

  try {
    return await withHireTransaction(ctx, async (session) => {
      await assertHireOnboardingTestDriveWriteIsolation({
        workspaceId: ctx.workspace._id,
        jobId: job._id,
        candidateId: candidate._id,
        session,
      })
      const claim = await HireJob.updateOne(
        { _id: job._id, workspaceId: ctx.workspace._id, status: 'open' },
        { $inc: { intakeWriteVersion: 1 } },
        { session },
      )
      if (claim.matchedCount !== 1) {
        throw new AppError('This job is no longer open', 409, 'JOB_NOT_OPEN')
      }
      const created = await HireApplication.create(
        [
          {
            workspaceId: ctx.workspace._id,
            jobId: job._id,
            candidateId: candidate._id,
            stage: 'new',
            events: [
              {
                type: 'created',
                ...actorSnapshot(ctx),
                at: new Date(),
              },
            ],
            ...(ctx.membership.userId ? { createdBy: ctx.membership.userId } : {}),
            createdByMemberId: ctx.membership._id,
            createdByName: actorName(ctx),
          },
        ],
        { session },
      )
      return created[0]
    })
  } catch (err: unknown) {
    if (err && typeof err === 'object' && (err as { code?: number }).code === 11000) {
      throw new AppError('This candidate is already on this job', 409, 'APPLICATION_EXISTS')
    }
    throw err
  }
}

/**
 * One transactional path for a recruiter adding someone to a specific job.
 *
 * This deliberately does not compose `addCandidate` and `createApplication`:
 * those independent Phase 1 mutations left a race between the workspace email
 * key and the per-job application key. Here both identities resolve under the
 * same active-workspace transaction, so a retry or two recruiters acting at
 * once cannot make a second card for the same person/job.
 */
export interface AddOrMergeJobCandidateInput {
  /** Existing workspace-local talent-pool candidate. */
  candidateId?: string
  /** Manual entry; email is resolved only inside the current workspace. */
  name?: string
  email?: string
  phone?: string
  /** Client-generated idempotency key, retained on application audit events. */
  operationId: string
}

export type AddOrMergeJobCandidateStatus =
  | 'created'
  | 'reapplied'
  | 'already_considered'
  | 'already_decided'

export interface AddOrMergeJobCandidateResult {
  candidate: IHireCandidate
  application: IHireApplication
  status: AddOrMergeJobCandidateStatus
  createdCandidate: boolean
  createdApplication: boolean
  /** True only when a newly observed manual/pool source was persisted. */
  sourceMerged: boolean
}

type RecruiterCandidateSource = Extract<HireCandidateProvenanceSource, 'manual' | 'pool'>

function sourceLabel(source: RecruiterCandidateSource): string {
  return source === 'pool' ? 'talent pool' : 'manual entry'
}

function hasDuplicateKeyError(error: unknown): boolean {
  return !!(
    error &&
    typeof error === 'object' &&
    (error as { code?: unknown }).code === 11000
  )
}

function priorOperationForAdd(
  application: IHireApplication,
  operationId: string,
): 'matching' | 'conflicting' | null {
  const event = application.events.find((entry) => entry.operationId === operationId)
  if (!event) return null
  return ['created', 'reapplied', 'source_merged'].includes(event.type)
    ? 'matching'
    : 'conflicting'
}

/**
 * Adds only missing provenance values. Existing candidates predating Phase 2
 * have only `source`; that original value is folded into sourceHistory the
 * first time we merge them so no historical provenance is lost.
 */
async function recordCandidateSourceProvenance(
  candidate: IHireCandidate,
  workspaceId: mongoose.Types.ObjectId,
  source: RecruiterCandidateSource,
  session: ClientSession,
): Promise<boolean> {
  const original = candidate.source ?? 'manual'
  const history = new Set<HireCandidateProvenanceSource>(candidate.sourceHistory ?? [])
  const known = new Set<HireCandidateProvenanceSource>([original, ...Array.from(history)])

  // `source` is already represented on most legacy records. Do not write a
  // no-op sourceHistory array merely because the Phase 2 field is absent.
  if (known.has(source)) return false
  const additions = [original, source].filter((value) => !history.has(value))

  const updated = await HireCandidate.updateOne(
    {
      _id: candidate._id,
      workspaceId,
      piiAnonymizedAt: { $exists: false },
    },
    {
      $addToSet: { sourceHistory: { $each: additions } },
    },
    { session, runValidators: true },
  )
  if (updated.matchedCount !== 1) {
    throw new AppError(
      'Candidate changed while recording source provenance; retry the add',
      409,
      'CANDIDATE_MERGE_RACE',
    )
  }
  return true
}

function terminalAddResult(
  candidate: IHireCandidate,
  application: IHireApplication,
  createdCandidate: boolean,
): AddOrMergeJobCandidateResult {
  return {
    candidate,
    application,
    status: application.stage === 'rejected' ? 'already_considered' : 'already_decided',
    createdCandidate,
    createdApplication: false,
    sourceMerged: false,
  }
}

async function addOrMergeJobCandidateOnce(
  ctx: MembershipContext,
  jobId: string,
  input: AddOrMergeJobCandidateInput,
): Promise<AddOrMergeJobCandidateResult> {
  const manual = !input.candidateId
  if (manual && (!input.name?.trim() || !input.email?.trim())) {
    throw new AppError('Name and email are required for a manual candidate', 422, 'CANDIDATE_REQUIRED')
  }
  const email = input.email?.trim().toLowerCase()

  return withHireTransaction(ctx, async (session) => {
    const job = await HireJob.findOne(
      { _id: jobId, workspaceId: ctx.workspace._id },
      null,
      { session },
    )
    if (!job) throw new NotFoundError('Job')
    if (job.status !== 'open') {
      throw new AppError(
        job.status === 'closed' ? 'This job is closed' : 'This job is on hold',
        409,
        job.status === 'closed' ? 'JOB_CLOSED' : 'JOB_ON_HOLD',
      )
    }
    await assertHireOnboardingTestDriveWriteIsolation({
      workspaceId: ctx.workspace._id,
      jobId: job._id,
      session,
    })

    const source: RecruiterCandidateSource = input.candidateId ? 'pool' : 'manual'
    let candidate: IHireCandidate | null
    let createdCandidate = false
    if (input.candidateId) {
      candidate = await HireCandidate.findOne(
        { _id: input.candidateId, workspaceId: ctx.workspace._id },
        null,
        { session },
      )
    } else {
      candidate = await HireCandidate.findOne(
        { workspaceId: ctx.workspace._id, email },
        null,
        { session },
      )
      if (!candidate) {
        const created = await HireCandidate.create(
          [
            {
              workspaceId: ctx.workspace._id,
              name: input.name!.trim(),
              email,
              ...(input.phone?.trim() ? { phone: input.phone.trim() } : {}),
              source,
              sourceHistory: [source],
              ...(ctx.membership.userId ? { createdBy: ctx.membership.userId } : {}),
              createdByMemberId: ctx.membership._id,
              createdByName: actorName(ctx),
            },
          ],
          { session },
        )
        candidate = created[0]
        createdCandidate = true
      }
    }
    if (!candidate) throw new NotFoundError('Candidate')
    await assertHireOnboardingTestDriveWriteIsolation({
      workspaceId: ctx.workspace._id,
      candidateId: candidate._id,
      session,
    })

    const existingApplication = await HireApplication.findOne(
      {
        workspaceId: ctx.workspace._id,
        jobId: job._id,
        candidateId: candidate._id,
      },
      null,
      { session },
    )
    if (existingApplication && TERMINAL_STAGES.includes(existingApplication.stage)) {
      // A recruiter must make an explicit stage decision to reinstate a
      // terminal card. A duplicate manual form/pool click cannot revive it.
      return terminalAddResult(candidate, existingApplication, createdCandidate)
    }

    if (existingApplication) {
      const priorOperation = priorOperationForAdd(existingApplication, input.operationId)
      if (priorOperation === 'conflicting') {
        throw new AppError(
          'This operation id belongs to a different candidate action',
          409,
          'OPERATION_ID_REUSED',
        )
      }
      if (priorOperation === 'matching') {
        return {
          candidate,
          application: existingApplication,
          status: 'reapplied',
          createdCandidate,
          createdApplication: false,
          sourceMerged: false,
        }
      }
    }

    // Claim the job only for a mutation. A terminal-safe response above does
    // not bump write versions, and a close racing this add wins cleanly.
    const jobClaim = await HireJob.updateOne(
      { _id: job._id, workspaceId: ctx.workspace._id, status: 'open' },
      { $inc: { intakeWriteVersion: 1 } },
      { session },
    )
    if (jobClaim.matchedCount !== 1) {
      throw new AppError('This job is no longer open', 409, 'JOB_NOT_OPEN')
    }

    try {
      await claimHireCandidatePiiWriteFence({
        workspaceId: ctx.workspace._id,
        candidateId: candidate._id,
        session,
      })
    } catch (error) {
      if (error instanceof HireCandidatePiiTombstoneError) {
        throw new AppError(
          'Candidate personal data has been deleted and cannot be added',
          409,
          'CANDIDATE_DATA_DELETED',
        )
      }
      throw error
    }

    const sourceMerged = createdCandidate
      ? false
      : await recordCandidateSourceProvenance(candidate, ctx.workspace._id, source, session)

    if (!existingApplication) {
      const created = await HireApplication.create(
        [
          {
            workspaceId: ctx.workspace._id,
            jobId: job._id,
            candidateId: candidate._id,
            stage: 'new',
            events: [
              {
                type: 'created',
                ...actorSnapshot(ctx),
                note: `Added via ${sourceLabel(source)}`,
                operationId: input.operationId,
                at: new Date(),
              },
            ],
            ...(ctx.membership.userId ? { createdBy: ctx.membership.userId } : {}),
            createdByMemberId: ctx.membership._id,
            createdByName: actorName(ctx),
          },
        ],
        { session },
      )
      return {
        candidate,
        application: created[0],
        status: 'created',
        createdCandidate,
        createdApplication: true,
        sourceMerged,
      }
    }

    const events = [
      ...(sourceMerged
        ? [
            {
              type: 'source_merged' as const,
              ...actorSnapshot(ctx),
              note: `Candidate source recorded: ${sourceLabel(source)}`,
              operationId: input.operationId,
              at: new Date(),
            },
          ]
        : []),
      {
        type: 'reapplied' as const,
        ...actorSnapshot(ctx),
        note: `Candidate re-applied via ${sourceLabel(source)}`,
        operationId: input.operationId,
        at: new Date(),
      },
    ]
    const updatedApplication = await HireApplication.findOneAndUpdate(
      {
        _id: existingApplication._id,
        workspaceId: ctx.workspace._id,
        jobId: job._id,
        candidateId: candidate._id,
        'events.operationId': { $ne: input.operationId },
      },
      { $push: { events: { $each: events } } },
      { new: true, session, runValidators: true },
    )
    if (!updatedApplication) {
      throw new AppError(
        'This candidate changed while being re-added; retry the add',
        409,
        'APPLICATION_MERGE_RACE',
      )
    }
    return {
      candidate,
      application: updatedApplication,
      status: 'reapplied',
      createdCandidate,
      createdApplication: false,
      sourceMerged,
    }
  })
}

export async function addOrMergeJobCandidate(
  ctx: MembershipContext,
  jobId: string,
  input: AddOrMergeJobCandidateInput,
): Promise<AddOrMergeJobCandidateResult> {
  await connectDB()

  // A Mongo duplicate-key race can occur only at the two workspace-unique
  // identities below. One bounded replay reads the winner and returns the
  // existing card; no unbounded retry loop can amplify a faulty client.
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      return await addOrMergeJobCandidateOnce(ctx, jobId, input)
    } catch (error) {
      if (attempt === 0 && hasDuplicateKeyError(error)) continue
      throw error
    }
  }
  throw new AppError('Could not add this candidate; retry the request', 409, 'APPLICATION_MERGE_RACE')
}

export interface StageMoveInput {
  action: 'advance' | 'reject' | 'withdraw' | 'offer_accepted' | 'offer_declined'
  expectedFrom: HireStage
  operationId: string
  note?: string
}

function targetStageForMove(from: HireStage, action: StageMoveInput['action']): HireStage {
  if (TERMINAL_STAGES.includes(from)) {
    throw new AppError('This application is already decided', 409, 'STAGE_TERMINAL')
  }
  if (action === 'reject') return 'rejected'
  if (action === 'withdraw') return 'withdrawn'
  if (action === 'offer_accepted') {
    if (from !== 'offer') {
      throw new AppError('An offer can only be accepted from Offer', 409, 'OFFER_STAGE_REQUIRED')
    }
    return 'hired'
  }
  if (action === 'offer_declined') {
    if (from !== 'offer') {
      throw new AppError('An offer can only be declined from Offer', 409, 'OFFER_STAGE_REQUIRED')
    }
    return 'rejected'
  }
  if (from === 'offer') {
    throw new AppError(
      'Record whether the offer was accepted or declined',
      409,
      'OFFER_OUTCOME_REQUIRED',
    )
  }
  const to = HIRE_STAGES[HIRE_STAGES.indexOf(from) + 1]
  if (!to || TERMINAL_STAGES.includes(to)) {
    throw new AppError('Cannot advance from this stage', 409, 'CANNOT_ADVANCE')
  }
  return to
}

/**
 * Advance moves exactly one step along the fixed order; reject is allowed
 * from any non-terminal stage. Marking Hired requires a decision note (build
 * plan §Core data model). The update is guarded on the stage the caller saw,
 * so two members racing a move get a 409 instead of a silent double-move.
 */
export async function moveStage(
  ctx: MembershipContext,
  applicationId: string,
  input: StageMoveInput
): Promise<IHireApplication> {
  await connectDB()
  const application = await HireApplication.findOne({
    _id: applicationId,
    workspaceId: ctx.workspace._id,
  })
  if (!application) throw new NotFoundError('Application')

  const from = input.expectedFrom
  const to = targetStageForMove(from, input.action)
  if (to === 'hired' && !input.note?.trim()) {
    throw new AppError(
      'A decision note is required when marking a candidate Hired',
      400,
      'DECISION_NOTE_REQUIRED'
    )
  }
  const repeated = (application.events ?? []).find(
    (event) => event.operationId === input.operationId,
  )
  if (repeated) {
    if (repeated.type !== 'stage_move' || repeated.from !== from || repeated.to !== to) {
      throw new AppError(
        'That operation id was already used for another stage move',
        409,
        'OPERATION_ID_REUSED',
      )
    }
    return application
  }
  if (application.stage !== from) {
    throw new AppError('The stage changed underneath you — refresh and retry', 409, 'STAGE_RACE')
  }

  const update: Record<string, unknown> = { stage: to }
  if (TERMINAL_STAGES.includes(to) && input.note?.trim()) {
    update.decisionNote = input.note.trim()
  }
  if (input.action === 'offer_accepted' || input.action === 'offer_declined') {
    update.offerDecision = {
      outcome: input.action === 'offer_accepted' ? 'accepted' : 'declined',
      ...actorSnapshot(ctx),
      note: input.note?.trim(),
      at: new Date(),
    }
  }

  let assessmentExportCleanupTargets: HireAssessmentExportCleanupTarget[] = []
  const result = await withHireTransaction(ctx, async (session) => {
    const jobClaim = await HireJob.updateOne(
      { _id: application.jobId, workspaceId: ctx.workspace._id, status: 'open' },
      { $inc: { intakeWriteVersion: 1 } },
      { session },
    )
    if (jobClaim.matchedCount !== 1) {
      throw new AppError('Candidate stages can change only while the job is open', 409, 'JOB_NOT_OPEN')
    }

    const moved = await HireApplication.findOneAndUpdate(
      {
        _id: application._id,
        workspaceId: ctx.workspace._id,
        stage: from,
        'events.operationId': { $ne: input.operationId },
      },
      {
        $set: update,
        $push: {
          events: {
            type: 'stage_move',
            from,
            to,
            ...actorSnapshot(ctx),
            note: input.note?.trim(),
            operationId: input.operationId,
            at: new Date(),
          },
        },
      },
      { new: true, session },
    )
    if (moved) {
      // Human interview kits are independent from AI HireRounds and their
      // runtime authority. A terminal pipeline decision must nevertheless
      // invalidate their public capability and any mutable human evidence in
      // the same transaction as the stage transition.
      if (TERMINAL_STAGES.includes(to)) {
        const terminalAt = new Date()
        const lifecycleScope = {
          workspaceId: ctx.workspace._id,
          applicationId: application._id,
          jobId: application.jobId,
          candidateId: application.candidateId,
        }
        const revocationReason = `Application moved to terminal stage: ${to}`
        // Keep each operation sequential: MongoDB transactions do not support
        // parallel operations on the same session.
        await HireHumanKitDelivery.updateMany(
          {
            ...lifecycleScope,
            status: { $in: ['pending', 'sending', 'failed'] },
          },
          {
            $set: {
              status: 'cancelled',
              cancelledAt: terminalAt,
              lastError: 'Application reached a terminal stage',
            },
            $unset: { claimToken: 1, leaseExpiresAt: 1 },
          },
          { session },
        )
        await HireInterviewKit.updateMany(
          { ...lifecycleScope, active: true },
          {
            // Do not unset `active`: the schema default could rehydrate it.
            $set: {
              active: false,
              status: 'revoked',
              revokedAt: terminalAt,
              revokedByMemberId: ctx.membership._id,
              revokedByName: actorName(ctx),
              revocationReason,
            },
          },
          { session },
        )
        await HireHumanScorecard.updateMany(
          { ...lifecycleScope, status: 'draft' },
          { $set: { status: 'cancelled', cancelledAt: terminalAt } },
          { session },
        )
        await HireHumanRound.updateMany(
          {
            ...lifecycleScope,
            status: { $nin: ['completed', 'revoked'] },
          },
          {
            $set: {
              status: 'revoked',
              revokedAt: terminalAt,
              revokedByMemberId: ctx.membership._id,
              revokedByName: actorName(ctx),
              revocationReason,
            },
          },
          { session },
        )
        await HireSharePacket.updateMany(
          {
            ...lifecycleScope,
            active: true,
            status: 'active',
            revokedAt: { $exists: false },
          },
          {
            $set: {
              active: false,
              status: 'revoked',
              revokedAt: terminalAt,
              revokedByMemberId: ctx.membership._id,
              revokedByName: actorName(ctx),
              revocationReason,
            },
          },
          { session },
        )
        assessmentExportCleanupTargets = await cancelHireAssessmentExports({
          scope: lifecycleScope,
          cancelledAt: terminalAt,
          session,
        })
        // The terminal stage changes one job's aggregate counts. Invalidate
        // only that job's and the workspace-wide pipeline exports; closeout
        // exports remain historical records and are not part of this policy.
        await cancelHirePipelineStatusReportsForTerminalTransition({
          workspaceId: ctx.workspace._id,
          jobId: application.jobId,
          cancelledAt: terminalAt,
          session,
        })
        // The digest is an immutable workspace aggregate, so its unfinished
        // rows must not email a pre-terminal snapshot. This does not disable
        // the member's opt-in for future periods.
        await cancelHireDigestOutboxesForScope({
          workspaceId: ctx.workspace._id,
          now: terminalAt,
          session,
        })
      }
      return moved
    }

    const idempotent = await HireApplication.findOne(
      {
        _id: application._id,
        workspaceId: ctx.workspace._id,
        events: { $elemMatch: { operationId: input.operationId } },
      },
      null,
      { session },
    )
    if (idempotent) return idempotent
    throw new AppError('The stage changed underneath you — refresh and retry', 409, 'STAGE_RACE')
  })
  await deleteHireAssessmentExportObjects(assessmentExportCleanupTargets)
  return result
}

export interface ApplicationDetail {
  application: IHireApplication
  candidate: IHireCandidate
  job: IHireJob
  rounds: IHireRound[]
  humanRounds: HumanRoundDetail[]
}

/**
 * Authenticated member projection for a human round. It intentionally omits
 * kit hash/capability, delivery recipient PII, ciphertext, provider response,
 * and raw failure details while retaining the fixed submitted evidence.
 */
export interface HumanRoundDetail {
  round: IHireHumanRound
  scorecard: Pick<
    IHireHumanScorecard,
    | 'reviewerKind'
    | 'reviewerName'
    | 'dimensions'
    | 'recommendation'
    | 'overallComment'
    | 'submittedAt'
  > | null
  delivery: {
    initial: Pick<IHireHumanKitDelivery, 'status' | 'attempts' | 'sentAt'> | null
    reminder: Pick<IHireHumanKitDelivery, 'status' | 'sentAt'> | null
  }
}

export async function getApplicationDetail(
  ctx: MembershipContext,
  applicationId: string
): Promise<ApplicationDetail> {
  await connectDB()
  const application = await HireApplication.findOne({
    _id: applicationId,
    workspaceId: ctx.workspace._id,
  })
  if (!application) throw new NotFoundError('Application')

  const [candidate, job, rounds, humanRounds, submittedHumanScorecards, humanDeliveries] = await Promise.all([
    HireCandidate.findOne({ _id: application.candidateId, workspaceId: ctx.workspace._id }),
    HireJob.findOne({ _id: application.jobId, workspaceId: ctx.workspace._id }),
    HireRound.find({ workspaceId: ctx.workspace._id, applicationId: application._id }).sort({
      createdAt: -1,
    }),
    HireHumanRound.find({
      workspaceId: ctx.workspace._id,
      applicationId: application._id,
    }).sort({ createdAt: 1, _id: 1 }),
    HireHumanScorecard.find({
      workspaceId: ctx.workspace._id,
      applicationId: application._id,
      jobId: application.jobId,
      candidateId: application.candidateId,
      status: 'submitted',
    }).select(
      'humanRoundId reviewerKind reviewerName dimensions recommendation overallComment submittedAt',
    ),
    HireHumanKitDelivery.find({
      workspaceId: ctx.workspace._id,
      applicationId: application._id,
      jobId: application.jobId,
      candidateId: application.candidateId,
      purpose: { $in: ['initial', 'reminder'] },
    }).select('humanRoundId purpose status attempts sentAt'),
  ])
  if (!candidate || !job) throw new NotFoundError('Application')
  const scorecardByRoundId = new Map(
    submittedHumanScorecards.map((scorecard) => [scorecard.humanRoundId.toString(), scorecard]),
  )
  const deliveriesByRoundId = new Map<
    string,
    {
      initial: Pick<IHireHumanKitDelivery, 'status' | 'attempts' | 'sentAt'> | null
      reminder: Pick<IHireHumanKitDelivery, 'status' | 'sentAt'> | null
    }
  >()
  for (const delivery of humanDeliveries) {
    const roundId = delivery.humanRoundId.toString()
    const current = deliveriesByRoundId.get(roundId) ?? { initial: null, reminder: null }
    if (delivery.purpose === 'initial') {
      current.initial = {
        status: delivery.status,
        attempts: delivery.attempts,
        sentAt: delivery.sentAt,
      }
    } else {
      current.reminder = {
        status: delivery.status,
        sentAt: delivery.sentAt,
      }
    }
    deliveriesByRoundId.set(roundId, current)
  }
  return {
    application,
    candidate,
    job,
    rounds,
    humanRounds: humanRounds.map((round) => ({
      round,
      scorecard: scorecardByRoundId.get(round._id.toString()) ?? null,
      delivery: deliveriesByRoundId.get(round._id.toString()) ?? { initial: null, reminder: null },
    })),
  }
}

/** Append an event to an application — used by round send/revoke/link flows. */
export async function appendApplicationEvent(
  workspaceId: mongoose.Types.ObjectId | string,
  applicationId: mongoose.Types.ObjectId | string,
  event: {
    type:
      | 'ai_round_sent'
      | 'ai_round_revoked'
      | 'ai_result_linked'
      | 'human_round_logged'
      | 'human_kit_sent'
      | 'human_kit_delivery_failed'
      | 'human_kit_revoked'
      | 'human_scorecard_submitted'
      | 'human_kit_reminded'
    actorUserId?: mongoose.Types.ObjectId | string
    actorMemberId?: mongoose.Types.ObjectId | string
    actorName: string
    note?: string
    operationId?: string
  }
): Promise<void> {
  await connectDB()
  await HireApplication.updateOne(
    { _id: applicationId, workspaceId },
    { $push: { events: { ...event, at: new Date() } } }
  )
}
