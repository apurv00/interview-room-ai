import { connectDB } from '@shared/db/connection'
import { AppError, NotFoundError } from '@shared/errors'
import {
  HireApplication,
  HireCandidate,
  HireJob,
  type HireCandidateSource,
  type IHireApplication,
  type IHireCandidate,
  type IHireResumeMatch,
} from '../models'
import type { MembershipContext } from './workspaceService'

/**
 * Phase 2 intake: idempotent candidate + application creation with
 * workspace-scoped email dedupe and the "seen before" signal.
 *
 * Contrast with pipelineService.addCandidate (Phase 1, manual form): that
 * path REJECTS duplicates with 409 because a recruiter typing an email that
 * already exists is a mistake worth surfacing. Bulk upload and the apply
 * page are the opposite — the same person showing up again is EXPECTED and
 * must merge into the existing record, not fail the row.
 *
 * Merge policy (deliberate, keep boring):
 *   - name: existing wins (recruiter-entered names beat parsed ones); filled
 *     only when the existing record has none.
 *   - phone: filled only when missing.
 *   - resumeText/resumeFileName: NEWEST upload wins whenever the intake
 *     carries a resume — a re-uploaded CV is assumed fresher.
 *   - email: immutable here; it IS the identity key.
 */

export interface IntakeInput {
  jobId: string
  name: string
  email: string
  phone?: string
  resumeText?: string
  resumeFileName?: string
  source: Extract<HireCandidateSource, 'bulk_upload' | 'apply_page'>
  /** Resume-vs-JD analysis, when scoring succeeded (advisory). */
  resumeMatch?: IHireResumeMatch
}

export interface SeenBeforeEntry {
  jobId: string
  jobTitle: string
  stage: string
}

export interface IntakeResult {
  candidateId: string
  applicationId: string
  createdCandidate: boolean
  createdApplication: boolean
  /** Other applications of this person in the workspace (dedupe signal). */
  seenBefore: SeenBeforeEntry[]
}

const SOURCE_LABEL: Record<IntakeInput['source'], string> = {
  bulk_upload: 'via bulk resume upload',
  apply_page: 'via public apply page',
}

export async function intakeCandidate(
  ctx: MembershipContext,
  input: IntakeInput,
): Promise<IntakeResult> {
  await connectDB()
  const workspaceId = ctx.workspace._id
  const email = input.email.toLowerCase().trim()
  if (!email) throw new AppError('Candidate email is required', 422, 'NO_EMAIL')

  const job = await HireJob.findOne({ _id: input.jobId, workspaceId })
  if (!job) throw new NotFoundError('Job')
  if (job.status === 'closed') {
    throw new AppError('This job is closed', 409, 'JOB_CLOSED')
  }

  // ── Candidate: find-or-create, race-safe via the unique index ──
  let createdCandidate = false
  let candidate = await HireCandidate.findOne({ workspaceId, email })
  if (!candidate) {
    try {
      candidate = await HireCandidate.create({
        workspaceId,
        name: input.name,
        email,
        phone: input.phone,
        resumeText: input.resumeText,
        resumeFileName: input.resumeFileName,
        source: input.source,
        createdBy: ctx.membership.userId,
      })
      createdCandidate = true
    } catch (err: unknown) {
      // Concurrent intake of the same email (two files of one person in a
      // batch): lose the race gracefully and merge into the winner.
      if (err && typeof err === 'object' && (err as { code?: number }).code === 11000) {
        candidate = await HireCandidate.findOne({ workspaceId, email })
      }
      if (!candidate) throw err
    }
  }
  if (!createdCandidate) {
    applyMerge(candidate, input)
    if (candidate.isModified()) await candidate.save()
  }

  // ── Application: find-or-create on the unique {ws, job, candidate} ──
  let createdApplication = false
  let application = await HireApplication.findOne({
    workspaceId,
    jobId: job._id,
    candidateId: candidate._id,
  })
  if (!application) {
    try {
      application = await HireApplication.create({
        workspaceId,
        jobId: job._id,
        candidateId: candidate._id,
        stage: 'new',
        resumeMatch: input.resumeMatch,
        events: [
          {
            type: 'created',
            actorUserId: ctx.membership.userId,
            actorName: ctx.membership.name || ctx.membership.email,
            note: SOURCE_LABEL[input.source],
            at: new Date(),
          },
        ],
        createdBy: ctx.membership.userId,
      })
      createdApplication = true
    } catch (err: unknown) {
      if (err && typeof err === 'object' && (err as { code?: number }).code === 11000) {
        application = await HireApplication.findOne({
          workspaceId,
          jobId: job._id,
          candidateId: candidate._id,
        })
      }
      if (!application) throw err
    }
  }
  if (!createdApplication && input.resumeMatch) {
    // Re-upload refreshes the score (same jdHash discipline as create).
    application.resumeMatch = input.resumeMatch
    await application.save()
  }

  return {
    candidateId: candidate._id.toString(),
    applicationId: application._id.toString(),
    createdCandidate,
    createdApplication,
    seenBefore: await seenBeforeForCandidate(ctx, candidate, application),
  }
}

function applyMerge(candidate: IHireCandidate, input: IntakeInput): void {
  if (!candidate.name && input.name) candidate.name = input.name
  if (!candidate.phone && input.phone) candidate.phone = input.phone
  if (input.resumeText) {
    candidate.resumeText = input.resumeText
    candidate.resumeFileName = input.resumeFileName
  }
}

/** Everywhere else this person already is in the workspace, with job names. */
async function seenBeforeForCandidate(
  ctx: MembershipContext,
  candidate: IHireCandidate,
  currentApplication: IHireApplication,
): Promise<SeenBeforeEntry[]> {
  const others = await HireApplication.find({
    workspaceId: ctx.workspace._id,
    candidateId: candidate._id,
    _id: { $ne: currentApplication._id },
  })
    .sort({ createdAt: -1 })
    .limit(10)
  if (others.length === 0) return []
  const jobs = await HireJob.find({
    workspaceId: ctx.workspace._id,
    _id: { $in: others.map((a) => a.jobId) },
  }).select('title')
  const titleById = new Map(jobs.map((j) => [j._id.toString(), j.title]))
  return others.map((a) => ({
    jobId: a.jobId.toString(),
    jobTitle: titleById.get(a.jobId.toString()) ?? 'Unknown job',
    stage: a.stage,
  }))
}
