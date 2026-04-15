/**
 * Partial-completion scoring adjustment (Work Item G.10).
 *
 * Problem: pre-G.10, a candidate who answered 2 of 10 planned questions
 * produced the same shape of feedback as a candidate who answered all
 * 10. `overall_score` was an average of however many evaluations
 * existed, divided by that count — so cherry-picking two strong
 * answers scored BETTER than a complete mediocre interview. Candidates
 * who bailed out after a pivot question gamed the score. Worse,
 * `confidence_level` was chosen by Claude with no data-sparsity
 * guidance, so a 2-answer session could read "High" confidence.
 *
 * Fix: using the G.7 session shape (plannedQuestionCount,
 * answeredCount, endReason), apply:
 *   1. Short-form guard: <3 answers → refuse to emit a scored report.
 *      The caller should return overall_score=null with a "complete
 *      at least 3 questions" message; competency/XP writes skip.
 *   2. Completion multiplier: linear taper below a 60% threshold.
 *      At ≥60% completion no penalty. Below 60%, score × ratio
 *      where ratio = answered / (planned * 0.6).
 *   3. Confidence clamp: <50% of planned AND sample <3 → Low.
 *   4. Red_flag describing the end reason so the user understands.
 *
 * Pure and deterministic. Caller is responsible for flag gating; this
 * helper always applies the logic when invoked.
 */

/** Below this ratio we start penalizing the overall_score linearly. */
export const FULL_CREDIT_COMPLETION_RATIO = 0.6

/** Absolute minimum answers before a session can produce a scored report. */
export const SHORT_FORM_MIN_ANSWERS = 3

export type EndReason = 'normal' | 'time_up' | 'user_ended' | 'usage_limit' | 'abandoned'

export interface CompletionInput {
  /** How many questions the session-planner originally budgeted. */
  plannedQuestionCount: number
  /** How many answers actually landed (excluding nothing — raw count). */
  answeredCount: number
  /** How the interview ended. Shapes the user-facing red_flag copy. */
  endReason?: EndReason
}

export interface CompletionAdjustment {
  /**
   * Penalty factor in [0, 1] to multiply overall_score by.
   * 1 = no penalty (≥60% completion), 0 = no score possible.
   */
  scoreMultiplier: number
  /** True when the sample is too small to produce a scored report. */
  shouldReturnShortForm: boolean
  /** Recommended confidence_level clamp, or null if no clamp is needed. */
  clampConfidenceTo: 'Low' | null
  /** User-facing red_flag strings to push. May be empty. */
  redFlags: string[]
  /** Ratio of answered / planned, rounded to 2 decimals. */
  completionRatio: number
}

/**
 * Compute the completion-based adjustments. Pure — zero I/O, zero side
 * effects. Caller applies the outputs to the feedback object.
 */
export function computeCompletionAdjustment(input: CompletionInput): CompletionAdjustment {
  const plannedRaw = Number(input.plannedQuestionCount) || 0
  const answered = Math.max(0, Number(input.answeredCount) || 0)
  // Guard against zero/negative planned counts — if we don't know the
  // budget, we can't apply a ratio, but the short-form guard still
  // fires on raw count.
  const planned = Math.max(0, plannedRaw)
  const endReason: EndReason = input.endReason ?? 'normal'

  const ratioRaw = planned > 0 ? answered / planned : 1
  const completionRatio = Math.round(ratioRaw * 100) / 100

  const shouldReturnShortForm = answered < SHORT_FORM_MIN_ANSWERS

  // Short-form case: score should not be produced. Return early with
  // the signal the caller uses to skip scoring entirely.
  if (shouldReturnShortForm) {
    return {
      scoreMultiplier: 0,
      shouldReturnShortForm: true,
      clampConfidenceTo: 'Low',
      redFlags: [
        `Interview ended after ${answered} of ${planned} planned question${planned === 1 ? '' : 's'} — at least ${SHORT_FORM_MIN_ANSWERS} answers are required for a scored report.`,
      ],
      completionRatio,
    }
  }

  // Linear taper: full credit at ≥60% completion, then scale down.
  // If we don't know `planned`, default to no penalty (multiplier=1) —
  // the caller likely has a legacy session without G.7 fields.
  const tapered =
    planned > 0 && ratioRaw < FULL_CREDIT_COMPLETION_RATIO
      ? ratioRaw / FULL_CREDIT_COMPLETION_RATIO
      : 1
  const scoreMultiplier = Math.max(0, Math.min(1, tapered))

  // Confidence clamp — independent of the score penalty. Any time
  // the candidate answered less than half of what was planned,
  // confidence should be Low.
  const clampConfidenceTo: 'Low' | null =
    planned > 0 && ratioRaw < 0.5 ? 'Low' : null

  const redFlags: string[] = []
  if (planned > 0 && answered < planned) {
    redFlags.push(
      buildEndReasonFlag(answered, planned, endReason),
    )
  }

  return {
    scoreMultiplier,
    shouldReturnShortForm: false,
    clampConfidenceTo,
    redFlags,
    completionRatio,
  }
}

/**
 * Produce a user-facing red_flag string describing an early-end.
 * Tone matches the other red_flags the route produces (matter-of-fact,
 * no blame).
 */
function buildEndReasonFlag(
  answered: number,
  planned: number,
  endReason: EndReason,
): string {
  const base = `Interview ended after Q${answered} of ${planned} planned`
  switch (endReason) {
    case 'time_up':
      return `${base} — the timer expired.`
    case 'user_ended':
      return `${base} — candidate ended the session early.`
    case 'usage_limit':
      return `${base} — monthly usage limit reached.`
    case 'abandoned':
      return `${base} — session was abandoned without formal end.`
    case 'normal':
    default:
      return `${base}.`
  }
}
