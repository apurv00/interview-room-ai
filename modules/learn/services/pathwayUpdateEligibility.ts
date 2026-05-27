import { getShortFormMinAnswers } from '@interview/services/eval/sessionScoringPolicy'

/** Client poll window — retry may reclaim pending jobs stuck longer than this. */
export const PATHWAY_CLIENT_STUCK_MS = 120_000

/** Server-side stale threshold for pending/running pathway jobs. */
export const STALE_PATHWAY_PENDING_MS = 10 * 60 * 1000

export type PathwayUpdateReason =
  | 'insufficient_answers'
  | 'no_scored_feedback'
  | 'planner_disabled'
  | 'pathway_in_flight'
  | 'pathway_failed'
  | 'pathway_succeeded'
  | 'pathway_skipped'
  | 'eligible'

export interface PathwayUpdateEligibilityInput {
  answeredCount: number
  /** Session interview type — lowers min answers for coding / system-design. */
  interviewType?: string
  pathwayPlannerEnabled: boolean
  feedback?: {
    overall_score?: number | null
    degraded?: boolean
    red_flags?: string[] | null
  } | null
  pathwayGenerationStatus?: string | null
  evaluationCount?: number
  /** Set when feedback was not persisted but pathwayJob will synthesize from evals. */
  useSynthesizedFeedback?: boolean
}

export interface PathwayUpdateEligibility {
  reason: PathwayUpdateReason
  canEnqueue: boolean
  poll: boolean
  allowPathwayRetry: boolean
}

const SHORT_FORM_FLAG =
  /at least \d+ answers are required for a scored report/i

function hasScoredFeedback(
  feedback: PathwayUpdateEligibilityInput['feedback'],
  answeredCount: number,
  minAnswers: number,
): boolean {
  if (!feedback) return false
  if (answeredCount < minAnswers) return false
  const flags = feedback.red_flags ?? []
  if (flags.some((f) => SHORT_FORM_FLAG.test(f))) return false
  if (typeof feedback.overall_score !== 'number') return false
  if (feedback.overall_score === 0 && !feedback.degraded) return false
  return true
}

function hasDegradedPathwayInput(
  feedback: PathwayUpdateEligibilityInput['feedback'],
  evaluationCount: number,
  answeredCount: number,
  minAnswers: number,
): boolean {
  return (
    answeredCount >= minAnswers &&
    evaluationCount > 0 &&
    feedback?.degraded === true
  )
}

export function getPathwayUpdateEligibility(
  input: PathwayUpdateEligibilityInput,
): PathwayUpdateEligibility {
  const answeredCount = Math.max(0, Number(input.answeredCount) || 0)
  const evaluationCount = Math.max(0, Number(input.evaluationCount) ?? 0)
  const status = input.pathwayGenerationStatus ?? null
  const minAnswers = getShortFormMinAnswers(input.interviewType)

  if (!input.pathwayPlannerEnabled) {
    return {
      reason: 'planner_disabled',
      canEnqueue: false,
      poll: false,
      allowPathwayRetry: false,
    }
  }

  if (answeredCount < minAnswers) {
    return {
      reason: 'insufficient_answers',
      canEnqueue: false,
      poll: false,
      allowPathwayRetry: false,
    }
  }

  // In-flight jobs must win over the no-feedback guard — degraded/outer-catch
  // paths enqueue with useSynthesizedFeedback and no persisted session.feedback.
  if (status === 'pending' || status === 'running') {
    return {
      reason: 'pathway_in_flight',
      canEnqueue: false,
      poll: true,
      allowPathwayRetry: true,
    }
  }

  const hasPathwayInput =
    hasScoredFeedback(input.feedback, answeredCount, minAnswers) ||
    hasDegradedPathwayInput(input.feedback, evaluationCount, answeredCount, minAnswers) ||
    (input.useSynthesizedFeedback === true && evaluationCount > 0)

  if (!hasPathwayInput) {
    return {
      reason: 'no_scored_feedback',
      canEnqueue: false,
      poll: false,
      allowPathwayRetry: false,
    }
  }

  if (status === 'failed') {
    return {
      reason: 'pathway_failed',
      canEnqueue: false,
      poll: false,
      allowPathwayRetry: true,
    }
  }

  if (status === 'succeeded') {
    return {
      reason: 'pathway_succeeded',
      canEnqueue: false,
      poll: false,
      allowPathwayRetry: false,
    }
  }

  if (status === 'skipped') {
    return {
      reason: 'pathway_skipped',
      canEnqueue: false,
      poll: false,
      allowPathwayRetry: false,
    }
  }

  return {
    reason: 'eligible',
    canEnqueue: true,
    poll: false,
    allowPathwayRetry: false,
  }
}

/**
 * Whether a pending/running pathway job is stale. Pending uses
 * pathwayGenerationStartedAt when set (retry claim / worker pickup) so a
 * fresh retry on an old interview is not immediately treated as failed.
 */
export function isStalePathwayGeneration(
  status: string | undefined,
  completedAt?: Date | string | null,
  startedAt?: Date | string | null,
): boolean {
  const cutoff = Date.now() - STALE_PATHWAY_PENDING_MS
  if (status === 'pending') {
    if (startedAt) {
      return new Date(startedAt).getTime() <= cutoff
    }
    if (completedAt) {
      return new Date(completedAt).getTime() <= cutoff
    }
    return false
  }
  if (status === 'running' && startedAt) {
    return new Date(startedAt).getTime() <= cutoff
  }
  return false
}

/**
 * Mongo filter for atomic pathway retry claims. Unstarted pending rows
 * (no pathwayGenerationStartedAt) only match when completedAt is stale —
 * fresh enqueues set pending without startedAt and must not be claimable.
 */
export function buildRetryablePathwayStatusFilter(): Record<string, unknown> {
  const cutoff = new Date(Date.now() - STALE_PATHWAY_PENDING_MS)
  const clientCutoff = new Date(Date.now() - PATHWAY_CLIENT_STUCK_MS)
  const unstartedStartedAt = {
    $or: [
      { pathwayGenerationStartedAt: { $exists: false } },
      { pathwayGenerationStartedAt: null },
    ],
  }
  return {
    $or: [
      { pathwayGenerationStatus: 'failed' },
      { pathwayGenerationStatus: { $exists: false } },
      { pathwayGenerationStatus: null },
      {
        pathwayGenerationStatus: 'pending',
        pathwayGenerationAttempts: { $in: [0, null] },
        $or: [
          { pathwayGenerationStartedAt: { $lte: cutoff } },
          { $and: [unstartedStartedAt, { completedAt: { $lte: cutoff } }] },
          { $and: [unstartedStartedAt, { completedAt: { $lte: clientCutoff } }] },
        ],
      },
      { pathwayGenerationStatus: 'running', pathwayGenerationStartedAt: { $lte: cutoff } },
    ],
  }
}
