/**
 * @vitest-environment node
 *
 * P1 fix (Codex review on PR #313): the PATCH handler at
 * `app/api/interviews/[id]/route.ts` awarded `interview_complete` XP +
 * streak + badges on every PATCH that carried `status: 'completed'`. It
 * had no idempotency guard.
 *
 * Pre-PR-313 this wasn't exploitable because the `/api/generate-feedback`
 * outer-catch persisted its synthetic fallback, so reloading the feedback
 * page found `session.feedback` populated and short-circuited re-entry
 * (`app/feedback/[sessionId]/page.tsx:402`). The PATCH fired once per
 * session.
 *
 * Post-PR-313 the outer-catch no longer persists. A session where feedback
 * generation hits the outer catch therefore has `session.feedback ===
 * undefined`, so every reload re-enters `generateFeedback()` and
 * re-PATCHes `status: 'completed'`. Without this guard the user could
 * F5 through an LLM outage and farm XP + streak + badges without
 * completing any new interviews.
 *
 * Fix: read the pre-PATCH status and gate the engagement rewards block
 * on the TRANSITION into `completed`.
 *
 * Contract pinned by these tests:
 *   1. First PATCH with status:'completed' (session was 'in_progress')
 *      → rewards fire exactly once.
 *   2. Second PATCH with status:'completed' (session was already
 *      'completed') → rewards do NOT fire.
 *   3. Non-completion PATCHes (status:'in_progress' or omitted) never
 *      touch the rewards block.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { NextRequest } from 'next/server'

const { mockFindById, mockUpdateSession, mockAwardXp, mockRecordActivity, mockUpdateStreak, mockCheckBadges, mockFlushUsageBuffer } = vi.hoisted(() => ({
  mockFindById: vi.fn(),
  mockUpdateSession: vi.fn(),
  mockAwardXp: vi.fn(),
  mockRecordActivity: vi.fn(),
  mockUpdateStreak: vi.fn(),
  mockCheckBadges: vi.fn(),
  mockFlushUsageBuffer: vi.fn(),
}))

vi.mock('next-auth', () => ({
  getServerSession: vi.fn().mockResolvedValue({
    user: { id: '507f1f77bcf86cd799439099', role: 'candidate', organizationId: undefined },
  }),
}))

vi.mock('@shared/auth/authOptions', () => ({ authOptions: {} }))
vi.mock('@shared/logger', () => ({
  logger: { warn: vi.fn(), error: vi.fn(), info: vi.fn(), debug: vi.fn() },
}))

vi.mock('@interview/validators/interview', () => ({
  UpdateSessionSchema: {
    parse: (x: unknown) => x,
  },
}))
vi.mock('@interview/services/core/interviewService', () => ({
  getSession: vi.fn(),
  updateSession: (...args: unknown[]) => mockUpdateSession(...args),
}))

vi.mock('@shared/db/models', () => ({
  InterviewSession: {
    findById: (id: string) => ({
      select: () => ({
        lean: () => Promise.resolve(mockFindById(id)),
      }),
    }),
  },
}))
vi.mock('@learn/services/xpService', () => ({ awardXp: mockAwardXp }))
vi.mock('@learn/services/streakService', () => ({
  recordActivity: mockRecordActivity,
  updateStreak: mockUpdateStreak,
}))
vi.mock('@learn/services/badgeService', () => ({ checkAndAwardBadges: mockCheckBadges }))
vi.mock('@learn/config/xpTable', () => ({ XP_AMOUNTS: { interview_complete: 50 } }))
vi.mock('@shared/errors', () => ({ AppError: class AppError extends Error {} }))
vi.mock('@shared/services/accountDeletion', () => ({ deleteInterviewSession: vi.fn() }))
vi.mock('@shared/services/usageBuffer', () => ({
  flushUsageBuffer: (...args: unknown[]) => mockFlushUsageBuffer(...args),
}))

import { PATCH } from '@/app/api/interviews/[id]/route'

const VALID_ID = '507f1f77bcf86cd799439011'

function makeReq(body: Record<string, unknown>) {
  return new NextRequest(`http://localhost:3000/api/interviews/${VALID_ID}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
}

describe('PATCH /api/interviews/[id] — interview_complete rewards idempotency', () => {
  beforeEach(() => {
    mockFindById.mockReset()
    mockUpdateSession.mockReset()
    mockAwardXp.mockReset().mockResolvedValue({ newXp: 50, newLevel: 1, leveledUp: false, title: 'Novice' })
    mockRecordActivity.mockReset().mockResolvedValue(undefined)
    mockUpdateStreak.mockReset().mockResolvedValue({ currentStreak: 1 })
    mockCheckBadges.mockReset().mockResolvedValue([])
    mockFlushUsageBuffer.mockReset().mockResolvedValue(undefined)
    mockUpdateSession.mockResolvedValue({ _id: { toString: () => VALID_ID } })
  })

  it('fires rewards exactly once on the transition into completed', async () => {
    // Session was 'in_progress' before this PATCH — rewards should fire.
    mockFindById.mockResolvedValueOnce({ status: 'in_progress' })

    const res = await PATCH(makeReq({ status: 'completed', completedAt: new Date().toISOString() }), { params: { id: VALID_ID } })

    expect(res.status).toBe(200)
    expect(mockAwardXp).toHaveBeenCalledTimes(1)
    expect(mockAwardXp).toHaveBeenCalledWith(
      '507f1f77bcf86cd799439099',
      'interview_complete',
      50,
      { sessionId: VALID_ID },
    )
    expect(mockRecordActivity).toHaveBeenCalledTimes(1)
    expect(mockUpdateStreak).toHaveBeenCalledTimes(1)
    expect(mockCheckBadges).toHaveBeenCalledTimes(1)
  })

  it('does NOT fire rewards when the session is already completed (degraded reload scenario)', async () => {
    // Session was already 'completed' — this is a re-PATCH (degraded
    // reload, Retry Save, double-submit). Rewards must NOT re-fire.
    // This is the exact F5-XP-farm scenario Codex flagged on PR #313.
    mockFindById.mockResolvedValueOnce({ status: 'completed' })

    const res = await PATCH(makeReq({ status: 'completed', completedAt: new Date().toISOString() }), { params: { id: VALID_ID } })

    expect(res.status).toBe(200)
    expect(mockAwardXp).not.toHaveBeenCalled()
    expect(mockRecordActivity).not.toHaveBeenCalled()
    expect(mockUpdateStreak).not.toHaveBeenCalled()
    expect(mockCheckBadges).not.toHaveBeenCalled()
    // Usage buffer flush is intentionally idempotent and still runs — it
    // writes staged usage records keyed by sessionId, so re-flushing is a
    // no-op (the buffer is drained by the first call).
    expect(mockFlushUsageBuffer).toHaveBeenCalledTimes(1)
  })

  it('does NOT query existing status or fire rewards on a non-completion PATCH', async () => {
    // A PATCH that doesn't flip status to 'completed' (e.g. adding a
    // durationActualSeconds update, or an in-flight 'in_progress' refresh)
    // must skip the findById roundtrip AND the rewards block entirely.
    const res = await PATCH(makeReq({ durationActualSeconds: 1200 }), { params: { id: VALID_ID } })

    expect(res.status).toBe(200)
    expect(mockFindById).not.toHaveBeenCalled()
    expect(mockAwardXp).not.toHaveBeenCalled()
    expect(mockFlushUsageBuffer).not.toHaveBeenCalled()
  })

  it('fires rewards exactly once across sequential reloads of a degraded session', async () => {
    // End-to-end regression guard for the exact F5 scenario: first load
    // transitions to completed and awards XP; every subsequent reload
    // sees already-completed and must be a no-op on rewards.
    mockFindById
      .mockResolvedValueOnce({ status: 'in_progress' }) // first PATCH
      .mockResolvedValueOnce({ status: 'completed' })   // second PATCH (reload)
      .mockResolvedValueOnce({ status: 'completed' })   // third PATCH (another reload)

    await PATCH(makeReq({ status: 'completed', completedAt: new Date().toISOString() }), { params: { id: VALID_ID } })
    await PATCH(makeReq({ status: 'completed', completedAt: new Date().toISOString() }), { params: { id: VALID_ID } })
    await PATCH(makeReq({ status: 'completed', completedAt: new Date().toISOString() }), { params: { id: VALID_ID } })

    expect(mockAwardXp).toHaveBeenCalledTimes(1)
    expect(mockRecordActivity).toHaveBeenCalledTimes(1)
    expect(mockUpdateStreak).toHaveBeenCalledTimes(1)
    expect(mockCheckBadges).toHaveBeenCalledTimes(1)
  })
})
