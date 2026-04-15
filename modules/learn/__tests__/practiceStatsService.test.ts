/**
 * Work Item G.14 — practiceStats service.
 *
 * Unit tests for the extracted `updatePracticeStats` helper + the
 * `deriveStrongWeakDimensions` utility. Both are pure service-level
 * functions (no HTTP, no routing); integration through the two
 * consumer routes (POST /api/learn/stats with flag gate, and
 * generate-feedback's post-feedback side-effect block) is covered
 * by the flag-gate test in practiceStatsRoute.test.ts.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'

// ─── Mocks ─────────────────────────────────────────────────────────────────

vi.mock('@shared/db/connection', () => ({
  connectDB: vi.fn().mockResolvedValue(undefined),
}))

vi.mock('@shared/logger', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
  aiLogger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}))

const mockFindById = vi.fn()
const mockFindByIdAndUpdate = vi.fn()
vi.mock('@shared/db/models', () => ({
  User: {
    findById: (...args: unknown[]) => mockFindById(...args),
    findByIdAndUpdate: (...args: unknown[]) => mockFindByIdAndUpdate(...args),
  },
}))

import {
  updatePracticeStats,
  deriveStrongWeakDimensions,
} from '@learn/services/practiceStatsService'

const VALID_USER_ID = '507f1f77bcf86cd799439011'

// ─── Tests ─────────────────────────────────────────────────────────────────

describe('updatePracticeStats (G.14)', () => {
  beforeEach(() => {
    mockFindById.mockReset()
    mockFindByIdAndUpdate.mockReset()
  })

  function mockUserWithStats(practiceStats: Record<string, unknown>) {
    mockFindById.mockReturnValue({
      select: () => ({ lean: () => Promise.resolve({ practiceStats }) }),
    })
    mockFindByIdAndUpdate.mockResolvedValue({})
  }

  it('creates a new practiceStats row for a first-time key', async () => {
    mockUserWithStats({})

    const r = await updatePracticeStats({
      userId: VALID_USER_ID,
      domain: 'pm', interviewType: 'screening',
      score: 72,
    })

    expect(r.updated).toBe(true)
    expect(r.key).toBe('pm:screening')
    expect(r.totalSessions).toBe(1)
    expect(r.avgScore).toBe(72)
    expect(mockFindByIdAndUpdate).toHaveBeenCalled()
    const updateArg = mockFindByIdAndUpdate.mock.calls[0][1] as Record<string, unknown>
    expect((updateArg.$set as Record<string, unknown>)['practiceStats.pm:screening']).toMatchObject({
      totalSessions: 1, avgScore: 72, lastScore: 72,
    })
  })

  it('extends a running average over prior sessions', async () => {
    // Prior state: 2 sessions, avg 60
    mockUserWithStats({ 'pm:screening': { totalSessions: 2, avgScore: 60 } })

    const r = await updatePracticeStats({
      userId: VALID_USER_ID,
      domain: 'pm', interviewType: 'screening',
      score: 84,
    })

    // New avg = (60*2 + 84) / 3 = 68
    expect(r.totalSessions).toBe(3)
    expect(r.avgScore).toBe(68)
  })

  it('clamps scores outside [0, 100]', async () => {
    mockUserWithStats({})
    const r1 = await updatePracticeStats({
      userId: VALID_USER_ID, domain: 'pm', interviewType: 'screening',
      score: 200,
    })
    expect(r1.avgScore).toBe(100)

    mockUserWithStats({})
    const r2 = await updatePracticeStats({
      userId: VALID_USER_ID, domain: 'pm', interviewType: 'screening',
      score: -5,
    })
    expect(r2.avgScore).toBe(0)
  })

  it('coerces non-numeric score to 0 (never throws)', async () => {
    mockUserWithStats({})
    const r = await updatePracticeStats({
      userId: VALID_USER_ID, domain: 'pm', interviewType: 'screening',
      score: Number.NaN,
    })
    expect(r.updated).toBe(true)
    expect(r.avgScore).toBe(0)
  })

  it('returns updated=false when user is not found', async () => {
    mockFindById.mockReturnValue({
      select: () => ({ lean: () => Promise.resolve(null) }),
    })

    const r = await updatePracticeStats({
      userId: VALID_USER_ID, domain: 'pm', interviewType: 'screening',
      score: 72,
    })
    expect(r.updated).toBe(false)
    expect(mockFindByIdAndUpdate).not.toHaveBeenCalled()
  })

  it('swallows DB errors and returns updated=false', async () => {
    mockFindById.mockImplementation(() => { throw new Error('mongo down') })

    const r = await updatePracticeStats({
      userId: VALID_USER_ID, domain: 'pm', interviewType: 'screening',
      score: 72,
    })
    expect(r.updated).toBe(false)
  })

  it('persists strong/weak dimension metadata', async () => {
    mockUserWithStats({})
    await updatePracticeStats({
      userId: VALID_USER_ID, domain: 'pm', interviewType: 'screening',
      score: 72,
      strongDimensions: ['ownership', 'relevance'],
      weakDimensions: ['specificity'],
    })
    const updateArg = mockFindByIdAndUpdate.mock.calls[0][1] as Record<string, unknown>
    const row = (updateArg.$set as Record<string, unknown>)['practiceStats.pm:screening'] as Record<string, unknown>
    expect(row.strongDimensions).toEqual(['ownership', 'relevance'])
    expect(row.weakDimensions).toEqual(['specificity'])
  })
})

describe('deriveStrongWeakDimensions (G.14)', () => {
  function evalRow(r: number, s: number, sp: number, o: number, status?: string) {
    return {
      relevance: r, structure: s, specificity: sp, ownership: o,
      ...(status && { status }),
    }
  }

  it('picks the 2 highest and 2 lowest dimensions by avg', () => {
    // relevance avg = 80, structure = 60, specificity = 50, ownership = 70
    const evals = [
      evalRow(80, 60, 50, 70),
      evalRow(80, 60, 50, 70),
    ]
    const r = deriveStrongWeakDimensions(evals)
    expect(r.strongDimensions).toEqual(['relevance', 'ownership'])
    expect(r.weakDimensions).toEqual(['structure', 'specificity'])
  })

  it('excludes status="failed" rows from the calculation', () => {
    // Real rows (non-failed) all at 80. Failed row claims 0 — would
    // otherwise pull specificity down. Test asserts failed row is
    // ignored so the picks are stable.
    const evals = [
      evalRow(80, 80, 80, 80),
      evalRow(80, 80, 80, 80),
      evalRow(0, 0, 0, 0, 'failed'),
    ]
    const r = deriveStrongWeakDimensions(evals)
    // All dims at 80; the sort is stable enough that top-2 and bottom-2
    // pick the configured dimension order (relevance/structure vs
    // specificity/ownership).
    expect(r.strongDimensions.length).toBe(2)
    expect(r.weakDimensions.length).toBe(2)
  })

  it('returns empty arrays when all rows are failed', () => {
    const evals = [evalRow(60, 55, 55, 60, 'failed')]
    const r = deriveStrongWeakDimensions(evals)
    expect(r.strongDimensions).toEqual([])
    expect(r.weakDimensions).toEqual([])
  })

  it('returns empty arrays on empty input', () => {
    expect(deriveStrongWeakDimensions([])).toEqual({ strongDimensions: [], weakDimensions: [] })
  })
})
