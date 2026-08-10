/** Candidate entry routes: Hire-owned consent/session, optional mailbox OTP,
 * and a hard proof that a matching B2C email is never resolved as a User. */

import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { NextRequest } from 'next/server'

const mocks = vi.hoisted(() => ({
  verifyRoundToken: vi.fn(),
  acceptConsent: vi.fn(),
  issueOtp: vi.fn(),
  verifyOtp: vi.fn(),
  sendEmail: vi.fn(),
  checkRateLimit: vi.fn(),
}))

vi.mock('@hire', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@hire')>()),
  verifyRoundToken: mocks.verifyRoundToken,
}))
vi.mock('@hire/services/identityConsentService', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@hire/services/identityConsentService')>()),
  acceptHireConsentAndIssueGuestSession: mocks.acceptConsent,
}))
vi.mock('@b2b/services/otpService', () => ({
  issueOtp: mocks.issueOtp,
  verifyOtp: mocks.verifyOtp,
}))
vi.mock('@shared/services/emailService', () => ({
  sendEmail: mocks.sendEmail,
}))
vi.mock('@shared/middleware/checkRateLimit', () => ({
  checkRateLimit: mocks.checkRateLimit,
}))
vi.mock('@shared/logger', () => ({
  authLogger: { warn: vi.fn(), error: vi.fn(), info: vi.fn() },
  logger: { warn: vi.fn(), error: vi.fn(), info: vi.fn() },
}))

import { POST as begin } from '../[roundId]/begin/route'
import { POST as verifyCode } from '../[roundId]/verify/route'

const ROUND_ID = 'aaaaaaaaaaaaaaaaaaaaaaaa'
const WORKSPACE_ID = '111111111111111111111111'
const TOKEN = 'ab'.repeat(32)
const CAPABILITY = `${WORKSPACE_ID}.${TOKEN}`
const COLLIDING_EMAIL = 'existing-b2c-user@example.com'
const ACCEPTED = {
  recording: true,
  identityPhoto: true,
  attentionMonitoring: true,
  aiEvaluation: true,
} as const

function request(path: 'begin' | 'verify', body: Record<string, unknown>) {
  return new NextRequest(`http://localhost/api/candidate/${ROUND_ID}/${path}`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'user-agent': 'TestBrowser/1.0',
      'accept-language': 'en-IN,en;q=0.9',
    },
    body: JSON.stringify(body),
  })
}

function verified(authMode: 'magic_link' | 'otp') {
  return {
    state: 'ok',
    round: {
      _id: ROUND_ID,
      workspaceId: { toString: () => WORKSPACE_ID },
      authMode,
      candidateName: 'Jane Candidate',
      candidateEmail: COLLIDING_EMAIL,
    },
  }
}

beforeEach(() => {
  vi.clearAllMocks()
  mocks.checkRateLimit.mockResolvedValue(null)
  mocks.issueOtp.mockResolvedValue({ code: '123456' })
  mocks.verifyOtp.mockResolvedValue({ ok: true })
  mocks.sendEmail.mockResolvedValue({ ok: true })
  mocks.acceptConsent.mockResolvedValue({
    credential: 'hire-guest-credential',
    csrfToken: 'cd'.repeat(32),
    consentVersion: 'hire-ai-v1-2026-08-10',
    disclosureDigest: 'ef'.repeat(32),
    scope: { expiresAt: new Date(Date.now() + 60_000) },
  })
})

describe('POST /begin', () => {
  it('rejects a dead link before consent/session or mailbox work', async () => {
    mocks.verifyRoundToken.mockResolvedValue({ state: 'revoked', round: {} })
    const response = await begin(
      request('begin', { capability: CAPABILITY, accepted: ACCEPTED }),
      { params: { roundId: ROUND_ID } },
    )
    expect(response.status).toBe(410)
    expect(mocks.acceptConsent).not.toHaveBeenCalled()
    expect(mocks.issueOtp).not.toHaveBeenCalled()
  })

  it('refuses partial or false consent before any camera/session can start', async () => {
    const response = await begin(
      request('begin', {
        capability: CAPABILITY,
        accepted: { ...ACCEPTED, attentionMonitoring: false },
      }),
      { params: { roundId: ROUND_ID } },
    )
    expect(response.status).toBe(400)
    expect(mocks.verifyRoundToken).not.toHaveBeenCalled()
    expect(mocks.acceptConsent).not.toHaveBeenCalled()
  })

  it('creates a Hire-owned guest capability in magic-link mode', async () => {
    mocks.verifyRoundToken.mockResolvedValue(verified('magic_link'))
    const response = await begin(
      request('begin', { capability: CAPABILITY, accepted: ACCEPTED }),
      { params: { roundId: ROUND_ID } },
    )
    const body = await response.json()

    expect(response.status).toBe(200)
    expect(body).toMatchObject({
      ok: true,
      next: 'identity_photo',
      csrfToken: 'cd'.repeat(32),
    })
    expect(mocks.acceptConsent).toHaveBeenCalledWith({
      roundId: ROUND_ID,
      inviteCapability: CAPABILITY,
      accepted: ACCEPTED,
      userAgent: 'TestBrowser/1.0',
      locale: 'en-IN',
    })
    expect(response.headers.get('set-cookie')).toContain('hire_guest=hire-guest-credential')
    expect(response.headers.get('set-cookie')).toContain('HttpOnly')
    expect(response.headers.get('cache-control')).toBe('no-store')
  })

  it('sends OTP only to the email stored on the Hire round—even if it matches B2C', async () => {
    mocks.verifyRoundToken.mockResolvedValue(verified('otp'))
    const response = await begin(
      request('begin', { capability: CAPABILITY, accepted: ACCEPTED }),
      { params: { roundId: ROUND_ID } },
    )
    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({ ok: true, otpRequired: true })
    expect(mocks.issueOtp).toHaveBeenCalledWith(
      `hire:${WORKSPACE_ID}:${ROUND_ID}`,
      COLLIDING_EMAIL,
    )
    expect(mocks.sendEmail).toHaveBeenCalledWith(
      expect.objectContaining({
        to: COLLIDING_EMAIL,
        idempotencyKey: expect.stringMatching(/^[a-f0-9]{64}$/),
      }),
    )
    expect(mocks.acceptConsent).not.toHaveBeenCalled()
  })

  it('fails visibly if OTP delivery fails and rate-limits issuance', async () => {
    mocks.verifyRoundToken.mockResolvedValue(verified('otp'))
    mocks.sendEmail.mockResolvedValueOnce({ ok: false })
    const failed = await begin(
      request('begin', { capability: CAPABILITY, accepted: ACCEPTED }),
      { params: { roundId: ROUND_ID } },
    )
    expect(failed.status).toBe(503)

    mocks.checkRateLimit.mockImplementation(
      async (_identity: string, options: { keyPrefix: string }) =>
        options.keyPrefix === 'rl:hire-otp-issue'
          ? new Response(null, { status: 429 })
          : null,
    )
    const blocked = await begin(
      request('begin', { capability: CAPABILITY, accepted: ACCEPTED }),
      { params: { roundId: ROUND_ID } },
    )
    expect(blocked.status).toBe(429)
  })
})

describe('POST /verify', () => {
  it('verifies the stored Hire email before issuing the Hire guest capability', async () => {
    mocks.verifyRoundToken.mockResolvedValue(verified('otp'))
    const response = await verifyCode(
      request('verify', { capability: CAPABILITY, code: '123456', accepted: ACCEPTED }),
      { params: { roundId: ROUND_ID } },
    )
    expect(response.status).toBe(200)
    expect(mocks.verifyOtp).toHaveBeenCalledWith(
      `hire:${WORKSPACE_ID}:${ROUND_ID}`,
      COLLIDING_EMAIL,
      '123456',
    )
    expect(mocks.acceptConsent).toHaveBeenCalledWith(
      expect.objectContaining({
        roundId: ROUND_ID,
        inviteCapability: CAPABILITY,
        accepted: ACCEPTED,
      }),
    )
    expect(response.headers.get('set-cookie')).toContain('hire_guest=hire-guest-credential')
  })

  it('does not create a session for wrong, locked, or unavailable OTP state', async () => {
    mocks.verifyRoundToken.mockResolvedValue(verified('otp'))
    for (const [result, status] of [
      [{ ok: false, reason: 'invalid' }, 400],
      [{ ok: false, reason: 'locked' }, 429],
      [{ ok: false, reason: 'redis_error' }, 503],
    ] as const) {
      mocks.verifyOtp.mockResolvedValueOnce(result)
      const response = await verifyCode(
        request('verify', {
          capability: CAPABILITY,
          code: '123456',
          accepted: ACCEPTED,
        }),
        { params: { roundId: ROUND_ID } },
      )
      expect(response.status).toBe(status)
    }
    expect(mocks.acceptConsent).not.toHaveBeenCalled()
  })
})

describe('identity separation source guard', () => {
  it('never imports User, NextAuth, the B2C ticket seam, or candidate-email lookup code', () => {
    for (const relative of [
      'app/api/candidate/[roundId]/begin/route.ts',
      'app/api/candidate/[roundId]/verify/route.ts',
      'app/api/candidate/[roundId]/start/route.ts',
    ]) {
      const source = readFileSync(join(process.cwd(), relative), 'utf8')
      expect(source).not.toMatch(/@shared\/db\/models|next-auth|inviteTicketService/)
      expect(source).not.toMatch(/User\.(?:find|findOne|create|update)/)
    }
  })
})
