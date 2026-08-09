/**
 * Hire-guest capability scope — the single authority on what an invited
 * candidate's session may reach.
 *
 * ARCHITECTURE (founder ruling 2026-08-09, replacing per-endpoint patching):
 * an IPG Hire guest is NOT a B2C user. The interview engine requires a
 * NextAuth session on every call (getServerSession everywhere), so a session
 * must exist — but its scope is "run exactly one interview", not "everything
 * a signed-in user can do". Subtracting capabilities one door at a time
 * (results page, results API, …) is unbounded: GDPR export, account,
 * resumes, history, learn, jobs and every future authed route stay open
 * until someone notices.
 *
 * So this is DEFAULT-DENY: a guest may reach only the paths listed here;
 * everything else 403s. New B2C surfaces are therefore closed to guests the
 * day they ship, without anyone remembering to think about hire.
 *
 * Edge-safe: pure data + string matching, no imports — middleware runs on
 * the Edge runtime and cannot import Mongoose-backed modules. The guest
 * email domain is duplicated from modules/hire's guestEmailForRound; that
 * duplication is pinned by modules/hire/__tests__/guestFlowContract.test.ts.
 */

/** Per-round synthetic identities live on this non-routable domain. */
export const GUEST_EMAIL_DOMAIN = '@guests.interviewprep.internal'

export function isHireGuestEmail(email: unknown): boolean {
  return typeof email === 'string' && email.endsWith(GUEST_EMAIL_DOMAIN)
}

/**
 * Pages a guest may load. The interview flow only ever needs its own
 * surface plus the engine's lobby/room; results pages are deliberately
 * absent (handled by an explicit redirect, so the candidate gets the
 * thank-you screen rather than a bare 403).
 */
const ALLOWED_PAGE_PREFIXES = [
  '/candidate', // the guest surface itself (consent, prepare, thank-you)
  '/lobby', // engine: device checks
  '/interview', // engine: the interview room
]

/**
 * API paths a guest may call — derived from the engine's actual
 * authenticated call surface (interview room, lobby, media/recording,
 * evaluation, TTS/STT), NOT from guesswork. Anything the interview does
 * not need is denied, including result reads.
 *
 * Deliberately EXCLUDED even though the room references them elsewhere:
 *   /api/interviews/:id GET (results), /api/analysis/* (replay/analysis),
 *   /api/learn/*, /api/jobs/*, /api/resume/*, /api/account, /api/settings/*
 *   except usage, /api/documents/upload, /api/onboarding/*.
 */
const ALLOWED_API_EXACT = new Set([
  '/api/interviews', // POST: engine self-provisions the session
  '/api/generate-question',
  '/api/evaluate-answer',
  '/api/evaluate-code',
  '/api/evaluate-design',
  '/api/generate-feedback', // engine fires this at completion (HR's report)
  '/api/code/generate-problem',
  '/api/code/history',
  '/api/code/run',
  '/api/design/generate-problem',
  '/api/design/history',
  '/api/problems/served',
  '/api/interview/answer-candidate-question',
  '/api/interview/clarify-case-context',
  '/api/interview/clarify-coding',
  '/api/transcribe/token',
  '/api/turn-router',
  '/api/tts',
  '/api/tts/stream',
  '/api/recordings/finalize',
  '/api/recordings/landmarks',
  '/api/storage/presign',
  '/api/storage/multipart',
  '/api/settings/usage', // lobby pre-flight reads plan/entitlement
  '/api/debug/deepgram-ws-close',
  '/api/health',
])

const ALLOWED_API_PREFIXES = [
  '/api/auth/', // NextAuth itself (sign-out must always work)
  '/api/candidate/', // the guest surface's own endpoints
]

/**
 * PATCH /api/interviews/:id is how the engine persists the completed
 * interview; GET on the same path returns results and must stay denied.
 */
function isInterviewSessionWrite(pathname: string, method: string): boolean {
  return (
    /^\/api\/interviews\/[a-f0-9]{24}$/i.test(pathname) &&
    (method === 'PATCH' || method === 'POST')
  )
}

export interface GuestAccessDecision {
  allowed: boolean
  /** Set when the guest should be redirected instead of hard-denied. */
  redirectTo?: string
}

/**
 * The authority. Called by middleware for every request carrying a
 * synthetic-guest JWT.
 */
export function evaluateGuestAccess(pathname: string, method: string): GuestAccessDecision {
  // Results surfaces: redirect (not 403) so a candidate finishing the
  // interview lands on the thank-you screen.
  if (pathname.startsWith('/feedback')) {
    return { allowed: false, redirectTo: '/candidate/thank-you' }
  }

  if (!pathname.startsWith('/api/')) {
    // Static/Next internals are filtered by the matcher; treat remaining
    // page loads as allow-listed pages only.
    const allowed = ALLOWED_PAGE_PREFIXES.some(
      (p) => pathname === p || pathname.startsWith(`${p}/`)
    )
    return allowed ? { allowed: true } : { allowed: false, redirectTo: '/candidate/thank-you' }
  }

  if (ALLOWED_API_EXACT.has(pathname)) return { allowed: true }
  if (ALLOWED_API_PREFIXES.some((p) => pathname.startsWith(p))) return { allowed: true }
  if (isInterviewSessionWrite(pathname, method)) return { allowed: true }

  return { allowed: false }
}
