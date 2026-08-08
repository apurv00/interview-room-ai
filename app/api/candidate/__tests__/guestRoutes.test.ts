/**
 * Guest auth-seam routes: consent gating, anti-enumeration, and the
 * find-or-create User boundary (the ONLY sanctioned B2C write in the hire
 * flow — goal item 2). Service internals are mocked; what's under test is
 * the routes' gate ordering and response discipline.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'
import { NextRequest } from 'next/server'

const mocks = vi.hoisted(() => ({
  verifyRoundToken: vi.fn(),
  bindGuestUser: vi.fn(),
  recordConsent: vi.fn(),
  issueOtp: vi.fn(),
  verifyOtp: vi.fn(),
  issueAuthTicket: vi.fn(),
  sendEmail: vi.fn(),
  userFindOne: vi.fn(),
  userCreate: vi.fn(),
}))

vi.mock('@hire', async () => {
  const actual = await vi.importActual<typeof import('@hire')>('@hire')
  return {
    ...actual,
    verifyRoundToken: mocks.verifyRoundToken,
    bindGuestUser: mocks.bindGuestUser,
    recordConsent: mocks.recordConsent,
  }
})
vi.mock('@b2b/services/otpService', () => ({
  issueOtp: mocks.issueOtp,
  verifyOtp: mocks.verifyOtp,
}))
vi.mock('@b2b/services/inviteTicketService', () => ({
  issueAuthTicket: mocks.issueAuthTicket,
}))
vi.mock('@shared/services/emailService', () => ({
  sendEmail: mocks.sendEmail,
}))
vi.mock('@shared/db/connection', () => ({
  connectDB: vi.fn().mockResolvedValue(undefined),
}))
vi.mock('@shared/db/models', () => ({
  User: {
    findOne: mocks.userFindOne,
    create: mocks.userCreate,
  },
}))
vi.mock('@shared/middleware/checkRateLimit', () => ({
  checkRateLimit: vi.fn().mockResolvedValue(null),
}))
vi.mock('@shared/logger', () => ({
  authLogger: { warn: vi.fn(), error: vi.fn(), info: vi.fn() },
  logger: { warn: vi.fn(), error: vi.fn(), info: vi.fn() },
}))

import { POST as requestOtp } from '../[roundId]/request-otp/route'
import { POST as verifyOtpRoute } from '../[roundId]/verify-otp/route'
import { POST as consentRoute } from '../[roundId]/consent/route'

const ROUND_ID = 'aaaaaaaaaaaaaaaaaaaaaaaa'
const TOKEN = 'ab'.repeat(32)
const EMAIL = 'jane@ex.com'

function post(path: string, body: Record<string, unknown>) {
  return new NextRequest(`http://localhost${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })
}

function okRound(over: Record<string, unknown> = {}) {
  return {
    state: 'ok',
    round: {
      _id: ROUND_ID,
      consentAt: new Date(),
      candidateEmail: EMAIL,
      candidateName: 'Jane Doe',
      ...over,
    },
  }
}

beforeEach(() => {
  vi.clearAllMocks()
  mocks.sendEmail.mockResolvedValue({ ok: true })
  mocks.issueOtp.mockResolvedValue({ code: '123456' })
  mocks.issueAuthTicket.mockResolvedValue('ticket-1')
})

describe('POST /api/candidate/[roundId]/request-otp', () => {
  it('returns the constant shape and issues nothing when consent is missing', async () => {
    mocks.verifyRoundToken.mockResolvedValue(okRound({ consentAt: undefined }))
    const res = await requestOtp(post(`/api/candidate/${ROUND_ID}/request-otp`, { token: TOKEN, email: EMAIL }), {
      params: { roundId: ROUND_ID },
    })
    expect(res.status).toBe(200)
    expect((await res.json()).ok).toBe(true)
    expect(mocks.issueOtp).not.toHaveBeenCalled()
    expect(mocks.sendEmail).not.toHaveBeenCalled()
  })

  it('returns the same constant shape on an email mismatch (anti-enumeration)', async () => {
    mocks.verifyRoundToken.mockResolvedValue(okRound())
    const res = await requestOtp(
      post(`/api/candidate/${ROUND_ID}/request-otp`, { token: TOKEN, email: 'wrong@ex.com' }),
      { params: { roundId: ROUND_ID } }
    )
    expect(res.status).toBe(200)
    expect((await res.json()).ok).toBe(true)
    expect(mocks.issueOtp).not.toHaveBeenCalled()
  })

  it('issues the OTP under the hire: namespace and emails the candidate', async () => {
    mocks.verifyRoundToken.mockResolvedValue(okRound())
    const res = await requestOtp(post(`/api/candidate/${ROUND_ID}/request-otp`, { token: TOKEN, email: EMAIL }), {
      params: { roundId: ROUND_ID },
    })
    expect(res.status).toBe(200)
    expect(mocks.issueOtp).toHaveBeenCalledWith(`hire:${ROUND_ID}`, EMAIL)
    expect(mocks.sendEmail.mock.calls[0][0].to).toBe(EMAIL)
  })
})

describe('POST /api/candidate/[roundId]/verify-otp', () => {
  const body = { token: TOKEN, email: EMAIL, code: '123456' }

  it('refuses before consent — the disclosure cannot be skipped via the API', async () => {
    mocks.verifyRoundToken.mockResolvedValue(okRound({ consentAt: undefined }))
    const res = await verifyOtpRoute(post(`/api/candidate/${ROUND_ID}/verify-otp`, body), {
      params: { roundId: ROUND_ID },
    })
    expect(res.status).toBe(400)
    expect(mocks.verifyOtp).not.toHaveBeenCalled()
    expect(mocks.userCreate).not.toHaveBeenCalled()
  })

  it('creates the guest User once (v1 parity: uncapped limit), binds the round, returns a ticket', async () => {
    mocks.verifyRoundToken.mockResolvedValue(okRound())
    mocks.verifyOtp.mockResolvedValue({ ok: true })
    mocks.userFindOne.mockResolvedValue(null)
    mocks.userCreate.mockResolvedValue({ _id: { toString: () => 'guest-1' } })
    mocks.bindGuestUser.mockResolvedValue({})

    const res = await verifyOtpRoute(post(`/api/candidate/${ROUND_ID}/verify-otp`, body), {
      params: { roundId: ROUND_ID },
    })
    const data = await res.json()
    expect(res.status).toBe(200)
    expect(data).toEqual({ ok: true, ticket: 'ticket-1' })
    expect(mocks.verifyOtp).toHaveBeenCalledWith(`hire:${ROUND_ID}`, EMAIL, '123456')
    expect(mocks.userCreate.mock.calls[0][0]).toMatchObject({
      email: EMAIL,
      role: 'candidate',
      plan: 'free',
      monthlyInterviewLimit: 999999,
    })
    expect(mocks.bindGuestUser).toHaveBeenCalledWith(ROUND_ID, TOKEN, 'guest-1')
    expect(mocks.issueAuthTicket).toHaveBeenCalledWith('guest-1', ROUND_ID)
  })

  it('reuses an existing User row instead of creating a duplicate', async () => {
    mocks.verifyRoundToken.mockResolvedValue(okRound())
    mocks.verifyOtp.mockResolvedValue({ ok: true })
    mocks.userFindOne.mockResolvedValue({ _id: { toString: () => 'existing-guest' } })
    mocks.bindGuestUser.mockResolvedValue({})

    const res = await verifyOtpRoute(post(`/api/candidate/${ROUND_ID}/verify-otp`, body), {
      params: { roundId: ROUND_ID },
    })
    expect(res.status).toBe(200)
    expect(mocks.userCreate).not.toHaveBeenCalled()
    expect(mocks.issueAuthTicket).toHaveBeenCalledWith('existing-guest', ROUND_ID)
  })

  it('maps OTP lockout to 429', async () => {
    mocks.verifyRoundToken.mockResolvedValue(okRound())
    mocks.verifyOtp.mockResolvedValue({ ok: false, reason: 'locked' })
    const res = await verifyOtpRoute(post(`/api/candidate/${ROUND_ID}/verify-otp`, body), {
      params: { roundId: ROUND_ID },
    })
    expect(res.status).toBe(429)
    expect(mocks.userCreate).not.toHaveBeenCalled()
  })
})

describe('POST /api/candidate/[roundId]/consent', () => {
  it('records consent with the caller user agent', async () => {
    mocks.recordConsent.mockResolvedValue({})
    const req = new NextRequest(`http://localhost/api/candidate/${ROUND_ID}/consent`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'user-agent': 'TestBrowser/1.0' },
      body: JSON.stringify({ token: TOKEN }),
    })
    const res = await consentRoute(req, { params: { roundId: ROUND_ID } })
    expect(res.status).toBe(200)
    expect(mocks.recordConsent).toHaveBeenCalledWith(ROUND_ID, TOKEN, {
      userAgent: 'TestBrowser/1.0',
    })
  })

  it('propagates the 410 for dead links', async () => {
    const { AppError } = await import('@shared/errors')
    mocks.recordConsent.mockRejectedValue(new AppError('gone', 410, 'ROUND_LINK_INVALID'))
    const res = await consentRoute(post(`/api/candidate/${ROUND_ID}/consent`, { token: TOKEN }), {
      params: { roundId: ROUND_ID },
    })
    expect(res.status).toBe(410)
  })
})
