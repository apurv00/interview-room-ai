/**
 * Contract tests for GET /api/interviews/last-same-domain-feedback.
 *
 * Pathway P2 Wave 1 (feature A) — this route powers the Pre-interview
 * Coach Card on the Setup page. The contract that matters:
 *
 *   1. Unauthorized when no session
 *   2. 400 when domain is missing
 *   3. Returns `{ feedback: null }` when no same-domain completed history
 *   4. Returns top_3_improvements (capped at 3) when history exists
 *   5. Excludes degraded feedback (synthetic scores from LLM failure
 *      fallback would mislead the coach card)
 *   6. Scopes the Mongo filter to the authenticated user's userId
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'
import { NextRequest } from 'next/server'
import mongoose from 'mongoose'

const { mockGetServerSession } = vi.hoisted(() => ({
  mockGetServerSession: vi.fn(),
}))
vi.mock('next-auth', () => ({
  getServerSession: (...args: unknown[]) => mockGetServerSession(...args),
}))

vi.mock('@shared/auth/authOptions', () => ({
  authOptions: {},
}))

vi.mock('@shared/db/connection', () => ({
  connectDB: vi.fn().mockResolvedValue(undefined),
}))

const { mockFindOne } = vi.hoisted(() => ({
  mockFindOne: vi.fn(),
}))
vi.mock('@shared/db/models', () => ({
  InterviewSession: {
    findOne: (...args: unknown[]) => mockFindOne(...args),
  },
}))

vi.mock('@shared/logger', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}))

import { GET } from '../route'

const USER_ID = new mongoose.Types.ObjectId().toString()
const SESSION_ID = new mongoose.Types.ObjectId()

function buildChain(result: unknown) {
  return {
    select: vi.fn().mockReturnThis(),
    sort: vi.fn().mockReturnThis(),
    lean: vi.fn().mockResolvedValue(result),
  }
}

beforeEach(() => {
  mockGetServerSession.mockReset()
  mockFindOne.mockReset()
})

describe('GET /api/interviews/last-same-domain-feedback', () => {
  it('returns 401 when not signed in', async () => {
    mockGetServerSession.mockResolvedValue(null)
    const req = new NextRequest('http://localhost/api/interviews/last-same-domain-feedback?domain=software-engineer')

    const res = await GET(req)
    const body = await res.json()

    expect(res.status).toBe(401)
    expect(body.error).toBe('Unauthorized')
  })

  it('returns 400 when domain query param is missing', async () => {
    mockGetServerSession.mockResolvedValue({ user: { id: USER_ID } })
    const req = new NextRequest('http://localhost/api/interviews/last-same-domain-feedback')

    const res = await GET(req)
    const body = await res.json()

    expect(res.status).toBe(400)
    expect(body.error).toMatch(/domain/i)
  })

  it('returns { feedback: null } when no same-domain history exists', async () => {
    mockGetServerSession.mockResolvedValue({ user: { id: USER_ID } })
    mockFindOne.mockReturnValue(buildChain(null))
    const req = new NextRequest('http://localhost/api/interviews/last-same-domain-feedback?domain=software-engineer')

    const res = await GET(req)
    const body = await res.json()

    expect(res.status).toBe(200)
    expect(body.feedback).toBeNull()
  })

  it('returns the most recent same-domain top_3_improvements (capped at 3)', async () => {
    mockGetServerSession.mockResolvedValue({ user: { id: USER_ID } })
    mockFindOne.mockReturnValue(
      buildChain({
        _id: SESSION_ID,
        completedAt: new Date('2026-05-10T12:00:00Z'),
        config: { role: 'software-engineer', interviewType: 'behavioral' },
        feedback: {
          overall_score: 72,
          // 4 items — route must cap at 3
          top_3_improvements: [
            'Tighten STAR structure on system design questions.',
            'Quantify ownership claims more explicitly.',
            'Reduce filler words around transitions.',
            'Should not be returned — over the 3-item cap.',
          ],
        },
      }),
    )
    const req = new NextRequest('http://localhost/api/interviews/last-same-domain-feedback?domain=software-engineer')

    const res = await GET(req)
    const body = await res.json()

    expect(res.status).toBe(200)
    expect(body.feedback).toMatchObject({
      sessionId: SESSION_ID.toString(),
      domain: 'software-engineer',
      interviewType: 'behavioral',
      overallScore: 72,
    })
    expect(body.feedback.topImprovements).toHaveLength(3)
    expect(body.feedback.topImprovements[0]).toMatch(/STAR/)
  })

  it('scopes the query to the authenticated userId + non-degraded feedback', async () => {
    mockGetServerSession.mockResolvedValue({ user: { id: USER_ID } })
    mockFindOne.mockReturnValue(buildChain(null))
    const req = new NextRequest('http://localhost/api/interviews/last-same-domain-feedback?domain=product-manager')

    await GET(req)

    expect(mockFindOne).toHaveBeenCalledTimes(1)
    const filter = mockFindOne.mock.calls[0][0]
    // Filter must be scoped by userId so users can't pull other users' feedback
    expect(filter.userId).toBeDefined()
    expect(filter.userId.toString()).toBe(USER_ID)
    expect(filter['config.role']).toBe('product-manager')
    expect(filter.status).toBe('completed')
    expect(filter['feedback.degraded']).toEqual({ $ne: true })
  })

  it('Wave 2: priorTo bounds the search by completedAt of the named session', async () => {
    mockGetServerSession.mockResolvedValue({ user: { id: USER_ID } })
    const REF_SESSION = new mongoose.Types.ObjectId()
    const refCompletedAt = new Date('2026-05-15T10:00:00Z')

    // First call: fetch the reference session's completedAt
    // Second call: fetch the prior same-domain session
    mockFindOne
      .mockReturnValueOnce(buildChain({ completedAt: refCompletedAt }))
      .mockReturnValueOnce(
        buildChain({
          _id: SESSION_ID,
          completedAt: new Date('2026-05-10T12:00:00Z'),
          config: { role: 'software-engineer' },
          feedback: {
            overall_score: 60,
            top_3_improvements: ['Last time focus area'],
          },
        }),
      )

    const req = new NextRequest(
      `http://localhost/api/interviews/last-same-domain-feedback?domain=software-engineer&priorTo=${REF_SESSION.toString()}`,
    )
    const res = await GET(req)
    const body = await res.json()

    expect(res.status).toBe(200)
    expect(body.feedback).toMatchObject({
      sessionId: SESSION_ID.toString(),
      overallScore: 60,
      topImprovements: ['Last time focus area'],
    })

    // Second call must scope by completedAt < refCompletedAt AND exclude REF_SESSION
    const secondFilter = mockFindOne.mock.calls[1][0]
    expect(secondFilter._id).toEqual({ $ne: expect.any(mongoose.Types.ObjectId) })
    expect(secondFilter._id.$ne.toString()).toBe(REF_SESSION.toString())
    expect(secondFilter.completedAt).toEqual({ $lt: refCompletedAt })
  })

  it('Wave 2: invalid priorTo is ignored (route still returns most-recent)', async () => {
    mockGetServerSession.mockResolvedValue({ user: { id: USER_ID } })
    mockFindOne.mockReturnValue(buildChain(null))
    const req = new NextRequest(
      'http://localhost/api/interviews/last-same-domain-feedback?domain=software-engineer&priorTo=not-a-valid-objectid',
    )

    await GET(req)

    // Only one findOne call (the main query), no reference-session lookup
    expect(mockFindOne).toHaveBeenCalledTimes(1)
    const filter = mockFindOne.mock.calls[0][0]
    expect(filter._id).toBeUndefined()
    expect(filter.completedAt).toBeUndefined()
  })

  it('treats missing top_3_improvements array as no feedback', async () => {
    mockGetServerSession.mockResolvedValue({ user: { id: USER_ID } })
    mockFindOne.mockReturnValue(
      buildChain({
        _id: SESSION_ID,
        config: { role: 'software-engineer' },
        feedback: { overall_score: 60 }, // no top_3_improvements
      }),
    )
    const req = new NextRequest('http://localhost/api/interviews/last-same-domain-feedback?domain=software-engineer')

    const res = await GET(req)
    const body = await res.json()

    expect(res.status).toBe(200)
    expect(body.feedback).toBeNull()
  })
})
