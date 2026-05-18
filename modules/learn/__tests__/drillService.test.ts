/**
 * Tests for drillService — Wave 5 additions:
 *   - `getDrillHistory` now accepts optional competency filter and
 *     applies it at the DB layer (so `limit` applies to the
 *     post-filter count, not pre-filter)
 *   - `saveDrillAttempt` now persists the per-dimension `breakdown`
 *     field (5D); backwards-compat: callers may omit it
 *
 * Existing behaviour (delta computation, ObjectId conversion) also
 * locked here so it can't drift silently.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('@shared/db/connection', () => ({
  connectDB: vi.fn().mockResolvedValue(undefined),
}))
vi.mock('@shared/logger', () => ({
  aiLogger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}))

const { mockCreate, mockFind, mockSessionFind } = vi.hoisted(() => ({
  mockCreate: vi.fn().mockResolvedValue({ _id: 'drill-id' }),
  mockFind: vi.fn(),
  mockSessionFind: vi.fn(),
}))
vi.mock('@shared/db/models/DrillAttempt', () => ({
  DrillAttempt: {
    create: (...args: unknown[]) => mockCreate(...args),
    find: (...args: unknown[]) => mockFind(...args),
  },
}))
vi.mock('@shared/db/models/InterviewSession', () => ({
  InterviewSession: { find: (...args: unknown[]) => mockSessionFind(...args) },
}))

import { saveDrillAttempt, getDrillHistory, getWeakQuestions } from '../services/drillService'

const USER_ID = '507f1f77bcf86cd799439099'
const SESSION_ID = '507f1f77bcf86cd799439077'

beforeEach(() => {
  mockCreate.mockClear()
  mockFind.mockReset()
  mockSessionFind.mockReset()
})

/** Build the chain that `InterviewSession.find(...).sort(...).limit(...).select(...).lean()` returns. */
function mockSessionsReturning(sessions: unknown[]) {
  mockSessionFind.mockReturnValue({
    sort: () => ({
      limit: () => ({
        select: () => ({
          lean: async () => sessions,
        }),
      }),
    }),
  })
}

function mkEval(qIdx: number, question: string, scores: { r: number; s: number; sp: number; o: number }) {
  return {
    questionIndex: qIdx,
    question,
    answer: 'a',
    relevance: scores.r,
    structure: scores.s,
    specificity: scores.sp,
    ownership: scores.o,
  }
}

describe('saveDrillAttempt (Wave 5 breakdown)', () => {
  it('persists breakdown when caller provides it', async () => {
    await saveDrillAttempt(USER_ID, {
      sessionId: SESSION_ID,
      questionIndex: 0,
      question: 'Tell me about a leadership moment.',
      originalAnswer: 'old',
      originalScore: 40,
      newAnswer: 'new',
      newScore: 70,
      competency: 'specificity',
      breakdown: { relevance: 80, structure: 65, specificity: 65, ownership: 70 },
    })
    expect(mockCreate).toHaveBeenCalledTimes(1)
    const persisted = mockCreate.mock.calls[0][0]
    expect(persisted.breakdown).toEqual({
      relevance: 80,
      structure: 65,
      specificity: 65,
      ownership: 70,
    })
    expect(persisted.delta).toBe(30)
    expect(persisted.competency).toBe('specificity')
  })

  it('omits breakdown when caller does not provide it (backwards-compat)', async () => {
    await saveDrillAttempt(USER_ID, {
      sessionId: SESSION_ID,
      questionIndex: 0,
      question: 'Q',
      originalAnswer: 'old',
      originalScore: 50,
      newAnswer: 'new',
      newScore: 60,
      competency: 'relevance',
    })
    expect(mockCreate).toHaveBeenCalledTimes(1)
    const persisted = mockCreate.mock.calls[0][0]
    expect(persisted.breakdown).toBeUndefined()
    expect(persisted.delta).toBe(10)
  })
})

describe('getDrillHistory (Wave 5 competency filter)', () => {
  function attemptsChain(rows: unknown[]) {
    return {
      sort: vi.fn().mockReturnThis(),
      limit: vi.fn().mockReturnThis(),
      lean: vi.fn().mockResolvedValue(rows),
    }
  }

  it('applies a competency filter at the DB layer when provided', async () => {
    mockFind.mockReturnValue(attemptsChain([]))
    await getDrillHistory(USER_ID, 10, 'specificity')
    const filter = mockFind.mock.calls[0][0]
    expect(filter.competency).toBe('specificity')
  })

  it('does NOT add a competency filter when omitted', async () => {
    mockFind.mockReturnValue(attemptsChain([]))
    await getDrillHistory(USER_ID, 10)
    const filter = mockFind.mock.calls[0][0]
    expect(filter.competency).toBeUndefined()
  })

  it('passes through breakdown when present on the row, undefined when absent (mixed compat)', async () => {
    mockFind.mockReturnValue(
      attemptsChain([
        {
          _id: { toString: () => 'a1' },
          question: 'new q',
          originalScore: 50,
          newScore: 70,
          delta: 20,
          competency: 'specificity',
          createdAt: new Date('2026-05-17T00:00:00Z'),
          breakdown: { relevance: 75, structure: 60, specificity: 70, ownership: 75 },
        },
        {
          _id: { toString: () => 'a2' },
          question: 'old q',
          originalScore: 40,
          newScore: 50,
          delta: 10,
          competency: 'specificity',
          createdAt: new Date('2026-04-01T00:00:00Z'),
          // No breakdown — pre-Wave-5 row
        },
      ]),
    )
    const out = await getDrillHistory(USER_ID, 10, 'specificity')
    expect(out).toHaveLength(2)
    expect(out[0].breakdown).toBeTruthy()
    expect(out[1].breakdown).toBeUndefined()
  })

  it('returns [] on DB error (best-effort)', async () => {
    mockFind.mockImplementation(() => {
      throw new Error('boom')
    })
    const out = await getDrillHistory(USER_ID)
    expect(out).toEqual([])
  })
})

describe('getWeakQuestions (E1 cluster + count)', () => {
  // All scores below 60 → all included as weak. Cluster on normalized
  // question text. The dedup keeps the WORST-scoring attempt per
  // cluster and stamps `attemptCount` with the full cluster size.
  const SCORES_30 = { r: 30, s: 30, sp: 30, o: 30 } // avg 30
  const SCORES_40 = { r: 40, s: 40, sp: 40, o: 40 } // avg 40
  const SCORES_50 = { r: 50, s: 50, sp: 50, o: 50 } // avg 50

  it('clubs the same question across sessions and stamps attemptCount', async () => {
    mockSessionsReturning([
      {
        _id: { toString: () => 'sess-a' },
        createdAt: new Date('2026-05-01'),
        evaluations: [mkEval(0, 'Tell me about a time you led a team.', SCORES_50)],
      },
      {
        _id: { toString: () => 'sess-b' },
        createdAt: new Date('2026-05-02'),
        evaluations: [mkEval(0, 'Tell me about a time you led a team.', SCORES_40)],
      },
      {
        _id: { toString: () => 'sess-c' },
        createdAt: new Date('2026-05-03'),
        evaluations: [mkEval(0, 'Tell me about a time you led a team.', SCORES_30)],
      },
    ])

    const out = await getWeakQuestions(USER_ID, 20)
    expect(out).toHaveLength(1)
    expect(out[0].attemptCount).toBe(3)
    // Worst-scoring attempt is kept (matches the practice-mode
    // mental model: "drill where I'm weakest")
    expect(out[0].avgScore).toBe(30)
    expect(out[0].sessionId).toBe('sess-c')
  })

  it('clubs near-duplicates that differ only in trailing punctuation', async () => {
    // Two LLM-generated phrasings of the same question — the prior
    // .toLowerCase().trim() dedup let these through; the aggressive
    // normalizer (strip punctuation + collapse whitespace) catches
    // them.
    mockSessionsReturning([
      {
        _id: { toString: () => 'sess-a' },
        createdAt: new Date('2026-05-01'),
        evaluations: [mkEval(0, 'Tell me about a time you led a team.', SCORES_40)],
      },
      {
        _id: { toString: () => 'sess-b' },
        createdAt: new Date('2026-05-02'),
        evaluations: [mkEval(0, 'Tell me about a time you led a team', SCORES_30)],
      },
    ])

    const out = await getWeakQuestions(USER_ID, 20)
    expect(out).toHaveLength(1)
    expect(out[0].attemptCount).toBe(2)
  })

  it('treats different questions as separate clusters', async () => {
    mockSessionsReturning([
      {
        _id: { toString: () => 'sess-a' },
        createdAt: new Date('2026-05-01'),
        evaluations: [
          mkEval(0, 'Tell me about a time you led a team.', SCORES_40),
          mkEval(1, 'How do you handle conflicting priorities?', SCORES_30),
        ],
      },
    ])

    const out = await getWeakQuestions(USER_ID, 20)
    expect(out).toHaveLength(2)
    // Each cluster has 1 attempt
    expect(out.every((q) => q.attemptCount === 1)).toBe(true)
  })

  it('handles case + whitespace + punctuation variants together', async () => {
    mockSessionsReturning([
      {
        _id: { toString: () => 'sess-a' },
        createdAt: new Date('2026-05-01'),
        evaluations: [mkEval(0, "What's your biggest weakness?", SCORES_40)],
      },
      {
        _id: { toString: () => 'sess-b' },
        createdAt: new Date('2026-05-02'),
        evaluations: [mkEval(0, 'WHATS YOUR  BIGGEST WEAKNESS', SCORES_30)],
      },
    ])

    const out = await getWeakQuestions(USER_ID, 20)
    expect(out).toHaveLength(1)
    expect(out[0].attemptCount).toBe(2)
    expect(out[0].avgScore).toBe(30)
  })

  it('excludes questions scoring >= 60', async () => {
    mockSessionsReturning([
      {
        _id: { toString: () => 'sess-a' },
        createdAt: new Date('2026-05-01'),
        evaluations: [
          mkEval(0, 'Strong answer Q', { r: 80, s: 80, sp: 80, o: 80 }),
          mkEval(1, 'Weak Q', SCORES_30),
        ],
      },
    ])

    const out = await getWeakQuestions(USER_ID, 20)
    expect(out).toHaveLength(1)
    expect(out[0].question).toBe('Weak Q')
  })

  it('still applies the competency filter on the weakest dim', async () => {
    mockSessionsReturning([
      {
        _id: { toString: () => 'sess-a' },
        createdAt: new Date('2026-05-01'),
        evaluations: [
          // weakest = relevance
          mkEval(0, 'Q1', { r: 20, s: 50, sp: 50, o: 50 }),
          // weakest = structure
          mkEval(1, 'Q2', { r: 50, s: 20, sp: 50, o: 50 }),
        ],
      },
    ])

    const out = await getWeakQuestions(USER_ID, 20, 'structure')
    expect(out).toHaveLength(1)
    expect(out[0].question).toBe('Q2')
  })

  it('respects the limit after clustering', async () => {
    mockSessionsReturning([
      {
        _id: { toString: () => 'sess-a' },
        createdAt: new Date('2026-05-01'),
        evaluations: [
          mkEval(0, 'Q1', SCORES_30),
          mkEval(1, 'Q2', SCORES_30),
          mkEval(2, 'Q3', SCORES_30),
        ],
      },
    ])

    const out = await getWeakQuestions(USER_ID, 2)
    expect(out).toHaveLength(2)
  })

  it('returns [] on DB error (best-effort)', async () => {
    mockSessionFind.mockImplementation(() => {
      throw new Error('boom')
    })
    const out = await getWeakQuestions(USER_ID)
    expect(out).toEqual([])
  })
})
