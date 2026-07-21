/** Client-safe labels derived only from persisted or server-projected facts. */

const DAY_MS = 86_400_000
const IST_OFFSET_MS = 330 * 60_000

export const JOB_TARGET_QUESTION_CTA = 'Answer one question'
export const JOB_TARGET_QUESTION_SUMMARY = 'One question — role, done.'

export function postedAgeLabel(iso: string | undefined, now = Date.now()): string | null {
  if (!iso) return null
  const postedAt = Date.parse(iso)
  // Upstream clocks can be wrong. A future or malformed value is not
  // evidence that a posting is new, so render no freshness claim.
  if (!Number.isFinite(postedAt) || postedAt > now) return null
  const calendarKey = (value: number) => {
    const shifted = new Date(value + IST_OFFSET_MS)
    return Date.UTC(shifted.getUTCFullYear(), shifted.getUTCMonth(), shifted.getUTCDate())
  }
  const days = Math.round((calendarKey(now) - calendarKey(postedAt)) / DAY_MS)
  if (days === 0) return 'Listed today'
  if (days === 1) return 'Listed yesterday'
  if (days > 30) return null
  return `Listed ${days} days ago`
}

export function clickAgeLabel(clickedAgoHours: number): string {
  const hours = Number.isFinite(clickedAgoHours) ? Math.max(0, Math.floor(clickedAgoHours)) : 0
  if (hours < 1) return 'less than an hour ago'
  if (hours < 24) return `${hours} ${hours === 1 ? 'hour' : 'hours'} ago`
  const days = Math.floor(hours / 24)
  return `${days} ${days === 1 ? 'day' : 'days'} ago`
}

function formatIstDate(iso: string): string | null {
  const date = new Date(iso)
  if (!Number.isFinite(date.getTime())) return null
  return new Intl.DateTimeFormat('en-IN', {
    day: 'numeric',
    month: 'short',
    year: 'numeric',
    timeZone: 'Asia/Kolkata',
  }).format(date)
}

export function interviewDateLabel(
  iso: string | undefined,
  confidence: 'exact' | 'week' | 'unknown' | undefined,
  preference?: 'this-week' | 'next-week' | 'unknown',
): string {
  const date = iso ? formatIstDate(iso) : null
  if (confidence === 'exact' && date) return `Interview date: ${date}`
  if (confidence === 'week' && preference === 'this-week') return 'Preferred interview window: this week'
  if (confidence === 'week' && preference === 'next-week') return 'Preferred interview window: next week'
  if (confidence === 'week') return 'Interview week preference saved — exact date not set'
  return 'Exact interview date not set'
}

export function practiceProgressLabel(count: number): string {
  const completed = Math.min(3, Math.max(0, Math.floor(count)))
  return `Job-specific practice completed: ${completed}/3 sessions`
}
