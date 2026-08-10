import mongoose, { type ClientSession } from 'mongoose'
import { connectDB } from '@shared/db/connection'
import { AppError, NotFoundError } from '@shared/errors'
import {
  HireApplication,
  HireCandidate,
  HireEngineHandoff,
  HireGuestSession,
  HireInterviewAttempt,
  HireJob,
  HireRound,
  HIRE_STAGES,
  TERMINAL_STAGES,
  type HireStage,
  type IHireApplication,
  type IHireCandidate,
  type IHireJob,
  type IHireRound,
} from '../models'
import {
  HireJobRequirementVersion,
  type HireWorkMode,
} from '../models/HireJobRequirementVersion'
import { HireEmailOutbox } from '../models/HireEmailOutbox'
import { finalizeSmartJd } from './jdBuilderService'
import type { MembershipContext } from './workspaceService'
import {
  cancelFutureHireJobMediaPurge,
  scheduleHireJobMediaPurge,
} from './mediaLifecycleService'
import { withActiveHireWorkspaceWriteTransaction } from './hireWorkspaceWriteFence'
import { deliverRuntimeRevocation } from './engineRevocationService'

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
    jdText: string
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
    const jobs = await HireJob.create(
      [
        {
          _id: jobId,
          workspaceId: ctx.workspace._id,
          title: input.title,
          jdText: artifact.jdText,
          activeRequirementVersionId: requirementVersionId,
          activeRequirementVersion: 1,
          status: 'open',
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
}

export interface JobPipeline {
  job: IHireJob
  entries: PipelineEntry[]
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
  }).sort({ createdAt: -1 })

  const candidateIds = applications.map((a) => a.candidateId)
  const appIds = applications.map((a) => a._id)
  const [candidates, rounds] = await Promise.all([
    HireCandidate.find({ workspaceId: ctx.workspace._id, _id: { $in: candidateIds } }),
    HireRound.find({ workspaceId: ctx.workspace._id, applicationId: { $in: appIds } })
      .sort({ createdAt: -1 })
      .select('applicationId status invitedAt linkedAt results inviteTokenExpiry revokedAt'),
  ])
  const candidateById = new Map(candidates.map((c) => [String(c._id), c]))
  const latestRoundByApp = new Map<string, IHireRound>()
  for (const r of rounds) {
    const key = String(r.applicationId)
    if (!latestRoundByApp.has(key)) latestRoundByApp.set(key, r)
  }

  return {
    job,
    entries: applications.map((application) => ({
      application,
      candidate: candidateById.get(String(application.candidateId)) ?? null,
      latestRound: latestRoundByApp.get(String(application._id)) ?? null,
    })),
  }
}

export async function updateJobStatus(
  ctx: MembershipContext,
  jobId: string,
  input: {
    status: IHireJob['status']
    expectedStatus: IHireJob['status']
    operationId: string
    closeNote?: string
  }
): Promise<IHireJob> {
  await connectDB()
  assertJobStatusTransition(input.expectedStatus, input.status)
  const closeNote = input.closeNote?.trim()
  if (input.status === 'closed' && !closeNote) {
    throw new AppError('A decision note is required when closing a job', 400, 'CLOSE_NOTE_REQUIRED')
  }

  let runtimeRoundIds: string[] = []
  const updatedJob = await withHireTransaction(ctx, async (session) => {
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
    if (applications.length === 0) return job

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
    return job
  })
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

  return withHireTransaction(ctx, async (session) => {
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
    if (moved) return moved

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
}

export interface ApplicationDetail {
  application: IHireApplication
  candidate: IHireCandidate
  job: IHireJob
  rounds: IHireRound[]
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

  const [candidate, job, rounds] = await Promise.all([
    HireCandidate.findOne({ _id: application.candidateId, workspaceId: ctx.workspace._id }),
    HireJob.findOne({ _id: application.jobId, workspaceId: ctx.workspace._id }),
    HireRound.find({ workspaceId: ctx.workspace._id, applicationId: application._id }).sort({
      createdAt: -1,
    }),
  ])
  if (!candidate || !job) throw new NotFoundError('Application')
  return { application, candidate, job, rounds }
}

/** Append an event to an application — used by round send/revoke/link flows. */
export async function appendApplicationEvent(
  workspaceId: mongoose.Types.ObjectId | string,
  applicationId: mongoose.Types.ObjectId | string,
  event: {
    type: 'ai_round_sent' | 'ai_round_revoked' | 'ai_result_linked'
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
