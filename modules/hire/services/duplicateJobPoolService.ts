import mongoose from 'mongoose'
import { NotFoundError } from '@shared/errors'
import {
  HireApplication,
  HireCandidate,
  HireJob,
  HirePrivacyRequest,
  TERMINAL_STAGES,
  type HireStage,
  type IHireStructuredRequirement,
} from '../models'
import { HireJobRequirementVersion } from '../models/HireJobRequirementVersion'
import { connectHireControlDB } from './hireControlBoundary'
import type { MembershipContext } from './workspaceService'

const OBJECT_ID = /^[a-f0-9]{24}$/i
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
  const [applications, activePrivacyRequests] = await Promise.all([
    HireApplication.find({
      workspaceId: ctx.workspace._id,
      candidateId: { $in: candidateIds },
    })
      .select('_id candidateId jobId stage updatedAt')
      .sort({ updatedAt: -1, _id: 1 })
      .lean() as Promise<ApplicationRow[]>,
    HirePrivacyRequest.find({
      workspaceId: ctx.workspace._id,
      candidateId: { $in: candidateIds },
      live: true,
      status: { $in: ['pending_verification', 'processing'] },
    })
      .select('candidateId')
      .lean(),
  ])

  const privacyPendingCandidateIds = new Set<string>(
    activePrivacyRequests.map((request) => request.candidateId.toString()),
  )
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
    if (privacyPendingCandidateIds.has(candidateId) || !candidate.resumeText) continue
    const candidateApplications = applicationsByCandidate.get(candidateId) ?? []
    // Past-candidate suggestions exclude anyone already present on this job,
    // including a non-terminal card that would otherwise be missed by a
    // terminal-history-only query.
    if (candidateApplications.some((application) => application.jobId.toString() === targetJobId)) {
      continue
    }
    const previouslySeenIn = historicalRoles(
      candidateApplications.filter((application) => TERMINAL_STAGES.includes(application.stage)),
      targetJobId,
      titleByJobId,
    )
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
