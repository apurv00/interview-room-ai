/**
 * Email timing math (EMAILS.md §1/§6) — pure, IST-anchored. IST is UTC+5:30
 * with no DST, so all helpers are fixed-offset arithmetic on UTC
 * timestamps; no Intl, no environment timezone.
 *
 * Send window: 08:00–21:00 IST. E2 anchors: T-1 09:00 IST for exact dates,
 * Monday 09:00 IST of the interview week for week-confidence dates.
 */

const IST_OFFSET_MS = 330 * 60_000 // +5:30

/** The IST calendar date/time parts of an instant (via offset shift). */
function istParts(d: Date) {
  const shifted = new Date(d.getTime() + IST_OFFSET_MS)
  return {
    y: shifted.getUTCFullYear(),
    m: shifted.getUTCMonth(),
    d: shifted.getUTCDate(),
    hour: shifted.getUTCHours(),
    minute: shifted.getUTCMinutes(),
    /** 0 = Sunday … 6 = Saturday, in IST. */
    weekday: shifted.getUTCDay(),
  }
}

/** The UTC instant of {y,m,d} at hour:minute IST. */
function istInstant(y: number, m: number, d: number, hour: number, minute = 0): Date {
  return new Date(Date.UTC(y, m, d, hour, minute) - IST_OFFSET_MS)
}

export function isInSendWindow(now: Date): boolean {
  const { hour } = istParts(now)
  return hour >= 8 && hour < 21
}

/** Now if inside the window; otherwise the next 08:00 IST. */
export function nextSendSlot(now: Date): Date {
  const p = istParts(now)
  if (p.hour >= 8 && p.hour < 21) return now
  if (p.hour < 8) return istInstant(p.y, p.m, p.d, 8)
  // past 21:00 IST → tomorrow 08:00 IST (Date.UTC normalizes month rollover)
  return istInstant(p.y, p.m, p.d + 1, 8)
}

/** IST calendar-day difference (b - a), independent of time of day. */
export function istCalendarDaysBetween(a: Date, b: Date): number {
  const pa = istParts(a)
  const pb = istParts(b)
  return Math.round((Date.UTC(pb.y, pb.m, pb.d) - Date.UTC(pa.y, pa.m, pa.d)) / 86_400_000)
}

/**
 * E2 send instant for an interview date (EMAILS.md §1):
 * - exact  → 09:00 IST the day BEFORE the interview's IST calendar day
 * - week   → Monday 09:00 IST of the interview's IST week; if that has
 *            already passed when armed, the next 09:00 IST slot; if the
 *            whole week has passed, never (null)  [R14]
 * Returns null when no send should happen (too late).
 */
export function e2SendInstant(
  interviewDate: Date,
  confidence: 'exact' | 'week',
  now: Date
): Date | null {
  const iv = istParts(interviewDate)
  if (confidence === 'exact') {
    const sendAt = istInstant(iv.y, iv.m, iv.d - 1, 9)
    // The reminder must land BEFORE the interview day ends; past that it
    // is noise about an event that happened.
    const interviewDayEnd = istInstant(iv.y, iv.m, iv.d, 21)
    if (now.getTime() > interviewDayEnd.getTime()) return null
    return sendAt
  }
  // week confidence: Monday of the interview's IST week (weekday 1).
  const daysSinceMonday = (iv.weekday + 6) % 7
  const monday = istInstant(iv.y, iv.m, iv.d - daysSinceMonday, 9)
  const weekEnd = istInstant(iv.y, iv.m, iv.d - daysSinceMonday + 7, 0)
  if (now.getTime() >= weekEnd.getTime()) return null // week over — never [R14]
  if (now.getTime() <= monday.getTime()) return monday
  // Late-set: next 09:00 IST slot from now.
  const p = istParts(now)
  return p.hour < 9 ? istInstant(p.y, p.m, p.d, 9) : istInstant(p.y, p.m, p.d + 1, 9)
}
