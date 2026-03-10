/** Centralized localStorage key constants to avoid magic strings across files. */
export const STORAGE_KEYS = {
  INTERVIEW_CONFIG: 'interviewConfig',
  INTERVIEW_DATA: 'interviewData',
} as const

/** Returns a session-scoped localStorage key, e.g. "interviewData:abc123". */
export function sessionScopedKey(base: string, sessionId: string): string {
  return `${base}:${sessionId}`
}
