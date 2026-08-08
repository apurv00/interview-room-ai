/**
 * Guest auth-seam route (magic-link model): POST /begin is the single entry
 * — consent is recorded before any identity exists, the guest User is a
 * per-round SYNTHETIC identity (never the candidate's real email), and the
 * ticket only exists downstream of both. Service internals are mocked; under
 * test are the route's gate ordering, identity discipline, and error paths.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'
import { NextRequest } from 'next/server'

const mocks = vi.hoisted(() => ({
  verifyRoundToken: vi.fn(),
  bindGuestUser: vi.fn(),
  recordConsent: vi.fn(),
  issueAuthTicket: vi.fn(),
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
vi.mock('@b2b/services/inviteTicketService', () => ({
  issueAuthTicket: mocks.issueAuthTicket,
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

import { POST as begin } from '../[roundId]/begin/route'
import { guestEmailForRound } from '@hire'
import { AppError } from '@shared/errors'

const ROUND_ID = 'aaaaaaaaaaaaaaaaaaaaaaaa'
const TOKEN = 'ab'.repeat(32)
const SYNTHETIC = guestEmailForRound(ROUND_ID)

function post(body: Record<string, unknown>) {
  return new NextRequest(`http://localhost/api/candidate/${ROUND_ID}/begin`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'user-agent': 'TestBrowser/1.0' },
    body: JSON.stringify(body),
  })
}

function okRound() {
  return {
    state: 'ok',
    round: { _id: ROUND_ID, candidateName: 'Jane Doe', candidateEmail: 'jane@ex.com' },
  }
}

beforeEach(() => {
  vi.clearAllMocks()
  mocks.issueAuthTicket.mockResolvedValue('ticket-1')
  mocks.recordConsent.mockResolvedValue({})
  mocks.bindGuestUser.mockResolvedValue({})
})

describe('POST /api/candidate/[roundId]/begin', () => {
  it('410s dead links without recording consent or touching Users', async () => {
    mocks.verifyRoundToken.mockResolvedValue({ state: 'revoked', round: {} })
    const res = await begin(post({ token: TOKEN }), { params: { roundId: ROUND_ID } })
    expect(res.status).toBe(410)
    expect(mocks.recordConsent).not.toHaveBeenCalled()
    expect(mocks.userCreate).not.toHaveBeenCalled()
    expect(mocks.issueAuthTicket).not.toHaveBeenCalled()
  })

  it('records consent, mints the SYNTHETIC per-round user, binds, and returns a ticket', async () => {
    mocks.verifyRoundToken.mockResolvedValue(okRound())
    mocks.userFindOne.mockResolvedValue(null)
    mocks.userCreate.mockResolvedValue({ _id: { toString: () => 'guest-1' } })

    const res = await begin(post({ token: TOKEN }), { params: { roundId: ROUND_ID } })
    const data = await res.json()
    expect(res.status).toBe(200)
    expect(data.ok).toBe(true)
    expect(data.ticket).toBe('ticket-1')

    // Consent is recorded before any identity exists.
    expect(mocks.recordConsent).toHaveBeenCalledWith(ROUND_ID, TOKEN, {
      userAgent: 'TestBrowser/1.0',
    })
    expect(mocks.recordConsent.mock.invocationCallOrder[0]).toBeLessThan(
      mocks.userCreate.mock.invocationCallOrder[0]
    )

    // Synthetic identity — the candidate's REAL email never reaches Users.
    const doc = mocks.userCreate.mock.calls[0][0]
    expect(doc.email).toBe(SYNTHETIC)
    expect(doc.email).toContain('@guests.interviewprep.internal')
    expect(doc.email).not.toContain('jane@ex.com')
    expect(doc).toMatchObject({
      role: 'candidate',
      plan: 'free',
      monthlyInterviewLimit: 999999,
      name: 'Jane Doe',
    })

    expect(mocks.bindGuestUser).toHaveBeenCalledWith(ROUND_ID, TOKEN, 'guest-1')
    expect(mocks.issueAuthTicket).toHaveBeenCalledWith('guest-1', ROUND_ID)
  })

  it('reuses the round synthetic user on re-entry (idempotent)', async () => {
    mocks.verifyRoundToken.mockResolvedValue(okRound())
    mocks.userFindOne.mockResolvedValue({ _id: { toString: () => 'guest-1' } })

    const res = await begin(post({ token: TOKEN }), { params: { roundId: ROUND_ID } })
    expect(res.status).toBe(200)
    expect(mocks.userCreate).not.toHaveBeenCalled()
    expect(mocks.issueAuthTicket).toHaveBeenCalledWith('guest-1', ROUND_ID)
  })

  it('collapses a concurrent double-begin via the unique email index (E11000 → reuse)', async () => {
    mocks.verifyRoundToken.mockResolvedValue(okRound())
    mocks.userFindOne
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce({ _id: { toString: () => 'guest-race-winner' } })
    mocks.userCreate.mockRejectedValue(Object.assign(new Error('dup'), { code: 11000 }))

    const res = await begin(post({ token: TOKEN }), { params: { roundId: ROUND_ID } })
    expect(res.status).toBe(200)
    expect(mocks.issueAuthTicket).toHaveBeenCalledWith('guest-race-winner', ROUND_ID)
  })

  it('propagates a consent-stage 410 (link died between verify and consent)', async () => {
    mocks.verifyRoundToken.mockResolvedValue(okRound())
    mocks.recordConsent.mockRejectedValue(new AppError('gone', 410, 'ROUND_LINK_INVALID'))
    const res = await begin(post({ token: TOKEN }), { params: { roundId: ROUND_ID } })
    expect(res.status).toBe(410)
    expect(mocks.userCreate).not.toHaveBeenCalled()
  })

  it('503s when the ticket store is unavailable', async () => {
    mocks.verifyRoundToken.mockResolvedValue(okRound())
    mocks.userFindOne.mockResolvedValue({ _id: { toString: () => 'guest-1' } })
    mocks.issueAuthTicket.mockResolvedValue(null)
    const res = await begin(post({ token: TOKEN }), { params: { roundId: ROUND_ID } })
    expect(res.status).toBe(503)
  })

  it('rejects malformed tokens at the schema boundary', async () => {
    const res = await begin(post({ token: 'short' }), { params: { roundId: ROUND_ID } })
    expect(res.status).toBe(400)
    expect(mocks.verifyRoundToken).not.toHaveBeenCalled()
  })
})
