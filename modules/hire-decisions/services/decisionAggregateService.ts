import mongoose from 'mongoose'
import {
  HireApplication,
  HireCandidate,
  HireHumanScorecard,
  HireInterviewResult,
  HireJob,
} from '@hire-decision-boundary'
import { HireExternalVerdict } from '../models/HireExternalVerdict'
import {
  HIRE_DECISION_DIMENSIONS,
  HIRE_EXTERNAL_VERDICT_RECOMMENDATIONS,
  HIRE_SHARE_PACKET_SECTIONS,
  type HireDecisionAiAssessment,
  type HireDecisionDimensionAggregate,
  type HireDecisionDimensionKey,
  type HireDecisionView,
  type HireExternalVerdictAggregate,
  type HireExternalVerdictRecommendation,
  type HireHumanDecisionSourceAggregate,
  type HireHumanScorecardAggregate,
  type HireRecommendationTally,
  type HireSharePacketSection,
  type HireSharePacketSnapshot,
} from '../types'
import { connectHireDecisionDB } from './hireDecisionBoundary'

export const HIRE_DECISION_MAX_AI_ASSESSMENTS = 32

export class HireDecisionError extends Error {
  constructor(
    message: string,
    readonly code: 'DECISION_INVALID_SCOPE' | 'DECISION_SCOPE_NOT_FOUND' | 'DECISION_INVALID_SECTIONS',
    readonly status: 400 | 404,
  ) {
    super(message)
    this.name = 'HireDecisionError'
  }
}

/** Minimal, persistence-free input accepted by the pure human aggregation helper. */
export interface HireHumanScorecardAggregateInput {
  status: string
  reviewerKind: 'member' | 'kit'
  recommendation?: string
  dimensions?: Array<{ key: string; rating: number }>
}

/** Minimal, persistence-free input accepted by the pure external-verdict tally helper. */
export interface HireExternalVerdictAggregateInput {
  recommendation: string
}

function emptyRecommendationTally(): HireRecommendationTally {
  return {
    strong_yes: 0,
    yes: 0,
    no: 0,
    strong_no: 0,
  }
}

function isRecommendation(value: unknown): value is HireExternalVerdictRecommendation {
  return (
    typeof value === 'string' &&
    HIRE_EXTERNAL_VERDICT_RECOMMENDATIONS.includes(value as HireExternalVerdictRecommendation)
  )
}

function emptyDimensionAggregate(key: HireDecisionDimensionKey): HireDecisionDimensionAggregate {
  return { key, count: 0, mean: null, min: null, max: null, reviewerSpread: null }
}

function isDimensionKey(value: unknown): value is HireDecisionDimensionKey {
  return (
    typeof value === 'string' &&
    HIRE_DECISION_DIMENSIONS.includes(value as HireDecisionDimensionKey)
  )
}

function isRubricRating(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 1 && value <= 5
}

function aggregateHumanSource(
  scorecards: readonly HireHumanScorecardAggregateInput[],
): HireHumanDecisionSourceAggregate {
  const recommendations = emptyRecommendationTally()
  const ratings = new Map<HireDecisionDimensionKey, number[]>(
    HIRE_DECISION_DIMENSIONS.map((key) => [key, []]),
  )
  let count = 0

  for (const scorecard of scorecards) {
    // A draft/cancelled card is intentionally invisible to every aggregate,
    // even when it happens to carry stale values from a malformed legacy row.
    if (scorecard.status !== 'submitted') continue
    count += 1
    if (isRecommendation(scorecard.recommendation)) {
      recommendations[scorecard.recommendation] += 1
    }

    // A canonical Phase-3 scorecard has each key exactly once. Be defensive
    // on read: malformed duplicate keys cannot inflate its reviewer weight.
    const observed = new Set<HireDecisionDimensionKey>()
    for (const dimension of scorecard.dimensions ?? []) {
      if (
        !isDimensionKey(dimension.key) ||
        observed.has(dimension.key) ||
        !isRubricRating(dimension.rating)
      ) {
        continue
      }
      observed.add(dimension.key)
      ratings.get(dimension.key)?.push(dimension.rating)
    }
  }

  const dimensions = HIRE_DECISION_DIMENSIONS.map((key) => {
    const values = ratings.get(key) ?? []
    if (values.length === 0) return emptyDimensionAggregate(key)
    const min = Math.min(...values)
    const max = Math.max(...values)
    return {
      key,
      count: values.length,
      mean: values.reduce((sum, value) => sum + value, 0) / values.length,
      min,
      max,
      reviewerSpread: max - min,
    }
  })

  return { count, recommendations, dimensions }
}

/**
 * Aggregate only submitted Phase-3 human scorecards. This returns source
 * distributions, not a weighted recommendation or a stage instruction.
 */
export function aggregateSubmittedHumanScorecards(
  scorecards: readonly HireHumanScorecardAggregateInput[],
): HireHumanScorecardAggregate {
  const submitted = scorecards.filter((scorecard) => scorecard.status === 'submitted')
  const member = aggregateHumanSource(submitted.filter((scorecard) => scorecard.reviewerKind === 'member'))
  const kit = aggregateHumanSource(submitted.filter((scorecard) => scorecard.reviewerKind === 'kit'))
  const total = aggregateHumanSource(submitted)
  return { total, member, kit }
}

/** External verdicts have no rubric dimensions and never enter a human-scorecard aggregate. */
export function aggregateExternalVerdicts(
  verdicts: readonly HireExternalVerdictAggregateInput[],
): HireExternalVerdictAggregate {
  const recommendations = emptyRecommendationTally()
  for (const verdict of verdicts) {
    if (isRecommendation(verdict.recommendation)) {
      recommendations[verdict.recommendation] += 1
    }
  }
  return { count: verdicts.length, recommendations }
}

function objectId(value: string, label: string): mongoose.Types.ObjectId {
  if (!mongoose.Types.ObjectId.isValid(value)) {
    throw new HireDecisionError(`Invalid ${label}`, 'DECISION_INVALID_SCOPE', 400)
  }
  return new mongoose.Types.ObjectId(value)
}

function safeScore(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 100
    ? value
    : null
}

function safeShortText(value: unknown, maxLength: number): string | undefined {
  if (typeof value !== 'string') return undefined
  const trimmed = value.trim()
  return trimmed.length > 0 && trimmed.length <= maxLength ? trimmed : undefined
}

/**
 * Retain just the display-safe numeric AI projection. Raw engine output,
 * transcript/media references, audit ids, and question/answer text are never
 * included in this decision view or a packet snapshot.
 */
function summarizeAiAssessment(result: {
  completedAt: Date
  numericSummary: {
    overallScore: number | null
    dimensions: Array<{ key: string; score: number | null }>
  }
  projection?: {
    recommendation?: string
    confidence?: string
    dimensions: Array<{ key: string; label: string; score: number | null }>
  }
}): HireDecisionAiAssessment {
  const labels = new Map(
    (result.projection?.dimensions ?? []).map((dimension) => [dimension.key, dimension.label]),
  )
  return {
    completedAt: result.completedAt,
    overallScore: safeScore(result.numericSummary.overallScore),
    ...(safeShortText(result.projection?.recommendation, 120)
      ? { recommendation: safeShortText(result.projection?.recommendation, 120) }
      : {}),
    ...(safeShortText(result.projection?.confidence, 120)
      ? { confidence: safeShortText(result.projection?.confidence, 120) }
      : {}),
    dimensions: result.numericSummary.dimensions.slice(0, 64).flatMap((dimension) => {
      const key = safeShortText(dimension.key, 120)
      if (!key) return []
      const label = safeShortText(labels.get(dimension.key), 160)
      return [
        {
          key,
          ...(label ? { label } : {}),
          score: safeScore(dimension.score),
        },
      ]
    }),
  }
}

/**
 * Build the server-side evidence read model for one Hire application.
 *
 * This function only reads the control database. It does not update an
 * application, calculate a blended score, rank candidates, or move a stage.
 */
export async function buildHireDecisionView(input: {
  workspaceId: string
  applicationId: string
}): Promise<HireDecisionView> {
  const workspaceId = objectId(input.workspaceId, 'workspace id')
  const applicationId = objectId(input.applicationId, 'application id')
  await connectHireDecisionDB()

  const application = await HireApplication.findOne({ _id: applicationId, workspaceId })
  if (!application) {
    throw new HireDecisionError('Application not found', 'DECISION_SCOPE_NOT_FOUND', 404)
  }

  const [candidate, job, scorecards, verdicts, results] = await Promise.all([
    HireCandidate.findOne({
      _id: application.candidateId,
      workspaceId,
      piiAnonymizedAt: { $exists: false },
    }),
    HireJob.findOne({ _id: application.jobId, workspaceId }),
    HireHumanScorecard.find({
      workspaceId,
      applicationId: application._id,
      jobId: application.jobId,
      candidateId: application.candidateId,
      status: 'submitted',
      privacyRedactedAt: { $exists: false },
    }),
    HireExternalVerdict.find({
      workspaceId,
      applicationId: application._id,
      jobId: application.jobId,
      candidateId: application.candidateId,
      privacyRedactedAt: { $exists: false },
    }),
    HireInterviewResult.find({
      workspaceId,
      applicationId: application._id,
      jobId: application.jobId,
      candidateId: application.candidateId,
      piiPurgedAt: { $exists: false },
    })
      .sort({ completedAt: -1 })
      .limit(HIRE_DECISION_MAX_AI_ASSESSMENTS),
  ])

  if (!candidate || !job) {
    throw new HireDecisionError('Application evidence is unavailable', 'DECISION_SCOPE_NOT_FOUND', 404)
  }

  return {
    coordinates: {
      workspaceId: workspaceId.toString(),
      applicationId: application._id.toString(),
      jobId: application.jobId.toString(),
      candidateId: application.candidateId.toString(),
    },
    candidateBrief: {
      candidateName: candidate.name,
      jobTitle: job.title,
      ...(candidate.screeningProfile?.location
        ? { location: candidate.screeningProfile.location }
        : {}),
      ...(candidate.screeningProfile?.experienceYears !== undefined
        ? { experienceYears: candidate.screeningProfile.experienceYears }
        : {}),
    },
    aiAssessments: results.map((result) => summarizeAiAssessment(result)),
    humanScorecards: aggregateSubmittedHumanScorecards(
      scorecards.map((scorecard) => ({
        status: scorecard.status,
        reviewerKind: scorecard.reviewerKind,
        recommendation: scorecard.recommendation,
        dimensions: scorecard.dimensions?.map((dimension) => ({
          key: dimension.key,
          rating: dimension.rating,
        })),
      })),
    ),
    externalVerdicts: aggregateExternalVerdicts(
      verdicts.map((verdict) => ({ recommendation: verdict.recommendation })),
    ),
  }
}

function assertSharePacketSections(
  sections: readonly HireSharePacketSection[],
): HireSharePacketSection[] {
  const canonical = [...sections]
  if (
    canonical.length === 0 ||
    canonical.length > HIRE_SHARE_PACKET_SECTIONS.length ||
    new Set(canonical).size !== canonical.length ||
    canonical.some((section) => !HIRE_SHARE_PACKET_SECTIONS.includes(section))
  ) {
    throw new HireDecisionError(
      'Share-packet sections must be non-empty, unique, and supported',
      'DECISION_INVALID_SECTIONS',
      400,
    )
  }
  return canonical
}

function cloneHumanAggregate(value: HireHumanScorecardAggregate): HireHumanScorecardAggregate {
  const cloneSource = (source: HireHumanDecisionSourceAggregate): HireHumanDecisionSourceAggregate => ({
    count: source.count,
    recommendations: { ...source.recommendations },
    dimensions: source.dimensions.map((dimension) => ({ ...dimension })),
  })
  return {
    total: cloneSource(value.total),
    member: cloneSource(value.member),
    kit: cloneSource(value.kit),
  }
}

/**
 * Produce the immutable, typed allowlist that is copied into a share packet.
 * The source decision view can grow internally without widening a public
 * packet: this function picks only explicitly enabled safe sections.
 */
export function buildSharePacketSnapshot(
  decision: HireDecisionView,
  allowedSections: readonly HireSharePacketSection[],
): HireSharePacketSnapshot {
  const sections = new Set(assertSharePacketSections(allowedSections))
  return {
    version: 1,
    ...(sections.has('candidate_brief')
      ? {
          candidateBrief: {
            candidateName: decision.candidateBrief.candidateName,
            jobTitle: decision.candidateBrief.jobTitle,
            ...(decision.candidateBrief.location ? { location: decision.candidateBrief.location } : {}),
            ...(decision.candidateBrief.experienceYears !== undefined
              ? { experienceYears: decision.candidateBrief.experienceYears }
              : {}),
          },
        }
      : {}),
    ...(sections.has('ai_assessments')
      ? {
          aiAssessments: decision.aiAssessments.map((assessment) => ({
            completedAt: assessment.completedAt,
            overallScore: assessment.overallScore,
            ...(assessment.recommendation ? { recommendation: assessment.recommendation } : {}),
            ...(assessment.confidence ? { confidence: assessment.confidence } : {}),
            dimensions: assessment.dimensions.map((dimension) => ({ ...dimension })),
          })),
        }
      : {}),
    ...(sections.has('human_scorecards')
      ? { humanScorecards: cloneHumanAggregate(decision.humanScorecards) }
      : {}),
  }
}
