/**
 * Tests for POST /api/learn/drill/evaluate — focused on the
 * malformed-scores fallback path.
 *
 * Codex P1 on PR #388 — the original `isFourDimScore` guard only
 * checked `typeof === 'number'`, which permits NaN, Infinity, and
 * out-of-range values like 105. The DrillAttempt.breakdown subdoc
 * enforces `min: 0, max: 100` per dim, so a malformed model output
 * passed the guard, got included in `saveDrillAttempt`, and failed
 * Mongoose validation on create — turning a "scoring drift" into a
 * 500 from the evaluate route.
 *
 * These tests lock the contract: when the LLM returns weird scores,
 * the route still completes the avg-only save (delta + newScore are
 * the higher-priority values) and just drops `breakdown` silently.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('next-auth', () => ({
  getServerSession: vi.fn().mockResolvedValue({ user: { id: 'user-1' } }),
}))
vi.mock('@shared/auth/authOptions', () => ({ authOptions: {} }))

const { mockSaveDrillAttempt, mockCompletion } = vi.hoisted(() => ({
  mockSaveDrillAttempt: vi.fn(),
  mockCompletion: vi.fn(),
}))
vi.mock('@learn/services/drillService', () => ({
  saveDrillAttempt: (...a: unknown[]) => mockSaveDrillAttempt(...a),
}))
vi.mock('@learn/services/xpService', () => ({
  awardXp: vi.fn().mockResolvedValue(undefined),
}))
vi.mock('@learn/services/streakService', () => ({
  recordActivity: vi.fn().mockResolvedValue(undefined),
  updateStreak: vi.fn().mockResolvedValue({ currentStreak: 1 }),
}))
vi.mock('@learn/services/badgeService', () => ({
  checkAndAwardBadges: vi.fn().mockResolvedValue(undefined),
}))
vi.mock('@learn/config/xpTable', () => ({
  XP_AMOUNTS: { drill_complete: 5 },
}))
vi.mock('@shared/services/modelRouter', () => ({
  completion: (...a: unknown[]) => mockCompletion(...a),
}))
vi.mock('@shared/services/promptSecurity', () => ({
  JSON_OUTPUT_RULE: 'Respond with ONLY valid JSON.',
}))
vi.mock('@shared/logger', () => ({
  aiLogger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}))

import { POST } from '../route'

function requestWith(body: Record<string, unknown>): Request {
  return new Request('http://localhost/api/learn/drill/evaluate', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
}

beforeEach(() => {
  mockSaveDrillAttempt.mockReset()
  mockSaveDrillAttempt.mockResolvedValue({
    questionIndex: 0,
    question: 'Q',
    originalScore: 40,
    newScore: 70,
    delta: 30,
    breakdown: { relevance: 80, structure: 65, specificity: 65, ownership: 70 },
  })
  mockCompletion.mockReset()
})

describe('POST /api/learn/drill/evaluate — Codex P1 malformed-scores fallback', () => {
  const baseBody = {
    sessionId: '507f1f77bcf86cd799439001',
    questionIndex: 0,
    question: 'Tell me about a leadership moment.',
    originalAnswer: 'old',
    originalScore: 40,
    newAnswer: 'new',
    competency: 'specificity',
  }

  it('persists breakdown when all 4 scores are valid 0-100 numbers', async () => {
    mockCompletion.mockResolvedValue({
      text: JSON.stringify({ relevance: 80, structure: 65, specificity: 65, ownership: 70 }),
    })

    const res = await POST(requestWith(baseBody))
    expect(res.status).toBe(200)
    expect(mockSaveDrillAttempt).toHaveBeenCalledTimes(1)
    const payload = mockSaveDrillAttempt.mock.calls[0][1]
    expect(payload.breakdown).toEqual({
      relevance: 80,
      structure: 65,
      specificity: 65,
      ownership: 70,
    })
  })

  it('drops breakdown silently when a score is NaN (typeof slips past naive check)', async () => {
    mockCompletion.mockResolvedValue({
      text: JSON.stringify({
        relevance: 80,
        structure: 65,
        specificity: Number.NaN,
        ownership: 70,
      }),
    })

    const res = await POST(requestWith(baseBody))
    expect(res.status).toBe(200)
    expect(mockSaveDrillAttempt).toHaveBeenCalledTimes(1)
    expect(mockSaveDrillAttempt.mock.calls[0][1].breakdown).toBeUndefined()
  })

  it('drops breakdown silently when a score is Infinity', async () => {
    // Plain JSON can't carry Infinity, so simulate the unparsed payload
    // by stubbing the model output via Number.POSITIVE_INFINITY at the
    // text layer. JSON.parse turns Infinity into null, which is also
    // rejected by isValidDimScore.
    mockCompletion.mockResolvedValue({
      text: '{"relevance":80,"structure":65,"specificity":null,"ownership":70}',
    })

    const res = await POST(requestWith(baseBody))
    expect(res.status).toBe(200)
    expect(mockSaveDrillAttempt.mock.calls[0][1].breakdown).toBeUndefined()
  })

  it('drops breakdown silently when a score is above 100 (schema range violation)', async () => {
    mockCompletion.mockResolvedValue({
      text: JSON.stringify({ relevance: 105, structure: 65, specificity: 65, ownership: 70 }),
    })

    const res = await POST(requestWith(baseBody))
    expect(res.status).toBe(200)
    expect(mockSaveDrillAttempt.mock.calls[0][1].breakdown).toBeUndefined()
  })

  it('drops breakdown silently when a score is below 0 (schema range violation)', async () => {
    mockCompletion.mockResolvedValue({
      text: JSON.stringify({ relevance: 80, structure: -5, specificity: 65, ownership: 70 }),
    })

    const res = await POST(requestWith(baseBody))
    expect(res.status).toBe(200)
    expect(mockSaveDrillAttempt.mock.calls[0][1].breakdown).toBeUndefined()
  })

  it('drops breakdown silently when a score is a string', async () => {
    mockCompletion.mockResolvedValue({
      text: JSON.stringify({ relevance: '80', structure: 65, specificity: 65, ownership: 70 }),
    })

    const res = await POST(requestWith(baseBody))
    expect(res.status).toBe(200)
    expect(mockSaveDrillAttempt.mock.calls[0][1].breakdown).toBeUndefined()
  })

  it('drops breakdown silently when a score is missing entirely', async () => {
    mockCompletion.mockResolvedValue({
      text: JSON.stringify({ relevance: 80, structure: 65, specificity: 65 /* no ownership */ }),
    })

    const res = await POST(requestWith(baseBody))
    expect(res.status).toBe(200)
    expect(mockSaveDrillAttempt.mock.calls[0][1].breakdown).toBeUndefined()
  })

  it('accepts boundary scores 0 and 100 (range is inclusive on both ends)', async () => {
    mockCompletion.mockResolvedValue({
      text: JSON.stringify({ relevance: 0, structure: 100, specificity: 50, ownership: 50 }),
    })

    const res = await POST(requestWith(baseBody))
    expect(res.status).toBe(200)
    expect(mockSaveDrillAttempt.mock.calls[0][1].breakdown).toEqual({
      relevance: 0,
      structure: 100,
      specificity: 50,
      ownership: 50,
    })
  })
})
