import type { StoredInterviewData } from '@shared/types'
import { STORAGE_KEYS, sessionScopedKey } from '@shared/storageKeys'

/**
 * Try to read interview data from localStorage, preferring the session-scoped
 * key and falling back to the unscoped key.
 */
export function readLocalInterviewData(sessionId?: string): StoredInterviewData | null {
  if (typeof window === 'undefined') return null

  // Try session-scoped key first
  if (sessionId) {
    const scoped = localStorage.getItem(sessionScopedKey(STORAGE_KEYS.INTERVIEW_DATA, sessionId))
    if (scoped) {
      try {
        return JSON.parse(scoped)
      } catch { /* ignore parse errors */ }
    }
  }

  // Fall back to unscoped key
  const unscoped = localStorage.getItem(STORAGE_KEYS.INTERVIEW_DATA)
  if (unscoped) {
    try {
      return JSON.parse(unscoped)
    } catch { /* ignore parse errors */ }
  }

  return null
}

/**
 * Merge localStorage data into a DB-loaded session when the DB transcript
 * is empty (e.g. the PATCH to persist completed data failed silently).
 *
 * Returns a new object with merged fields; does NOT mutate the input.
 */
export function mergeWithLocalData(
  dbData: StoredInterviewData,
  sessionId?: string,
): StoredInterviewData {
  if (dbData.transcript.length > 0) return dbData

  const local = readLocalInterviewData(sessionId)
  if (!local || !local.transcript?.length) return dbData

  return {
    ...dbData,
    transcript: local.transcript,
    evaluations: local.evaluations?.length ? local.evaluations : dbData.evaluations,
    speechMetrics: local.speechMetrics?.length ? local.speechMetrics : dbData.speechMetrics,
  }
}

/**
 * Clean up localStorage keys for a session after successful data load.
 */
export function cleanupLocalInterviewData(sessionId?: string): void {
  if (typeof window === 'undefined') return
  try {
    localStorage.removeItem(STORAGE_KEYS.INTERVIEW_DATA)
    if (sessionId) {
      localStorage.removeItem(sessionScopedKey(STORAGE_KEYS.INTERVIEW_DATA, sessionId))
    }
  } catch { /* ignore */ }
}
