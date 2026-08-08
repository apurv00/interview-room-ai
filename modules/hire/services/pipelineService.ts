import mongoose from 'mongoose'
import { connectDB } from '@shared/db/connection'
import { AppError, ForbiddenError, NotFoundError } from '@shared/errors'
import {
  HireApplication,
  HireCandidate,
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
import type { MembershipContext } from './workspaceService'

/**
 * Jobs, candidates, applications, and the fixed pipeline. Every query in this
 * file threads ctx.workspace._id — the cross-tenant isolation suite asserts
 * exactly that on each function. Stage moves are explicit member actions with
 * actor + timestamp recorded; nothing here moves a card automatically.
 */

function actorName(ctx: MembershipContext): string {
  return ctx.membership.name || ctx.membership.email
}

// ─── Jobs ─────────────────────────────────────────────────────────────────────

export async function createJob(
  ctx: MembershipContext,
  input: { title: string; jdText: string }
): Promise<IHireJob> {
  await connectDB()
  return HireJob.create({
    workspaceId: ctx.workspace._id,
    title: input.title,
    jdText: input.jdText,
    status: 'open',
    createdBy: ctx.membership.userId,
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
  input: { status: IHireJob['status']; closeNote?: string }
): Promise<IHireJob> {
  await connectDB()
  const update: Record<string, unknown> = { status: input.status }
  if (input.status === 'closed') {
    if (!input.closeNote) {
      throw new AppError('A decision note is required when closing a job', 400, 'CLOSE_NOTE_REQUIRED')
    }
    update.closeNote = input.closeNote
    update.closedAt = new Date()
    update.closedBy = ctx.membership.userId
  }
  const job = await HireJob.findOneAndUpdate(
    { _id: jobId, workspaceId: ctx.workspace._id },
    { $set: update },
    { new: true }
  )
  if (!job) throw new NotFoundError('Job')
  return job
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
    return await HireCandidate.create({
      workspaceId: ctx.workspace._id,
      name: input.name,
      email: input.email.toLowerCase(),
      phone: input.phone,
      resumeText: input.resumeText,
      resumeFileName: input.resumeFileName,
      source: 'manual',
      createdBy: ctx.membership.userId,
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
  if (job.status === 'closed') {
    throw new AppError('This job is closed', 409, 'JOB_CLOSED')
  }

  try {
    return await HireApplication.create({
      workspaceId: ctx.workspace._id,
      jobId: job._id,
      candidateId: candidate._id,
      stage: 'new',
      events: [
        {
          type: 'created',
          actorUserId: ctx.membership.userId,
          actorName: actorName(ctx),
          at: new Date(),
        },
      ],
      createdBy: ctx.membership.userId,
    })
  } catch (err: unknown) {
    if (err && typeof err === 'object' && (err as { code?: number }).code === 11000) {
      throw new AppError('This candidate is already on this job', 409, 'APPLICATION_EXISTS')
    }
    throw err
  }
}

export interface StageMoveInput {
  action: 'advance' | 'reject'
  note?: string
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

  const from = application.stage
  if (TERMINAL_STAGES.includes(from)) {
    throw new AppError('This application is already decided', 409, 'STAGE_TERMINAL')
  }

  let to: HireStage
  if (input.action === 'reject') {
    to = 'rejected'
  } else {
    const idx = HIRE_STAGES.indexOf(from)
    to = HIRE_STAGES[idx + 1]
    if (!to || to === 'rejected') {
      throw new AppError('Cannot advance from this stage', 409, 'CANNOT_ADVANCE')
    }
  }
  if (to === 'hired' && !input.note) {
    throw new AppError(
      'A decision note is required when marking a candidate Hired',
      400,
      'DECISION_NOTE_REQUIRED'
    )
  }

  const update: Record<string, unknown> = { stage: to }
  if (to === 'hired') update.decisionNote = input.note

  const moved = await HireApplication.findOneAndUpdate(
    { _id: application._id, workspaceId: ctx.workspace._id, stage: from },
    {
      $set: update,
      $push: {
        events: {
          type: 'stage_move',
          from,
          to,
          actorUserId: ctx.membership.userId,
          actorName: actorName(ctx),
          note: input.note,
          at: new Date(),
        },
      },
    },
    { new: true }
  )
  if (!moved) {
    throw new AppError('The stage changed underneath you — refresh and retry', 409, 'STAGE_RACE')
  }
  return moved
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
    actorName: string
    note?: string
  }
): Promise<void> {
  await connectDB()
  await HireApplication.updateOne(
    { _id: applicationId, workspaceId },
    { $push: { events: { ...event, at: new Date() } } }
  )
}
