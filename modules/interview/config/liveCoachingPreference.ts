/**
 * Device-level UI preference: whether LIVE coaching is shown DURING an
 * interview — i.e. the real-time nudges ("detected long pause", "speed up",
 * filler/eye-contact warnings) plus the STAR coach overlay and coaching tips.
 *
 * Candidate feedback: mid-answer suggestions can be distracting, so the
 * interview room exposes a single master switch to silence all of them. This
 * is purely a DISPLAY gate — it never touches the live transcript, the AI
 * interviewer/TTS, or the post-interview scored feedback.
 *
 * Stored as a plain localStorage flag that is intentionally NOT user- or
 * session-scoped: it carries no PII, so it survives sign-out and applies as the
 * default for every future interview on this device. Default is ON (do not
 * silently remove an advertised feature for users who never opted out).
 */
export const LIVE_COACHING_STORAGE_KEY = 'liveCoachingEnabled'

/**
 * Read the saved preference. Returns `true` (coaching shown) when the flag is
 * unset, malformed, or localStorage is unavailable (SSR / private browsing /
 * quota) — the default must match the server-rendered default to avoid a
 * hydration mismatch.
 */
export function readLiveCoachingPreference(): boolean {
  if (typeof window === 'undefined') return true
  try {
    // Only an explicit 'false' disables it; anything else (incl. null) → on.
    return window.localStorage.getItem(LIVE_COACHING_STORAGE_KEY) !== 'false'
  } catch {
    return true
  }
}

/**
 * Persist the device-wide DEFAULT that seeds the lobby toggle for future
 * interviews. Best-effort: a write failure (private browsing / quota) is
 * swallowed.
 *
 * This is NOT the channel that carries the choice into the interview room — the
 * per-interview value rides `InterviewConfig.liveCoachingEnabled`, written
 * atomically on room entry. So a failed write here only means the lobby won't
 * pre-check the box next time; the current interview still honors the selection.
 */
export function writeLiveCoachingPreference(enabled: boolean): void {
  if (typeof window === 'undefined') return
  try {
    window.localStorage.setItem(LIVE_COACHING_STORAGE_KEY, enabled ? 'true' : 'false')
  } catch {
    // localStorage unavailable — preference applies to this session only.
  }
}
