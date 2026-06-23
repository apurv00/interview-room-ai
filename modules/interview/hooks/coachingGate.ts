/**
 * Coaching gate — decides whether the interview engine should BLOCK after an
 * answer to let the candidate read the STAR coaching tip.
 *
 * Two independent inputs:
 *   - `coachMode`: the per-interview setting (chosen at setup). When off, the
 *     engine never blocks for coaching — it has always been fire-and-forget.
 *   - `liveCoachingEnabled`: the in-room master switch (feedback #1). A
 *     candidate can silence all live coaching mid-interview. When off, the
 *     blocking 3-6s read-pause must be skipped too — otherwise hiding the tip
 *     leaves the candidate staring at dead air while the engine still waits.
 *     Defaults to `true` (coaching on) when unset, matching the page-level seed.
 *
 * Pure + colocated with the hook so the hot-path branch at the call site stays
 * readable and the decision is unit-testable without driving the whole state
 * machine. See useInterview.ts `showCoachingTip`.
 */
export function shouldBlockForCoaching(
  coachMode?: boolean,
  liveCoachingEnabled?: boolean,
): boolean {
  return !!coachMode && (liveCoachingEnabled ?? true)
}
