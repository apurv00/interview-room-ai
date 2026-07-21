/**
 * The §4c prep plan — PURE math, client-safe (deep-importable by 'use
 * client' pages; the @jobs barrel drags mongoose). The DB write lives in
 * services/prepPlanService.ts.
 *
 * Deterministic, no LLM: >=3 days -> 3 sessions (today/midpoint/day-before);
 * <=2 days -> two focused; unknown -> start now. Phase-1 copy is "{n} mocks
 * built from this JD" — NO per-session must-have tags until a focus channel
 * exists.
 */

const IST_OFFSET_MS = 330 * 60_000

/** CALENDAR days between two instants (IST-truncated) — 'tomorrow' is 1
 *  from capture until it arrives, never decaying to 0 within 24h of the
 *  tap (Codex on #525: ms-floor math showed the interview-day plan an hour
 *  after choosing Tomorrow). Capture and render share this convention. */
export function calendarDaysBetween(from: Date, to: Date): number {
  const fromIst = new Date(from.getTime() + IST_OFFSET_MS)
  const toIst = new Date(to.getTime() + IST_OFFSET_MS)
  const a = Date.UTC(fromIst.getUTCFullYear(), fromIst.getUTCMonth(), fromIst.getUTCDate())
  const b = Date.UTC(toIst.getUTCFullYear(), toIst.getUTCMonth(), toIst.getUTCDate())
  return Math.round((b - a) / (24 * 3600_000))
}

function istDateOnly(now: Date, dayOffset: number): Date {
  const shifted = new Date(now.getTime() + IST_OFFSET_MS)
  return new Date(Date.UTC(
    shifted.getUTCFullYear(),
    shifted.getUTCMonth(),
    shifted.getUTCDate() + dayOffset,
  ))
}

export interface PrepPlanSession {
  /** Stable ordinal label the UI renders. */
  label: string
  /** Day offset from `now` (0 = today). */
  dayOffset: number
}

export interface PrepPlan {
  mode: 'three-session' | 'two-session' | 'start-now'
  headline: string
  sessions: PrepPlanSession[]
}

export function buildPrepPlan(interviewDate: Date | null, now = new Date()): PrepPlan {
  if (!interviewDate) {
    return {
      mode: 'start-now',
      headline: 'Exact interview date not set — start with one job-specific practice session.',
      sessions: [{ label: 'Session 1 — start now', dayOffset: 0 }],
    }
  }
  const daysUntil = Math.max(0, calendarDaysBetween(now, interviewDate))
  if (daysUntil >= 3) {
    const midpoint = Math.floor(daysUntil / 2)
    return {
      mode: 'three-session',
      headline: '3 job-specific practice sessions — spaced before your saved interview date.',
      sessions: [
        { label: 'Session 1 — today', dayOffset: 0 },
        { label: 'Session 2 — midpoint', dayOffset: midpoint },
        { label: 'Session 3 — day before', dayOffset: Math.max(1, daysUntil - 1) },
      ],
    }
  }
  if (daysUntil >= 1) {
    return {
      mode: 'two-session',
      headline: '2 job-specific practice sessions before your saved interview date.',
      sessions: [
        { label: 'Session 1 — today', dayOffset: 0 },
        { label: 'Session 2 — day before', dayOffset: Math.max(0, daysUntil - 1) },
      ],
    }
  }
  return {
    mode: 'two-session',
    headline: 'Interview day — one warm-up mock, then go get it.',
    sessions: [{ label: 'Warm-up — now', dayOffset: 0 }],
  }
}

export type InterviewDatePreference = 'this-week' | 'next-week' | 'unknown'
export type InterviewDateCapture = {
  date: Date | null
  confidence: 'exact' | 'week' | 'unknown'
  preference?: InterviewDatePreference
}

/** Named sheet buttons → persisted capture. Week answers are preferences,
 *  never synthetic event dates; only "tomorrow" supplies an exact date. */
export function dateForChoice(
  choice: 'tomorrow' | 'this-week' | 'next-week' | 'not-sure',
  now = new Date()
): InterviewDateCapture {
  switch (choice) {
    case 'tomorrow':
      return { date: istDateOnly(now, 1), confidence: 'exact' }
    case 'this-week':
      return { date: null, confidence: 'week', preference: 'this-week' }
    case 'next-week':
      return { date: null, confidence: 'week', preference: 'next-week' }
    case 'not-sure':
      return { date: null, confidence: 'unknown', preference: 'unknown' }
  }
}
