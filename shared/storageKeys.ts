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
