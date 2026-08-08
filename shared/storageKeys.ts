import { resetAnalyticsIdentity } from '@shared/analytics/track'
import { cancelAndPurgeReplayUploads } from '@shared/services/replayUploadPrivacy'

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

export const JOBS_STORAGE_KEYS = {
  TAILOR_PENDING_ASSOCIATION: 'jobs:tailor-pending-association:v1',
} as const

/** Returns a session-scoped localStorage key, e.g. "interviewData:abc123". */
export function sessionScopedKey(base: string, sessionId: string): string {
  return `${base}:${sessionId}`
}

const JOBS_ACCOUNT_STORAGE_PREFIXES = ['JOBS_', 'jobs:'] as const
const ACCOUNT_BOUND_LOCAL_STORAGE_PREFIXES = [
  ...JOBS_ACCOUNT_STORAGE_PREFIXES,
  'wizardDraft:',
  'ipg_billing_checkout_',
] as const
const LEGACY_WIZARD_DRAFT_KEY = 'wizardDraft'
const RESUME_DRAFT_PREFIX = 'resume:draft:'
const ANONYMOUS_RESUME_DRAFT_KEY = `${RESUME_DRAFT_PREFIX}anon`
const ACCOUNT_BOUND_SESSION_STORAGE_PREFIXES = [
  ...JOBS_ACCOUNT_STORAGE_PREFIXES,
  'feedback-session:',
  'recording-url:',
] as const
const JOBS_OAUTH_CONTINUATION_SESSION_KEYS = new Set<string>([
  JOBS_STORAGE_KEYS.TAILOR_PENDING_ASSOCIATION,
])

interface ClearInterviewStorageOptions {
  preserveOAuthContinuation?: boolean
}

/**
 * Clear account-bound interview and Jobs browser state.
 *
 * Identity transitions remove Jobs apply-return arms, target/resume-derived
 * ranking, and pending Tailor associations. The OAuth-specific wrapper below
 * can retain its explicitly allowlisted continuation only when the verified
 * return target is Tailor. Exact interview keys can be user-scoped with a `:`
 * suffix; Jobs-owned state uses the reserved `JOBS_` / `jobs:` prefixes.
 * Authenticated resume-builder and wizard drafts are also removed across all
 * user scopes so a shared browser cannot expose the prior account's edits.
 * `resume:draft:anon` is intentionally retained: it belongs to the logged-out
 * builder flow and is shown behind an explicit import-or-discard confirmation,
 * rather than being hydrated into an authenticated draft automatically.
 * Feedback snapshots and short-lived recording URLs are session caches but
 * still account-bound, so identity changes remove those prefixes as well.
 */
function clearInterviewStorage(
  { preserveOAuthContinuation = false }: ClearInterviewStorageOptions = {},
): Promise<void> {
  // Establish the upload cancellation generation synchronously before any
  // other account state changes, then await its IndexedDB Blob purge at the
  // direct sign-out/account-deletion boundaries.
  const replayPurge = cancelAndPurgeReplayUploads()
  try {
    const baseKeys = Object.values(STORAGE_KEYS)
    for (let i = localStorage.length - 1; i >= 0; i--) {
      const key = localStorage.key(i)
      if (key && (
        baseKeys.some(k => key === k || key.startsWith(`${k}:`)) ||
        ACCOUNT_BOUND_LOCAL_STORAGE_PREFIXES.some(prefix => key.startsWith(prefix)) ||
        key === LEGACY_WIZARD_DRAFT_KEY ||
        (key.startsWith(RESUME_DRAFT_PREFIX) && key !== ANONYMOUS_RESUME_DRAFT_KEY)
      )) {
        localStorage.removeItem(key)
      }
    }
  } catch {
    // localStorage may be unavailable (SSR, private browsing quota, etc.)
  }
  try {
    for (let i = sessionStorage.length - 1; i >= 0; i--) {
      const key = sessionStorage.key(i)
      if (key &&
        ACCOUNT_BOUND_SESSION_STORAGE_PREFIXES.some(prefix => key.startsWith(prefix)) &&
        (!preserveOAuthContinuation || !JOBS_OAUTH_CONTINUATION_SESSION_KEYS.has(key))) {
        sessionStorage.removeItem(key)
      }
    }
  } catch {
    // sessionStorage may be unavailable (SSR, private browsing, etc.)
  }
  resetAnalyticsIdentity()
  return replayPurge
}

/**
 * Clear account-bound browser state before OAuth. Tailor's one-time handoff is
 * retained only when the caller has verified the OAuth return target; Tailor
 * still treats that record as untrusted and revalidates its TTL, user, job,
 * and JD hash after the callback.
 */
export function clearInterviewStorageForOAuthSignIn(
  { preserveTailorContinuation = false }: { preserveTailorContinuation?: boolean } = {},
): Promise<void> {
  return clearInterviewStorage({ preserveOAuthContinuation: preserveTailorContinuation })
}

/** Destructive cleanup used for sign-out, account deletion, and inactive accounts. */
export function clearAllInterviewStorage(): Promise<void> {
  return clearInterviewStorage()
}
