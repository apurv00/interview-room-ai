/**
 * Contract tests for GET /api/learn/drill/context/question.
 *
 * Pathway P2 Wave 5 (5B). Verifies the invariants that the drill page
 * relies on:
 *   1. Auth required
 *   2. Both query params required + validated (sessionId must be a
 *      valid ObjectId, questionIndex must be a non-negative integer)
 *   3. 404 (not 403) when the session belongs to a different user —
 *      we don't want to confirm existence to a cross-user probe
 *   4. Returns null `idealAnswer` when the session lacks it (older
 *      sessions pre-dating ideal-answer generation)
 *   5. Ships the 4-dim scores so the QuestionInsightStrip fallback
 *      can call deriveCoachingTip
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'
import { NextRequest } from 'next/server'
import mongoose from 'mongoose'

const { mockGetServerSession, mockFindOne } = vi.hoisted(() => ({
  mockGetServerSession: vi.fn(),
  mockFindOne: vi.fn(),
}))

vi.mock('next-auth', () => ({
  getServerSession: (...a: unknown[]) => mockGetServerSession(...a),
}))
vi.mock('@shared/auth/authOptions', () => ({ authOptions: {} }))
vi.mock('@shared/db/connection', () => ({
  connectDB: vi.fn().mockResolvedValue(undefined),
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
const SESSION_ID = new mongoose.Types.ObjectId().toString()

function chain(result: unknown) {
  return {
    select: vi.fn().mockReturnThis(),
    lean: vi.fn().mockResolvedValue(result),
  }
}

beforeEach(() => {
  mockGetServerSession.mockReset()
  mockFindOne.mockReset()
})

describe('GET /api/learn/drill/context/question', () => {
  it('401 when unauthenticated', async () => {
    mockGetServerSession.mockResolvedValue(null)
    const req = new NextRequest(
      `http://localhost/api/learn/drill/context/question?sessionId=${SESSION_ID}&questionIndex=0`,
    )
    const res = await GET(req)
    expect(res.status).toBe(401)
  })

  it('400 when sessionId is missing', async () => {
    mockGetServerSession.mockResolvedValue({ user: { id: USER_ID } })
    const req = new NextRequest(
      'http://localhost/api/learn/drill/context/question?questionIndex=0',
    )
    const res = await GET(req)
    expect(res.status).toBe(400)
  })

  it('400 when sessionId is not a valid ObjectId', async () => {
    mockGetServerSession.mockResolvedValue({ user: { id: USER_ID } })
    const req = new NextRequest(
      'http://localhost/api/learn/drill/context/question?sessionId=not-an-objectid&questionIndex=0',
    )
    const res = await GET(req)
    expect(res.status).toBe(400)
  })

  it('400 when questionIndex is missing or negative', async () => {
    mockGetServerSession.mockResolvedValue({ user: { id: USER_ID } })
    const missing = await GET(
      new NextRequest(
        `http://localhost/api/learn/drill/context/question?sessionId=${SESSION_ID}`,
      ),
    )
    expect(missing.status).toBe(400)

    const negative = await GET(
      new NextRequest(
        `http://localhost/api/learn/drill/context/question?sessionId=${SESSION_ID}&questionIndex=-1`,
      ),
    )
    expect(negative.status).toBe(400)
  })

  it('404 when the session belongs to a different user (no existence-confirm leak)', async () => {
    mockGetServerSession.mockResolvedValue({ user: { id: USER_ID } })
    // findOne returns null because the {_id, userId} filter excludes
    // cross-user sessions.
    mockFindOne.mockReturnValue(chain(null))
    const req = new NextRequest(
      `http://localhost/api/learn/drill/context/question?sessionId=${SESSION_ID}&questionIndex=0`,
    )
    const res = await GET(req)
    expect(res.status).toBe(404)
  })

  it('happy path: returns primaryGap + scores + ideal answer', async () => {
    mockGetServerSession.mockResolvedValue({ user: { id: USER_ID } })
    mockFindOne.mockReturnValue(
      chain({
        config: { role: 'pm', interviewType: 'behavioral' },
        evaluations: [
          {
            questionIndex: 2,
            relevance: 60,
            structure: 70,
            specificity: 30,
            ownership: 80,
            primaryGap: 'specificity',
          },
        ],
        feedback: {
          ideal_answers: [
            {
              questionIndex: 2,
              strongAnswer: 'A strong answer with metrics...',
              keyElements: ['Use 1-2 concrete metrics', 'Name your specific contribution'],
            },
          ],
        },
      }),
    )

    const req = new NextRequest(
      `http://localhost/api/learn/drill/context/question?sessionId=${SESSION_ID}&questionIndex=2`,
    )
    const res = await GET(req)
    const body = await res.json()

    expect(res.status).toBe(200)
    expect(body.primaryGap).toBe('specificity')
    expect(body.scores).toEqual({
      relevance: 60,
      structure: 70,
      specificity: 30,
      ownership: 80,
    })
    expect(body.domain).toBe('pm')
    expect(body.interviewType).toBe('behavioral')
    expect(body.idealAnswer).toMatchObject({
      strongAnswer: expect.stringContaining('strong answer'),
      keyElements: expect.any(Array),
    })
  })

  it('returns null idealAnswer when session has no ideal_answers for this question', async () => {
    mockGetServerSession.mockResolvedValue({ user: { id: USER_ID } })
    mockFindOne.mockReturnValue(
      chain({
        config: { role: 'pm' },
        evaluations: [
          {
            questionIndex: 0,
            relevance: 60,
            structure: 50,
            specificity: 40,
            ownership: 70,
            primaryGap: 'specificity',
          },
        ],
        feedback: { ideal_answers: [] },
      }),
    )

    const req = new NextRequest(
      `http://localhost/api/learn/drill/context/question?sessionId=${SESSION_ID}&questionIndex=0`,
    )
    const res = await GET(req)
    const body = await res.json()

    expect(res.status).toBe(200)
    expect(body.idealAnswer).toBeNull()
    // Scores + primaryGap still flow through so the fallback strip works.
    expect(body.primaryGap).toBe('specificity')
    expect(body.scores).toBeTruthy()
  })
})
