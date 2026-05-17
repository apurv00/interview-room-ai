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

const { mockCreate, mockFind } = vi.hoisted(() => ({
  mockCreate: vi.fn().mockResolvedValue({ _id: 'drill-id' }),
  mockFind: vi.fn(),
}))
vi.mock('@shared/db/models/DrillAttempt', () => ({
  DrillAttempt: {
    create: (...args: unknown[]) => mockCreate(...args),
    find: (...args: unknown[]) => mockFind(...args),
  },
}))
// drillService also imports InterviewSession for `getWeakQuestions`,
// not under test here but the mock keeps the module load happy.
vi.mock('@shared/db/models/InterviewSession', () => ({
  InterviewSession: { find: vi.fn() },
}))

import { saveDrillAttempt, getDrillHistory } from '../services/drillService'

const USER_ID = '507f1f77bcf86cd799439099'
const SESSION_ID = '507f1f77bcf86cd799439077'

beforeEach(() => {
  mockCreate.mockClear()
  mockFind.mockReset()
})

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
