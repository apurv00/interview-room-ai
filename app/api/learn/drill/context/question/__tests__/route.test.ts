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

const { mockGetServerSession, mockFindOne, mockUpdateOne, mockInngestSend, mockGetDomainLabel } = vi.hoisted(() => ({
  mockGetServerSession: vi.fn(),
  mockFindOne: vi.fn(),
  mockUpdateOne: vi.fn().mockResolvedValue({ matchedCount: 1 }),
  // Default: backfill returns null so legacy tests (which exercised the
  // "no ideal answer" branch back when there was no JIT) stay no-ops.
  // Tests that want to assert backfill happened override per-case.
  mockInngestSend: vi.fn().mockResolvedValue(null),
  mockGetDomainLabel: vi.fn((role: string) => `Domain ${role}`),
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
    updateOne: (...args: unknown[]) => mockUpdateOne(...args),
  },
}))
vi.mock('@shared/logger', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}))
vi.mock('@shared/services/inngest', () => ({
  inngest: { send: (...a: unknown[]) => mockInngestSend(...a) },
}))
vi.mock('@interview/config/interviewConfig', () => ({
  getDomainLabel: (role: string) => mockGetDomainLabel(role),
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
  mockUpdateOne.mockReset().mockResolvedValue({ matchedCount: 1 })
  mockInngestSend.mockReset().mockResolvedValue({ ids: ['evt-1'] })
  mockGetDomainLabel.mockReset().mockImplementation((role: string) => `Domain ${role}`)
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

  it('returns fallback (null idealAnswer) and stays 200 when the enrichment enqueue fails', async () => {
    mockGetServerSession.mockResolvedValue({ user: { id: USER_ID } })
    mockInngestSend.mockRejectedValueOnce(new Error('inngest unavailable'))
    mockFindOne.mockReturnValue(
      chain({
        config: { role: 'pm' },
        evaluations: [
          {
            questionIndex: 0,
            question: 'Tell me about a time you owned an outcome',
            answer: 'I worked on a feature',
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
    await new Promise((r) => setImmediate(r))

    expect(res.status).toBe(200)
    expect(body.idealAnswer).toBeNull()
    expect(mockInngestSend).toHaveBeenCalledTimes(1)
    // Enqueue failed → no pending-status write.
    expect(mockUpdateOne).not.toHaveBeenCalled()
    // Scores + primaryGap still flow through so the fallback strip works.
    expect(body.primaryGap).toBe('specificity')
    expect(body.scores).toBeTruthy()
  })

  it('enqueues full-quality enrichment + marks pending for a weak uncached question (no blocking LLM call)', async () => {
    mockGetServerSession.mockResolvedValue({ user: { id: USER_ID } })
    mockFindOne.mockReturnValue(
      chain({
        config: { role: 'pm', interviewType: 'behavioral' },
        evaluations: [
          {
            questionIndex: 3,
            question: 'Walk me through a decision under constraint',
            answer: 'We had limited eng time and I picked the smaller feature',
            relevance: 50,
            structure: 40,
            specificity: 30,
            ownership: 45,
            primaryGap: 'specificity',
          },
        ],
        feedback: { ideal_answers: [] },
      }),
    )

    const req = new NextRequest(
      `http://localhost/api/learn/drill/context/question?sessionId=${SESSION_ID}&questionIndex=3`,
    )
    const res = await GET(req)
    const body = await res.json()
    await new Promise((r) => setImmediate(r))

    expect(res.status).toBe(200)
    // The old 6s user-blocking JIT call is gone: THIS request returns the
    // fallback immediately; the async job (reasoningEffort 'high') fills
    // the outline for the next visit.
    expect(body.idealAnswer).toBeNull()
    expect(mockInngestSend).toHaveBeenCalledTimes(1)
    expect(mockInngestSend.mock.calls[0][0]).toMatchObject({
      name: 'feedback/enrich.requested',
      data: { sessionId: SESSION_ID, userId: USER_ID, reason: 'drill-backfill', questionIndex: 3 },
    })
    expect(mockUpdateOne).toHaveBeenCalledTimes(1)
    const [, update] = mockUpdateOne.mock.calls[0]
    expect(update.$set.enrichmentStatus).toBe('pending')
  })

  it('does not enqueue when an enrichment job is already pending/running (dedupe)', async () => {
    mockGetServerSession.mockResolvedValue({ user: { id: USER_ID } })
    mockFindOne.mockReturnValue(
      chain({
        config: { role: 'pm' },
        enrichmentStatus: 'running',
        evaluations: [
          {
            questionIndex: 0,
            question: 'Weak question',
            answer: 'thin answer',
            relevance: 40,
            structure: 40,
            specificity: 30,
            ownership: 40,
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
    await new Promise((r) => setImmediate(r))

    expect(res.status).toBe(200)
    expect(mockInngestSend).not.toHaveBeenCalled()
    expect(mockUpdateOne).not.toHaveBeenCalled()
  })

  it('does NOT JIT-backfill when the question is not weak (avg >= 60)', async () => {
    mockGetServerSession.mockResolvedValue({ user: { id: USER_ID } })
    mockFindOne.mockReturnValue(
      chain({
        config: { role: 'pm' },
        evaluations: [
          {
            questionIndex: 0,
            question: 'Strong-answer question',
            answer: 'A solid answer with metrics',
            relevance: 80,
            structure: 75,
            specificity: 70,
            ownership: 65,
            primaryGap: 'ownership',
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
    // Strong question — outline is intentionally absent (avoids
    // diluting LLM focus per the batch-enrichment threshold).
    expect(mockInngestSend).not.toHaveBeenCalled()
    expect(mockUpdateOne).not.toHaveBeenCalled()
    expect(body.idealAnswer).toBeNull()
  })
})
