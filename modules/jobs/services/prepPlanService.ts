import { JobApplication } from '@shared/db/models'
/** Re-exported for the barrel; the pure math lives in config/prepPlan. */
export { buildPrepPlan, dateForChoice } from '../config/prepPlan'
export type { PrepPlan, PrepPlanSession } from '../config/prepPlan'

export async function setInterviewDate(
  userId: string,
  jobPostingId: string,
  capture: { date: Date | null; confidence: 'exact' | 'week' | 'unknown' },
  now = new Date()
): Promise<{ ok: boolean; daysUntil: number | null }> {
  // Sanity bounds: a past date (beyond yesterday) or >1y out is a typo.
  if (capture.date) {
    const delta = capture.date.getTime() - now.getTime()
    if (delta < -24 * 3600_000 || delta > 365 * 24 * 3600_000) return { ok: false, daysUntil: null }
  }
  const res = await JobApplication.updateOne(
    { userId, jobPostingId },
    {
      $set: {
        interviewDateConfidence: capture.confidence,
        ...(capture.date ? { interviewDate: capture.date } : {}),
      },
      ...(capture.date ? {} : { $unset: { interviewDate: 1 } }),
    }
  )
  if ((res?.matchedCount ?? 0) === 0) return { ok: false, daysUntil: null }
  return {
    ok: true,
    daysUntil: capture.date ? Math.max(0, Math.floor((capture.date.getTime() - now.getTime()) / (24 * 3600_000))) : null,
  }
}
