import mongoose, { type ClientSession } from 'mongoose'
import { AppError, NotFoundError } from '@shared/errors'
import {
  HireApplication,
  HireCandidate,
  HireEmailOutbox,
  HireJob,
  HirePrivacyRequest,
  TERMINAL_STAGES,
  type HireCandidateProvenanceSource,
  type HireStage,
  type IHireStructuredRequirement,
} from '../models'
import { HireJobRequirementVersion } from '../models/HireJobRequirementVersion'
import { HireReengagementOptOut } from '../models/HireReengagementOptOut'
import {
  claimHireCandidatePiiWriteFence,
  HireCandidatePiiTombstoneError,
} from './hireCandidatePrivacyWriteFence'
import { connectHireControlDB } from './hireControlBoundary'
import { withActiveHireWorkspaceWriteTransaction } from './hireWorkspaceWriteFence'
import type { MembershipContext } from './workspaceService'

const OBJECT_ID = /^[a-f0-9]{24}$/i
const OPERATION_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
const MAX_POOL_SUGGESTIONS = 25
const MAX_POOL_CANDIDATES_TO_SCAN = 1_000
const MAX_PREVIOUS_ROLES = 3

const STOP_WORDS = new Set([
  'about', 'after', 'also', 'and', 'are', 'been', 'being', 'with', 'that',
  'this', 'from', 'have', 'into', 'will', 'your', 'you', 'the', 'for', 'our',
  'role', 'years', 'year', 'work', 'team', 'skills', 'experience', 'using',
])

export interface PoolSuggestion {
  candidate: {
    id: string
    name: string
    email: string
  }
  /** Deterministic requirement-overlap score; not an AI decision. */
  matchScore: number
  matchedRequirements: string[]
  previouslySeenIn: Array<{
    jobId: string
    jobTitle: string
    stage: HireStage
  }>
}

export type ReengagePoolCandidateStatus =
  | 'queued'
  | 'already_considered'
  | 'already_decided'
  | 'opted_out'
  | 'privacy_pending'

export interface ReengagePoolCandidateResult {
  status: ReengagePoolCandidateStatus
  candidateId: string
  applicationId?: string
}

interface CandidateRow {
  _id: mongoose.Types.ObjectId
  name: string
  email: string
  resumeText?: string
}

interface ApplicationRow {
  _id: mongoose.Types.ObjectId
  candidateId: mongoose.Types.ObjectId
  jobId: mongoose.Types.ObjectId
  stage: HireStage
  updatedAt?: Date
}

function actorName(ctx: MembershipContext): string {
  return ctx.membership.name || ctx.membership.email
}

function hasObjectId(value: string): boolean {
  return OBJECT_ID.test(value)
}

function normalizeTokens(value: string): Set<string> {
  return new Set(
    value
      .toLocaleLowerCase('en-US')
      .match(/[a-z0-9+#.]{3,}/g)
      ?.map((token) => token.replace(/[.#]+$/g, ''))
      .filter((token) => token.length >= 3 && !STOP_WORDS.has(token)) ?? [],
  )
}

function scoreCandidateAgainstRequirements(
  resumeText: string,
  requirements: IHireStructuredRequirement[],
): Pick<PoolSuggestion, 'matchScore' | 'matchedRequirements'> {
  const resumeTokens = normalizeTokens(resumeText)
  let possibleWeight = 0
  let matchedWeight = 0
  const matchedRequirements: string[] = []

  for (const requirement of requirements) {
    const requirementTokens = normalizeTokens(requirement.text)
    if (requirementTokens.size === 0) continue
    const weight = requirement.importance === 'must_have' ? 2 : 1
    possibleWeight += weight
    if (Array.from(requirementTokens).some((token) => resumeTokens.has(token))) {
      matchedWeight += weight
      if (matchedRequirements.length < 3) matchedRequirements.push(requirement.text)
    }
  }

  return {
    matchScore: possibleWeight === 0 ? 0 : Math.round((matchedWeight / possibleWeight) * 100),
    matchedRequirements,
  }
}

function historicalRoles(
  applicationRows: ApplicationRow[],
  targetJobId: string,
  titleByJobId: Map<string, string>,
): PoolSuggestion['previouslySeenIn'] {
  const byJob = new Map<string, ApplicationRow>()
  for (const application of applicationRows) {
    const jobId = application.jobId.toString()
    if (jobId === targetJobId || byJob.has(jobId)) continue
    byJob.set(jobId, application)
  }
  return Array.from(byJob.entries())
    .sort(([, left], [, right]) => {
      const rightTime = right.updatedAt?.getTime() ?? 0
      const leftTime = left.updatedAt?.getTime() ?? 0
      return rightTime - leftTime || left._id.toString().localeCompare(right._id.toString())
    })
    .slice(0, MAX_PREVIOUS_ROLES)
    .map(([jobId, application]) => ({
      jobId,
      jobTitle: titleByJobId.get(jobId) ?? 'Previous role',
      stage: application.stage,
    }))
}

/**
 * Read-only, workspace-scoped past-candidate suggestions. Candidate resume
 * text is used transiently for deterministic requirement overlap and is
 * never returned to the browser or written to a match artifact.
 */
export async function listJobPoolSuggestions(
  ctx: MembershipContext,
  jobId: string,
): Promise<PoolSuggestion[]> {
  if (!hasObjectId(jobId)) throw new NotFoundError('Job')
  await connectHireControlDB()

  const job = await HireJob.findOne({
    _id: jobId,
    workspaceId: ctx.workspace._id,
  })
    .select('_id activeRequirementVersionId status')
    .lean()
  if (!job) throw new NotFoundError('Job')
  if (!job.activeRequirementVersionId) return []

  const requirementVersion = await HireJobRequirementVersion.findOne({
    _id: job.activeRequirementVersionId,
    workspaceId: ctx.workspace._id,
    jobId: job._id,
    state: 'active',
  })
    .select('requirements')
    .lean()
  if (!requirementVersion?.requirements?.length) return []

  const candidates = (await HireCandidate.find({
    workspaceId: ctx.workspace._id,
    piiAnonymizedAt: { $exists: false },
    resumeText: { $type: 'string', $ne: '' },
  })
    .select('_id name email resumeText')
    .sort({ updatedAt: -1, _id: 1 })
    .limit(MAX_POOL_CANDIDATES_TO_SCAN)
    .lean()) as CandidateRow[]
  if (candidates.length === 0) return []

  const candidateIds = candidates.map((candidate) => candidate._id)
  const [applications, optOuts, activePrivacyRequests] = await Promise.all([
    HireApplication.find({
      workspaceId: ctx.workspace._id,
      candidateId: { $in: candidateIds },
      // A talent-pool re-engagement is for a past consideration, never a
      // side door into another role where the candidate is still active.
      stage: { $in: TERMINAL_STAGES },
    })
      .select('_id candidateId jobId stage updatedAt')
      .sort({ updatedAt: -1, _id: 1 })
      .lean() as Promise<ApplicationRow[]>,
    HireReengagementOptOut.find({
      workspaceId: ctx.workspace._id,
      candidateId: { $in: candidateIds },
    })
      .select('candidateId')
      .lean(),
    HirePrivacyRequest.find({
      workspaceId: ctx.workspace._id,
      candidateId: { $in: candidateIds },
      live: true,
      status: { $in: ['pending_verification', 'processing'] },
    })
      .select('candidateId')
      .lean(),
  ])

  const excludedCandidateIds = new Set<string>([
    ...optOuts.map((record) => record.candidateId.toString()),
    ...activePrivacyRequests.map((request) => request.candidateId.toString()),
  ])
  const applicationsByCandidate = new Map<string, ApplicationRow[]>()
  const referencedJobIds = new Set<string>()
  for (const application of applications) {
    const candidateId = application.candidateId.toString()
    const current = applicationsByCandidate.get(candidateId) ?? []
    current.push(application)
    applicationsByCandidate.set(candidateId, current)
    referencedJobIds.add(application.jobId.toString())
  }

  const relatedJobs = await HireJob.find({
    workspaceId: ctx.workspace._id,
    _id: { $in: Array.from(referencedJobIds) },
  })
    .select('_id title')
    .lean()
  const titleByJobId = new Map(
    relatedJobs.map((relatedJob) => [relatedJob._id.toString(), relatedJob.title]),
  )
  const targetJobId = job._id.toString()
  const suggestions: PoolSuggestion[] = []

  for (const candidate of candidates) {
    const candidateId = candidate._id.toString()
    if (excludedCandidateIds.has(candidateId) || !candidate.resumeText) continue
    const candidateApplications = applicationsByCandidate.get(candidateId) ?? []
    // Past-candidate suggestions exclude anyone already present on this job,
    // including a terminal record a recruiter must explicitly reinstate.
    if (candidateApplications.some((application) => application.jobId.toString() === targetJobId)) {
      continue
    }
    const previouslySeenIn = historicalRoles(candidateApplications, targetJobId, titleByJobId)
    if (previouslySeenIn.length === 0) continue

    const match = scoreCandidateAgainstRequirements(
      candidate.resumeText,
      requirementVersion.requirements,
    )
    if (match.matchScore === 0) continue
    suggestions.push({
      candidate: {
        id: candidateId,
        name: candidate.name,
        email: candidate.email,
      },
      ...match,
      previouslySeenIn,
    })
  }

  return suggestions
    .sort((left, right) =>
      right.matchScore - left.matchScore ||
      right.matchedRequirements.length - left.matchedRequirements.length ||
      left.candidate.id.localeCompare(right.candidate.id),
    )
    .slice(0, MAX_POOL_SUGGESTIONS)
}

function existingApplicationResult(application: {
  _id: mongoose.Types.ObjectId
  stage: HireStage
  events?: Array<{ operationId?: string }>
}, operationId: string): ReengagePoolCandidateResult {
  if (TERMINAL_STAGES.includes(application.stage)) {
    return { status: 'already_decided', candidateId: '', applicationId: application._id.toString() }
  }
  return {
    // If this exact idempotent command won a race, acknowledge it as queued;
    // otherwise make clear that it was already a current consideration.
    status: application.events?.some((event) => event.operationId === operationId)
      ? 'queued'
      : 'already_considered',
    candidateId: '',
    applicationId: application._id.toString(),
  }
}

async function reengagePoolCandidateOnce(
  ctx: MembershipContext,
  jobId: string,
  candidateId: string,
  operationId: string,
  now: Date,
): Promise<ReengagePoolCandidateResult> {
  return withActiveHireWorkspaceWriteTransaction(
    ctx.workspace._id,
    ctx.membership._id,
    async (session: ClientSession) => {
      const job = await HireJob.findOne({
        _id: jobId,
        workspaceId: ctx.workspace._id,
      }).session(session)
      if (!job) throw new NotFoundError('Job')
      if (job.status !== 'open') {
        throw new AppError('This job is no longer open', 409, 'JOB_NOT_OPEN')
      }

      const candidate = await HireCandidate.findOne({
        _id: candidateId,
        workspaceId: ctx.workspace._id,
        piiAnonymizedAt: { $exists: false },
      }).session(session)
      if (!candidate) throw new NotFoundError('Candidate')

      const existing = await HireApplication.findOne({
        workspaceId: ctx.workspace._id,
        jobId: job._id,
        candidateId: candidate._id,
      }).session(session)
      if (existing) {
        return {
          ...existingApplicationResult(existing, operationId),
          candidateId: candidate._id.toString(),
        }
      }

      // Transaction sessions must be used serially. The privacy check also
      // ensures we never create a fresh application while deletion is live.
      const optedOut = await HireReengagementOptOut.exists({
        workspaceId: ctx.workspace._id,
        candidateId: candidate._id,
      }).session(session)
      const privacyPending = await HirePrivacyRequest.exists({
        workspaceId: ctx.workspace._id,
        candidateId: candidate._id,
        live: true,
        status: { $in: ['pending_verification', 'processing'] },
      }).session(session)
      const hasPastApplication = await HireApplication.exists({
        workspaceId: ctx.workspace._id,
        candidateId: candidate._id,
        jobId: { $ne: job._id },
        stage: { $in: TERMINAL_STAGES },
      }).session(session)
      if (optedOut) return { status: 'opted_out', candidateId: candidate._id.toString() }
      if (privacyPending) return { status: 'privacy_pending', candidateId: candidate._id.toString() }
      if (!hasPastApplication) {
        throw new AppError(
          'Only a previously considered workspace candidate can be re-engaged',
          409,
          'POOL_HISTORY_REQUIRED',
        )
      }

      // Make job closure conflict with this intake before we create either
      // an application or a re-engagement email outbox row.
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
            'Candidate personal data has been deleted and cannot be re-engaged',
            409,
            'CANDIDATE_DATA_DELETED',
          )
        }
        throw error
      }

      const sourceHistory = new Set<HireCandidateProvenanceSource>(candidate.sourceHistory ?? [])
      const sourceAdditions = [candidate.source ?? 'manual', 'pool'].filter(
        (source): source is HireCandidateProvenanceSource => !sourceHistory.has(source as HireCandidateProvenanceSource),
      )
      if (sourceAdditions.length > 0) {
        const provenance = await HireCandidate.updateOne(
          {
            _id: candidate._id,
            workspaceId: ctx.workspace._id,
            piiAnonymizedAt: { $exists: false },
          },
          { $addToSet: { sourceHistory: { $each: sourceAdditions } } },
          { session, runValidators: true },
        )
        if (provenance.matchedCount !== 1) {
          throw new AppError(
            'Candidate changed while recording talent-pool provenance; retry the request',
            409,
            'CANDIDATE_POOL_RACE',
          )
        }
      }

      const applications = await HireApplication.create(
        [
          {
            workspaceId: ctx.workspace._id,
            jobId: job._id,
            candidateId: candidate._id,
            stage: 'new',
            events: [
              {
                type: 'created',
                actorMemberId: ctx.membership._id,
                actorName: actorName(ctx),
                note: 'Added from the talent pool; re-engagement email queued',
                operationId,
                at: now,
              },
            ],
            createdByMemberId: ctx.membership._id,
            createdByName: actorName(ctx),
          },
        ],
        { session },
      )
      const application = applications[0]
      await HireEmailOutbox.create(
        [
          {
            workspaceId: ctx.workspace._id,
            jobId: job._id,
            applicationId: application._id,
            candidateId: candidate._id,
            kind: 'job_reengagement',
            operationId,
            recipientEmail: candidate.email,
            recipientName: candidate.name,
            payload: {
              jobTitle: job.title,
              workspaceName: ctx.workspace.name,
              // Required legacy audit shape; not sent by the re-engagement
              // template and deliberately contains no private assessment.
              decisionNote: 'Talent-pool re-engagement',
              actorName: actorName(ctx),
            },
            status: 'pending',
            sendAfter: now,
            attempts: 0,
            manualRetryCount: 0,
          },
        ],
        { session },
      )
      return {
        status: 'queued',
        candidateId: candidate._id.toString(),
        applicationId: application._id.toString(),
      }
    },
  )
}

function hasDuplicateKeyError(error: unknown): boolean {
  return Boolean(error && typeof error === 'object' && (error as { code?: number }).code === 11000)
}

/**
 * HR's explicit confirmation boundary. The duplicate job remains empty until
 * this operation succeeds; this function never runs while listing matches.
 */
export async function reengagePoolCandidate(
  ctx: MembershipContext,
  jobId: string,
  input: { candidateId: string; operationId: string; now?: Date },
): Promise<ReengagePoolCandidateResult> {
  if (!hasObjectId(jobId)) throw new NotFoundError('Job')
  if (!hasObjectId(input.candidateId)) throw new NotFoundError('Candidate')
  if (!OPERATION_ID.test(input.operationId)) {
    throw new AppError('Invalid operation id', 400, 'INVALID_OPERATION_ID')
  }
  await connectHireControlDB()
  const now = input.now ?? new Date()
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      return await reengagePoolCandidateOnce(
        ctx,
        jobId,
        input.candidateId,
        input.operationId,
        now,
      )
    } catch (error) {
      if (attempt === 0 && hasDuplicateKeyError(error)) continue
      throw error
    }
  }
  throw new AppError('Could not re-engage this candidate; retry the request', 409, 'CANDIDATE_POOL_RACE')
}
