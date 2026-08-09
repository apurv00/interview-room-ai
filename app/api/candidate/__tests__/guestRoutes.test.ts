/**
 * Guest auth-seam routes, both verification modes (per-workspace choice,
 * snapshotted on the round):
 *
 *   magic_link — /begin: consent → synthetic per-round User → ticket.
 *   otp        — /begin: consent → code emailed to the ADDRESS ON RECORD
 *                (no identity minted yet); /verify: code → User → ticket.
 *
 * Common invariants under test: consent is recorded before any identity
 * exists; the candidate's real email never reaches the B2C users table; a
 * ticket exists only downstream of the mode's full gate chain.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'
import { NextRequest } from 'next/server'

const mocks = vi.hoisted(() => ({
  verifyRoundToken: vi.fn(),
  bindGuestUser: vi.fn(),
  recordConsent: vi.fn(),
  issueAuthTicket: vi.fn(),
  issueOtp: vi.fn(),
  verifyOtp: vi.fn(),
  sendEmail: vi.fn(),
  userFindOne: vi.fn(),
  userCreate: vi.fn(),
  userUpdateOne: vi.fn(),
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
vi.mock('@b2b/services/inviteTicketService', () => ({
  issueAuthTicket: mocks.issueAuthTicket,
}))
vi.mock('@b2b/services/otpService', () => ({
  issueOtp: mocks.issueOtp,
  verifyOtp: mocks.verifyOtp,
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
    updateOne: mocks.userUpdateOne,
  },
}))
vi.mock('@shared/middleware/checkRateLimit', () => ({
  checkRateLimit: vi.fn().mockResolvedValue(null),
}))
vi.mock('@shared/logger', () => ({
  authLogger: { warn: vi.fn(), error: vi.fn(), info: vi.fn() },
  logger: { warn: vi.fn(), error: vi.fn(), info: vi.fn() },
}))

import { POST as begin } from '../[roundId]/begin/route'
import { POST as verifyCode } from '../[roundId]/verify/route'
import { guestEmailForRound } from '@hire'
import { AppError } from '@shared/errors'

const ROUND_ID = 'aaaaaaaaaaaaaaaaaaaaaaaa'
const TOKEN = 'ab'.repeat(32)
const SYNTHETIC = guestEmailForRound(ROUND_ID)

function post(path: 'begin' | 'verify', body: Record<string, unknown>) {
  return new NextRequest(`http://localhost/api/candidate/${ROUND_ID}/${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'user-agent': 'TestBrowser/1.0' },
    body: JSON.stringify(body),
  })
}

function round(authMode: 'magic_link' | 'otp', over: Record<string, unknown> = {}) {
  return {
    state: 'ok',
    round: {
      _id: ROUND_ID,
      authMode,
      candidateName: 'Jane Doe',
      candidateEmail: 'jane@ex.com',
      consentAt: new Date(),
      ...over,
    },
  }
}

beforeEach(() => {
  vi.clearAllMocks()
  mocks.issueAuthTicket.mockResolvedValue('ticket-1')
  mocks.recordConsent.mockResolvedValue({})
  mocks.bindGuestUser.mockResolvedValue({})
  mocks.sendEmail.mockResolvedValue({ ok: true })
  mocks.issueOtp.mockResolvedValue({ code: '123456' })
})

describe('POST /begin — shared gates', () => {
  it('410s dead links without recording consent or touching Users', async () => {
    mocks.verifyRoundToken.mockResolvedValue({ state: 'revoked', round: {} })
    const res = await begin(post('begin', { token: TOKEN }), { params: { roundId: ROUND_ID } })
    expect(res.status).toBe(410)
    expect(mocks.recordConsent).not.toHaveBeenCalled()
    expect(mocks.userCreate).not.toHaveBeenCalled()
    expect(mocks.issueOtp).not.toHaveBeenCalled()
  })

  it('rejects malformed tokens at the schema boundary', async () => {
    const res = await begin(post('begin', { token: 'short' }), { params: { roundId: ROUND_ID } })
    expect(res.status).toBe(400)
    expect(mocks.verifyRoundToken).not.toHaveBeenCalled()
  })

  it('propagates a consent-stage 410 (link died between verify and consent)', async () => {
    mocks.verifyRoundToken.mockResolvedValue(round('magic_link'))
    mocks.recordConsent.mockRejectedValue(new AppError('gone', 410, 'ROUND_LINK_INVALID'))
    const res = await begin(post('begin', { token: TOKEN }), { params: { roundId: ROUND_ID } })
    expect(res.status).toBe(410)
    expect(mocks.userCreate).not.toHaveBeenCalled()
  })
})

describe('POST /begin — magic_link mode', () => {
  it('records consent, mints the SYNTHETIC per-round user, binds, returns a ticket', async () => {
    mocks.verifyRoundToken.mockResolvedValue(round('magic_link'))
    mocks.userFindOne.mockResolvedValue(null)
    mocks.userCreate.mockResolvedValue({ _id: { toString: () => 'guest-1' } })

    const res = await begin(post('begin', { token: TOKEN }), { params: { roundId: ROUND_ID } })
    const data = await res.json()
    expect(res.status).toBe(200)
    expect(data.ticket).toBe('ticket-1')

    expect(mocks.recordConsent).toHaveBeenCalledWith(ROUND_ID, TOKEN, {
      userAgent: 'TestBrowser/1.0',
    })
    expect(mocks.recordConsent.mock.invocationCallOrder[0]).toBeLessThan(
      mocks.userCreate.mock.invocationCallOrder[0]
    )
    const doc = mocks.userCreate.mock.calls[0][0]
    expect(doc.email).toBe(SYNTHETIC)
    expect(doc.email).not.toContain('jane@ex.com')
    expect(doc).toMatchObject({ role: 'candidate', plan: 'free', monthlyInterviewLimit: 3 })
    // Employer-funded: the billing system's own grant lever ($set, the same
    // write path payments uses), bounded — the candidate must never see the
    // consumer paywall, and a leaked guest JWT cannot farm unlimited engine
    // runs (founder P0 on #605: a hire candidate was shown the ₹69 checkout).
    expect(mocks.userUpdateOne.mock.calls[0][1].$set).toEqual({
      entitlementSource: 'admin_grant',
      monthlyInterviewLimit: 3,
    })
    expect(mocks.bindGuestUser).toHaveBeenCalledWith(ROUND_ID, TOKEN, 'guest-1')
    expect(mocks.issueAuthTicket).toHaveBeenCalledWith('guest-1', ROUND_ID)
    expect(mocks.issueOtp).not.toHaveBeenCalled()
  })

  it('reuses the round synthetic user on re-entry (idempotent, no re-grant)', async () => {
    mocks.verifyRoundToken.mockResolvedValue(round('magic_link'))
    mocks.userFindOne.mockResolvedValue({
      _id: { toString: () => 'guest-1' },
      entitlementSource: 'admin_grant',
    })
    const res = await begin(post('begin', { token: TOKEN }), { params: { roundId: ROUND_ID } })
    expect(res.status).toBe(200)
    expect(mocks.userCreate).not.toHaveBeenCalled()
    expect(mocks.userUpdateOne).not.toHaveBeenCalled()
  })

  it('upgrades a pre-grant guest in place so it never hits the consumer paywall', async () => {
    mocks.verifyRoundToken.mockResolvedValue(round('magic_link'))
    mocks.userFindOne.mockResolvedValue({ _id: 'guest-legacy-id' })
    const res = await begin(post('begin', { token: TOKEN }), { params: { roundId: ROUND_ID } })
    expect(res.status).toBe(200)
    const [filter, update] = mocks.userUpdateOne.mock.calls[0]
    expect(filter).toEqual({ _id: 'guest-legacy-id' })
    expect(update.$set).toEqual({
      entitlementSource: 'admin_grant',
      monthlyInterviewLimit: 3,
    })
  })

  it('collapses a concurrent double-begin via the unique email index (E11000 → reuse)', async () => {
    mocks.verifyRoundToken.mockResolvedValue(round('magic_link'))
    mocks.userFindOne
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce({ _id: { toString: () => 'guest-race-winner' } })
    mocks.userCreate.mockRejectedValue(Object.assign(new Error('dup'), { code: 11000 }))
    const res = await begin(post('begin', { token: TOKEN }), { params: { roundId: ROUND_ID } })
    expect(res.status).toBe(200)
    expect(mocks.issueAuthTicket).toHaveBeenCalledWith('guest-race-winner', ROUND_ID)
  })
})

describe('POST /begin — otp mode', () => {
  it('emails a code to the ADDRESS ON RECORD and mints no identity yet', async () => {
    mocks.verifyRoundToken.mockResolvedValue(round('otp'))
    const res = await begin(post('begin', { token: TOKEN }), { params: { roundId: ROUND_ID } })
    const data = await res.json()
    expect(res.status).toBe(200)
    expect(data).toMatchObject({ ok: true, otpRequired: true })
    expect(data.ticket).toBeUndefined()

    expect(mocks.issueOtp).toHaveBeenCalledWith(`hire:${ROUND_ID}`, 'jane@ex.com')
    expect(mocks.sendEmail.mock.calls[0][0].to).toBe('jane@ex.com')
    expect(mocks.userCreate).not.toHaveBeenCalled()
    expect(mocks.issueAuthTicket).not.toHaveBeenCalled()
  })

  it('503s (not silent GENERIC_OK) when the code email cannot be sent', async () => {
    mocks.verifyRoundToken.mockResolvedValue(round('otp'))
    mocks.sendEmail.mockResolvedValue({ ok: false })
    const res = await begin(post('begin', { token: TOKEN }), { params: { roundId: ROUND_ID } })
    expect(res.status).toBe(503)
  })

  it('caps code issuance at 3 per 15 min per round (v1 parity — no inbox flooding)', async () => {
    const { checkRateLimit } = await import('@shared/middleware/checkRateLimit')
    const rateLimitMock = checkRateLimit as unknown as ReturnType<typeof vi.fn>
    rateLimitMock.mockImplementation(async (_id: string, cfg: { keyPrefix: string }) =>
      cfg.keyPrefix === 'rl:hire-otp-issue'
        ? new Response(null, { status: 429 })
        : null
    )
    mocks.verifyRoundToken.mockResolvedValue(round('otp'))

    const res = await begin(post('begin', { token: TOKEN }), { params: { roundId: ROUND_ID } })
    expect(res.status).toBe(429)
    expect(mocks.issueOtp).not.toHaveBeenCalled()
    expect(mocks.sendEmail).not.toHaveBeenCalled()

    rateLimitMock.mockResolvedValue(null)
  })
})

describe('POST /verify — otp mode second step', () => {
  const body = { token: TOKEN, code: '123456' }

  it('verifies the code, then mints the synthetic user, binds, and returns a ticket', async () => {
    mocks.verifyRoundToken.mockResolvedValue(round('otp'))
    mocks.verifyOtp.mockResolvedValue({ ok: true })
    mocks.userFindOne.mockResolvedValue(null)
    mocks.userCreate.mockResolvedValue({ _id: { toString: () => 'guest-1' } })

    const res = await verifyCode(post('verify', body), { params: { roundId: ROUND_ID } })
    const data = await res.json()
    expect(res.status).toBe(200)
    expect(data).toEqual({ ok: true, ticket: 'ticket-1' })
    expect(mocks.verifyOtp).toHaveBeenCalledWith(`hire:${ROUND_ID}`, 'jane@ex.com', '123456')
    expect(mocks.userCreate.mock.calls[0][0].email).toBe(SYNTHETIC)
    expect(mocks.bindGuestUser).toHaveBeenCalledWith(ROUND_ID, TOKEN, 'guest-1')
  })

  it('refuses magic_link rounds and unconsented rounds', async () => {
    mocks.verifyRoundToken.mockResolvedValue(round('magic_link'))
    let res = await verifyCode(post('verify', body), { params: { roundId: ROUND_ID } })
    expect(res.status).toBe(400)
    expect(mocks.verifyOtp).not.toHaveBeenCalled()

    mocks.verifyRoundToken.mockResolvedValue(round('otp', { consentAt: undefined }))
    res = await verifyCode(post('verify', body), { params: { roundId: ROUND_ID } })
    expect(res.status).toBe(400)
    expect(mocks.verifyOtp).not.toHaveBeenCalled()
    expect(mocks.userCreate).not.toHaveBeenCalled()
  })

  it('maps OTP lockout to 429 and mints nothing', async () => {
    mocks.verifyRoundToken.mockResolvedValue(round('otp'))
    mocks.verifyOtp.mockResolvedValue({ ok: false, reason: 'locked' })
    const res = await verifyCode(post('verify', body), { params: { roundId: ROUND_ID } })
    expect(res.status).toBe(429)
    expect(mocks.userCreate).not.toHaveBeenCalled()
    expect(mocks.issueAuthTicket).not.toHaveBeenCalled()
  })

  it('maps a wrong code to 400 invalid_code', async () => {
    mocks.verifyRoundToken.mockResolvedValue(round('otp'))
    mocks.verifyOtp.mockResolvedValue({ ok: false, reason: 'mismatch' })
    const res = await verifyCode(post('verify', body), { params: { roundId: ROUND_ID } })
    expect(res.status).toBe(400)
    expect((await res.json()).reason).toBe('invalid_code')
  })
})
