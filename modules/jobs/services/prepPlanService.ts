import { JobApplication } from '@shared/db/models'
import { withActiveJobsAccountWrite } from '@shared/services/jobsAccountFence'
import { calendarDaysBetween, type InterviewDateCapture } from '../config/prepPlan'
/** Re-exported for the barrel; the pure math lives in config/prepPlan. */
export { buildPrepPlan, dateForChoice, calendarDaysBetween } from '../config/prepPlan'
export type { InterviewDateCapture, InterviewDatePreference, PrepPlan, PrepPlanSession } from '../config/prepPlan'

export async function setInterviewDate(
  userId: string,
  jobPostingId: string,
  capture: InterviewDateCapture,
  now = new Date()
): Promise<{ ok: boolean; daysUntil: number | null }> {
  const validShape =
    (capture.confidence === 'exact' && !!capture.date && !capture.preference) ||
    (capture.confidence === 'week' && !capture.date && ['this-week', 'next-week'].includes(capture.preference ?? '')) ||
    (capture.confidence === 'unknown' && !capture.date && capture.preference === 'unknown')
  if (!validShape) return { ok: false, daysUntil: null }

  // Sanity bounds: a past exact date (beyond yesterday) or >1y out is a typo.
  if (capture.date) {
    const delta = capture.date.getTime() - now.getTime()
    if (delta < -24 * 3600_000 || delta > 365 * 24 * 3600_000) return { ok: false, daysUntil: null }
  }
  const unset: Record<string, 1> = {}
  if (!capture.date) unset.interviewDate = 1
  if (!capture.preference) unset.interviewDatePreference = 1
  const res = await withActiveJobsAccountWrite(userId, (session) =>
    JobApplication.updateOne(
      { userId, jobPostingId },
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
  if ((res?.matchedCount ?? 0) === 0) return { ok: false, daysUntil: null }
  return {
    ok: true,
    daysUntil: capture.date ? Math.max(0, calendarDaysBetween(now, capture.date)) : null,
  }
}
