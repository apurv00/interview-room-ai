import { JobApplication } from '@shared/db/models'
import { withActiveJobsAccountWrite } from '@shared/services/jobsAccountFence'
import { calendarDaysBetween, type InterviewDateCapture } from '../config/prepPlan'
/** Re-exported for the barrel; the pure math lives in config/prepPlan. */
export { buildPrepPlan, dateForChoice, calendarDaysBetween } from '../config/prepPlan'
export type { InterviewDateCapture, InterviewDatePreference, PrepPlan, PrepPlanSession } from '../config/prepPlan'

export interface InterviewDateStateToken {
  /** Completed rounds visible when the timing control was opened. */
  interviewRounds: number
  /** Monotonic outcome revision visible at the same time. */
  outcomeRevision: number
}

export type SetInterviewDateResult =
  | { ok: true; daysUntil: number | null }
  | { ok: false; daysUntil: null; reason: 'invalid' | 'state-conflict' }

function legacyZeroOrExact(path: string, value: number): Record<string, unknown> {
  return value === 0
    ? { $or: [{ [path]: 0 }, { [path]: { $exists: false } }] }
    : { [path]: value }
}

export async function setInterviewDate(
  userId: string,
  jobPostingId: string,
  capture: InterviewDateCapture,
  expectedState: InterviewDateStateToken,
  now = new Date()
): Promise<SetInterviewDateResult> {
  if (
    !Number.isSafeInteger(expectedState.interviewRounds) ||
    expectedState.interviewRounds < 0 || expectedState.interviewRounds > 100 ||
    !Number.isSafeInteger(expectedState.outcomeRevision) ||
    expectedState.outcomeRevision < 0
  ) return { ok: false, daysUntil: null, reason: 'invalid' }

  const validShape =
    (capture.confidence === 'exact' && !!capture.date && !capture.preference) ||
    (capture.confidence === 'week' && !capture.date && ['this-week', 'next-week'].includes(capture.preference ?? '')) ||
    (capture.confidence === 'unknown' && !capture.date && capture.preference === 'unknown')
  if (!validShape) return { ok: false, daysUntil: null, reason: 'invalid' }

  // Sanity bounds: a past exact date (beyond yesterday) or >1y out is a typo.
  if (capture.date) {
    const delta = capture.date.getTime() - now.getTime()
    if (delta < -24 * 3600_000 || delta > 365 * 24 * 3600_000) {
      return { ok: false, daysUntil: null, reason: 'invalid' }
    }
  }
  const unset: Record<string, 1> = {}
  if (!capture.date) unset.interviewDate = 1
  if (!capture.preference) unset.interviewDatePreference = 1
  const res = await withActiveJobsAccountWrite(userId, (session) =>
    JobApplication.updateOne(
      {
        userId,
        jobPostingId,
        status: 'interview_scheduled',
        $and: [
          legacyZeroOrExact('outcome.interviewRounds', expectedState.interviewRounds),
          legacyZeroOrExact('outcome.revision', expectedState.outcomeRevision),
        ],
      },
      {
        $set: {
          interviewDateConfidence: capture.confidence,
          ...(capture.date ? { interviewDate: capture.date } : {}),
          ...(capture.preference ? { interviewDatePreference: capture.preference } : {}),
        },
        ...(Object.keys(unset).length ? { $unset: unset } : {}),
      },
      { session },
    ),
  )
  if ((res?.matchedCount ?? 0) === 0) {
    return { ok: false, daysUntil: null, reason: 'state-conflict' }
  }
  return {
    ok: true,
    daysUntil: capture.date ? Math.max(0, calendarDaysBetween(now, capture.date)) : null,
  }
}
