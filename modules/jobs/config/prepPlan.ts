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
      headline: 'Date not locked yet — start now; every session counts as evidence.',
      sessions: [{ label: 'Session 1 — start now', dayOffset: 0 }],
    }
  }
  const daysUntil = Math.max(0, Math.floor((interviewDate.getTime() - now.getTime()) / (24 * 3600_000)))
  if (daysUntil >= 3) {
    const midpoint = Math.floor(daysUntil / 2)
    return {
      mode: 'three-session',
      headline: '3 mocks built from this JD — spaced to the interview.',
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
      headline: '2 focused mocks built from this JD — it’s close.',
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

/** Named sheet buttons → concrete capture (client passes the choice; the
 *  server owns date math so clocks can't disagree). */
export function dateForChoice(
  choice: 'tomorrow' | 'this-week' | 'next-week' | 'not-sure',
  now = new Date()
): { date: Date | null; confidence: 'exact' | 'week' | 'unknown' } {
  const day = 24 * 3600_000
  switch (choice) {
    case 'tomorrow':
      return { date: new Date(now.getTime() + day), confidence: 'exact' }
    case 'this-week':
      return { date: new Date(now.getTime() + 3 * day), confidence: 'week' }
    case 'next-week':
      return { date: new Date(now.getTime() + 9 * day), confidence: 'week' }
    case 'not-sure':
      return { date: null, confidence: 'unknown' }
  }
}

