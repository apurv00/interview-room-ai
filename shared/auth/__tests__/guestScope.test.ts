/**
 * The hire-guest capability scope is DEFAULT-DENY. These tests pin both
 * halves of that contract: the interview flow keeps working, and every
 * other authenticated surface — including ones nobody has enumerated yet —
 * stays closed.
 */

import { describe, it, expect } from 'vitest'
import {
  evaluateGuestAccess,
  isHireGuestEmail,
  guestRoundIdFromEmail,
  isGuestEmailForRound,
  GUEST_EMAIL_DOMAIN,
} from '../guestScope'

describe('guest identity detection', () => {
  it('matches only the synthetic per-round domain', () => {
    expect(isHireGuestEmail(`round-abc${GUEST_EMAIL_DOMAIN}`)).toBe(true)
    expect(isHireGuestEmail('jane@example.com')).toBe(false)
    // Look-alikes must not match.
    expect(isHireGuestEmail('someone@guests.interviewprep.internal.evil.com')).toBe(false)
    expect(isHireGuestEmail(undefined)).toBe(false)
    expect(isHireGuestEmail(null)).toBe(false)
    expect(isHireGuestEmail(42)).toBe(false)
  })
})

describe('round-scoped guest identity (multi-invite sign-out scoping)', () => {
  const roundA = 'a1b2c3d4e5f6a7b8c9d0e1f2'
  const roundB = 'ffffffffffffffffffffffff'

  it('extracts the round id from a synthetic guest email', () => {
    expect(guestRoundIdFromEmail(`round-${roundA}${GUEST_EMAIL_DOMAIN}`)).toBe(roundA)
    // Case-insensitive: cookies/JWTs may normalize either way.
    expect(guestRoundIdFromEmail(`ROUND-${roundA.toUpperCase()}${GUEST_EMAIL_DOMAIN}`)).toBe(roundA)
  })

  it('returns null for non-guests, lookalikes, and malformed locals', () => {
    expect(guestRoundIdFromEmail('jane@example.com')).toBe(null)
    expect(guestRoundIdFromEmail(`round-${roundA}${GUEST_EMAIL_DOMAIN}.evil.com`)).toBe(null)
    expect(guestRoundIdFromEmail(`nothing${GUEST_EMAIL_DOMAIN}`)).toBe(null)
    expect(guestRoundIdFromEmail(`round-${GUEST_EMAIL_DOMAIN}`)).toBe(null)
    expect(guestRoundIdFromEmail(undefined)).toBe(null)
    expect(guestRoundIdFromEmail(null)).toBe(null)
  })

  it('matches only its OWN round — an older round can never end a newer session', () => {
    expect(isGuestEmailForRound(`round-${roundA}${GUEST_EMAIL_DOMAIN}`, roundA)).toBe(true)
    expect(isGuestEmailForRound(`round-${roundA.toUpperCase()}${GUEST_EMAIL_DOMAIN}`, roundA)).toBe(true)
    // The founder-hit bug: round A's terminal/thank-you tab vs round B's session.
    expect(isGuestEmailForRound(`round-${roundB}${GUEST_EMAIL_DOMAIN}`, roundA)).toBe(false)
    expect(isGuestEmailForRound('jane@example.com', roundA)).toBe(false)
  })
})

describe('the interview flow keeps working', () => {
  // Every authenticated call the engine's room/lobby actually makes,
  // enumerated from the client source — if this list ever fails, the guest
  // interview is broken in production.
  const ENGINE_CALLS: Array<[string, string]> = [
    ['/api/interviews', 'POST'],
    ['/api/interviews/a1b2c3d4e5f6a7b8c9d0e1f2', 'PATCH'],
    ['/api/generate-question', 'POST'],
    ['/api/evaluate-answer', 'POST'],
    ['/api/evaluate-code', 'POST'],
    ['/api/evaluate-design', 'POST'],
    ['/api/generate-feedback', 'POST'],
    ['/api/code/generate-problem', 'POST'],
    ['/api/code/history', 'GET'],
    ['/api/code/run', 'POST'],
    ['/api/design/generate-problem', 'POST'],
    ['/api/design/history', 'GET'],
    ['/api/problems/served', 'POST'],
    ['/api/interview/answer-candidate-question', 'POST'],
    ['/api/interview/clarify-case-context', 'POST'],
    ['/api/interview/clarify-coding', 'POST'],
    ['/api/transcribe/token', 'POST'],
    ['/api/turn-router', 'POST'],
    ['/api/tts', 'POST'],
    ['/api/tts/stream', 'POST'],
    ['/api/recordings/finalize', 'POST'],
    ['/api/storage/presign', 'POST'],
    ['/api/storage/multipart', 'POST'],
    ['/api/settings/usage', 'GET'],
    ['/api/health', 'HEAD'],
    ['/api/auth/session', 'GET'],
    ['/api/auth/signout', 'POST'],
    ['/api/candidate/aaaaaaaaaaaaaaaaaaaaaaaa/begin', 'POST'],
    ['/api/candidate/aaaaaaaaaaaaaaaaaaaaaaaa/prepare', 'POST'],
  ]

  it.each(ENGINE_CALLS)('allows %s (%s)', (pathname, method) => {
    expect(evaluateGuestAccess(pathname, method).allowed).toBe(true)
  })

  it('allows the pages the flow navigates through', () => {
    for (const page of ['/lobby', '/interview', '/candidate/x', '/candidate/thank-you', '/candidate-status/link-id']) {
      expect(evaluateGuestAccess(page, 'GET').allowed).toBe(true)
    }
  })

  it('allows only the exact status bootstrap mutation-free public endpoint', () => {
    const linkId = 'a'.repeat(24)
    expect(evaluateGuestAccess(`/api/candidate-status/${linkId}/bootstrap`, 'POST').allowed).toBe(true)
    expect(evaluateGuestAccess(`/api/candidate-status/${linkId}/bootstrap`, 'GET').allowed).toBe(false)
    expect(evaluateGuestAccess(`/api/candidate-status/${linkId}/revoke`, 'POST').allowed).toBe(false)
  })
})

describe('everything else is denied by default', () => {
  // Result surfaces — the founder ruling.
  it('denies result reads (the curl loophole) and redirects the results UI', () => {
    expect(evaluateGuestAccess('/api/interviews/a1b2c3d4e5f6a7b8c9d0e1f2', 'GET').allowed).toBe(false)
    expect(evaluateGuestAccess('/api/interviews/a1b2c3d4e5f6a7b8c9d0e1f2/transcript', 'GET').allowed).toBe(false)
    expect(evaluateGuestAccess('/api/analysis/a1b2c3d4e5f6a7b8c9d0e1f2', 'GET').allowed).toBe(false)
    const ui = evaluateGuestAccess('/feedback/a1b2c3d4e5f6a7b8c9d0e1f2', 'GET')
    expect(ui.allowed).toBe(false)
    expect(ui.redirectTo).toBe('/candidate/thank-you')
  })

  // The whole point of default-deny: surfaces nobody thought about.
  const FORBIDDEN: Array<[string, string]> = [
    ['/api/settings/export-data', 'GET'], // GDPR dump of the account
    ['/api/account', 'DELETE'],
    ['/api/settings/consent', 'POST'],
    ['/api/resume/pdf', 'POST'],
    ['/api/learn/pathway', 'GET'],
    ['/api/jobs/feed', 'GET'],
    ['/api/documents/upload', 'POST'],
    ['/api/onboarding', 'POST'],
    ['/api/billing/orders/interview', 'POST'], // no personal checkout
    ['/api/hypothetical/future/route', 'POST'], // proves default-deny
    // Hire observations use the runtime-native fenced endpoint. Guests must
    // never regain the B2C raw-landmark or consumer-analysis paths.
    ['/api/recordings/landmarks', 'POST'],
    ['/api/analysis/start', 'POST'],
  ]

  it.each(FORBIDDEN)('denies %s (%s)', (pathname, method) => {
    expect(evaluateGuestAccess(pathname, method).allowed).toBe(false)
  })

  it('denies B2C pages, sending the candidate back to their own surface', () => {
    for (const page of ['/history', '/resume', '/learn/pathway', '/jobs', '/settings']) {
      const decision = evaluateGuestAccess(page, 'GET')
      expect(decision.allowed).toBe(false)
      expect(decision.redirectTo).toBe('/candidate/thank-you')
    }
  })

  it('does not let a session-id-shaped path smuggle a GET through the write rule', () => {
    expect(evaluateGuestAccess('/api/interviews/a1b2c3d4e5f6a7b8c9d0e1f2', 'GET').allowed).toBe(false)
    // Non-ObjectId subpaths never match the write rule either.
    expect(evaluateGuestAccess('/api/interviews/last-config', 'PATCH').allowed).toBe(false)
  })
})

describe('method-aware scoping (result reads hide behind shared paths)', () => {
  it('allows POST /api/interviews but DENIES GET (the collection lists feedback)', () => {
    expect(evaluateGuestAccess('/api/interviews', 'POST').allowed).toBe(true)
    expect(evaluateGuestAccess('/api/interviews', 'GET').allowed).toBe(false)
  })

  it('denies methods not granted for an allowed path', () => {
    expect(evaluateGuestAccess('/api/settings/usage', 'GET').allowed).toBe(true)
    expect(evaluateGuestAccess('/api/settings/usage', 'DELETE').allowed).toBe(false)
    expect(evaluateGuestAccess('/api/tts', 'GET').allowed).toBe(false)
  })
})

describe('prefix denial cannot be inherited', () => {
  it('denies consumer analysis, including the old trigger and all result reads', () => {
    expect(evaluateGuestAccess('/api/analysis/start', 'POST').allowed).toBe(false)
    expect(evaluateGuestAccess('/api/analysis/a1b2c3d4e5f6a7b8c9d0e1f2', 'GET').allowed).toBe(false)
    // A future /api/analysis/* route does not inherit access.
    expect(evaluateGuestAccess('/api/analysis/anything-new', 'POST').allowed).toBe(false)
  })
})
