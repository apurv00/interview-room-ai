/** Centralized localStorage key constants to avoid magic strings across files. */
export const STORAGE_KEYS = {
  INTERVIEW_CONFIG: 'interviewConfig',
  INTERVIEW_DATA: 'interviewData',
  INTERVIEW_ACTIVE_SESSION: 'interviewActiveSession', // sessionId when interview is in progress
  /**
   * Parent session id for a pending retake. Written by the feedback page
   * when the user clicks "Retake this interview", read by useInterview's
   * createDbSession call and cleared immediately after. Used to link the
   * new InterviewSession to its parent so comparison can diff vs. first
   * attempt.
   */
  PENDING_RETAKE_PARENT: 'pendingRetakeParent',
} as const

/** Returns a session-scoped localStorage key, e.g. "interviewData:abc123". */
export function sessionScopedKey(base: string, sessionId: string): string {
  return `${base}:${sessionId}`
}

/**
 * Clear ALL interview-related localStorage keys — both unscoped and scoped
 * variants (e.g. "interviewConfig" AND "interviewConfig:userId123").
 *
 * Called on sign-out and before new OAuth flows to prevent cross-user data
 * leakage. See Bug #1: user A's config (including resume text) could leak
 * to user B if localStorage isn't fully scrubbed.
 */
export function clearAllInterviewStorage(): void {
  try {
    const baseKeys = Object.values(STORAGE_KEYS)
    for (let i = localStorage.length - 1; i >= 0; i--) {
      const key = localStorage.key(i)
      if (key && baseKeys.some(k => key === k || key.startsWith(`${k}:`))) {
        localStorage.removeItem(key)
      }
    }
  } catch {
    // localStorage may be unavailable (SSR, private browsing quota, etc.)
  }
}
