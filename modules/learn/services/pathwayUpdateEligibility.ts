import { SHORT_FORM_MIN_ANSWERS } from '@interview/services/eval/completionAdjustment'

/** Client poll window — retry may reclaim pending jobs stuck longer than this. */
export const PATHWAY_CLIENT_STUCK_MS = 120_000

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
  pathwayPlannerEnabled: boolean
  feedback?: {
    overall_score?: number | null
    degraded?: boolean
    red_flags?: string[] | null
  } | null
  pathwayGenerationStatus?: string | null
  evaluationCount?: number
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
): boolean {
  if (!feedback) return false
  if (answeredCount < SHORT_FORM_MIN_ANSWERS) return false
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
): boolean {
  return (
    answeredCount >= SHORT_FORM_MIN_ANSWERS &&
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

  if (!input.pathwayPlannerEnabled) {
    return {
      reason: 'planner_disabled',
      canEnqueue: false,
      poll: false,
      allowPathwayRetry: false,
    }
  }

  if (answeredCount < SHORT_FORM_MIN_ANSWERS) {
    return {
      reason: 'insufficient_answers',
      canEnqueue: false,
      poll: false,
      allowPathwayRetry: false,
    }
  }

  const scored =
    hasScoredFeedback(input.feedback, answeredCount) ||
    hasDegradedPathwayInput(input.feedback, evaluationCount, answeredCount)

  if (!scored) {
    return {
      reason: 'no_scored_feedback',
      canEnqueue: false,
      poll: false,
      allowPathwayRetry: false,
    }
  }

  if (status === 'pending' || status === 'running') {
    return {
      reason: 'pathway_in_flight',
      canEnqueue: false,
      poll: true,
      allowPathwayRetry: true,
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
