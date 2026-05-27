/**
 * Interview-type-aware completion thresholds (RCA-1 / MATRIX_60 Phase 1).
 *
 * Behavioral interviews expect multiple spoken answers (≥3).
 * Coding and system-design sessions submit one substantive code/design
 * artifact (with optional follow-ups) — G.10 and pathway gates must
 * not treat them as "short-form" at answeredCount === 1.
 */

import type { Duration } from '@shared/types'
import {
  getQuestionCount,
  getCodingQuestionCount,
} from '@interview/config/interviewConfig'

/** Minimum answers for a scored behavioral (and similar multi-Q) session. */
export const STANDARD_SHORT_FORM_MIN_ANSWERS = 3

/** Minimum substantive submissions for coding / system-design. */
export const SUBSTANTIVE_SESSION_MIN_ANSWERS = 1

export function isSubstantiveSingleTaskInterview(interviewType?: string): boolean {
  return interviewType === 'coding' || interviewType === 'system-design'
}

export function getShortFormMinAnswers(interviewType?: string): number {
  return isSubstantiveSingleTaskInterview(interviewType)
    ? SUBSTANTIVE_SESSION_MIN_ANSWERS
    : STANDARD_SHORT_FORM_MIN_ANSWERS
}

/** System-design sessions budget one primary design submission. */
export function getSystemDesignQuestionCount(_duration: Duration): number {
  return 1
}

/**
 * Planned question count for G.10 completion ratio and user-facing copy.
 * Uses coding-specific budgets instead of behavioral getQuestionCount().
 */
export function getPlannedQuestionCountForFeedback(
  interviewType: string | undefined,
  duration: Duration,
): number {
  if (interviewType === 'coding') {
    return getCodingQuestionCount(duration)
  }
  if (interviewType === 'system-design') {
    return getSystemDesignQuestionCount(duration)
  }
  return getQuestionCount(duration)
}
