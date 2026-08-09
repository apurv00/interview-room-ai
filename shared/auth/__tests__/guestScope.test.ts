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
    ['/api/recordings/landmarks', 'POST'],
    ['/api/storage/presign', 'POST'],
    ['/api/storage/multipart', 'POST'],
    ['/api/settings/usage', 'GET'],
    ['/api/health', 'HEAD'],
    ['/api/analysis/start', 'POST'],
    ['/api/auth/session', 'GET'],
    ['/api/auth/signout', 'POST'],
    ['/api/candidate/aaaaaaaaaaaaaaaaaaaaaaaa/begin', 'POST'],
    ['/api/candidate/aaaaaaaaaaaaaaaaaaaaaaaa/prepare', 'POST'],
  ]

  it.each(ENGINE_CALLS)('allows %s (%s)', (pathname, method) => {
    expect(evaluateGuestAccess(pathname, method).allowed).toBe(true)
  })

  it('allows the pages the flow navigates through', () => {
    for (const page of ['/lobby', '/interview', '/candidate/x', '/candidate/thank-you']) {
      expect(evaluateGuestAccess(page, 'GET').allowed).toBe(true)
    }
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
  it('permits the analysis TRIGGER but denies analysis result reads', () => {
    expect(evaluateGuestAccess('/api/analysis/start', 'POST').allowed).toBe(true)
    expect(evaluateGuestAccess('/api/analysis/a1b2c3d4e5f6a7b8c9d0e1f2', 'GET').allowed).toBe(false)
    // A future /api/analysis/* route does not inherit access.
    expect(evaluateGuestAccess('/api/analysis/anything-new', 'POST').allowed).toBe(false)
  })
})
