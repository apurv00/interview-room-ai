import { describe, it, expect, vi, beforeEach } from 'vitest'
import crypto from 'crypto'

vi.mock('@shared/db/connection', () => ({
  connectDB: vi.fn().mockResolvedValue(undefined),
}))
vi.mock('@shared/logger', () => ({
  logger: { warn: vi.fn(), error: vi.fn(), info: vi.fn() },
}))
const mockAppendEvent = vi.fn().mockResolvedValue(undefined)
vi.mock('../services/pipelineService', () => ({
  appendApplicationEvent: (...a: unknown[]) => mockAppendEvent(...a),
}))

const mockSessionFind = vi.fn()
const mockSessionFindById = vi.fn()
vi.mock('@shared/db/models', () => ({
  InterviewSession: {
    find: (...a: unknown[]) => mockSessionFind(...a),
    findById: (...a: unknown[]) => mockSessionFindById(...a),
  },
  User: {},
}))

const mockRound = { find: vi.fn(), findOneAndUpdate: vi.fn(), updateOne: vi.fn() }
vi.mock('../models', () => ({
  HireRound: {
    find: (...a: unknown[]) => mockRound.find(...a),
    findOneAndUpdate: (...a: unknown[]) => mockRound.findOneAndUpdate(...a),
    updateOne: (...a: unknown[]) => mockRound.updateOne(...a),
  },
}))

import { buildResultsSnapshot, reconcileApplicationRounds } from '../services/roundLinkService'

const sha256 = (s: string) => crypto.createHash('sha256').update(s).digest('hex')

function chainTo(value: unknown) {
  return {
    sort: () => ({ select: () => ({ lean: () => Promise.resolve(value) }) }),
    select: () => ({ lean: () => Promise.resolve(value) }),
  }
}

beforeEach(() => {
  vi.clearAllMocks()
})

describe('buildResultsSnapshot', () => {
  it('maps feedback + per-question evaluations, null-safe (no silent zeros)', () => {
    const snap = buildResultsSnapshot({
      _id: { toString: () => 's1' },
      status: 'completed',
      createdAt: new Date(),
      feedback: {
        overall_score: 82,
        pass_probability: 'High',
        confidence_level: 'Medium',
        dimensions: { answer_quality: { score: 78 }, communication: { score: 71 } },
        jd_match_score: 66,
        red_flags: ['Vague ownership on project X'],
        top_3_improvements: ['Quantify outcomes'],
      },
      evaluations: [
        {
          questionIndex: 0,
          question: 'Tell me about a conflict.',
          answer: 'Full answer text',
          relevance: 80,
          structure: 60,
          specificity: null,
          ownership: 70,
          jdAlignment: 55,
          flags: ['rambling'],
        },
      ],
      answeredCount: 5,
      plannedQuestionCount: 6,
      endReason: 'time_up',
      completedAt: new Date(),
    })

    expect(snap.overallScore).toBe(82)
    expect(snap.passProbability).toBe('High')
    expect(snap.jdMatchScore).toBe(66)
    expect(snap.pending).toBe(false)
    const q = snap.perQuestion![0]
    // Mean over AVAILABLE dims only: (80+60+70)/3 = 70 — a null dim is
    // excluded, never coerced to 0 (the G-series silent-zero lesson).
    expect(q.score).toBe(70)
    expect(q.specificity).toBeNull()
    expect(q.jdAlignment).toBe(55)
  })

  it('maps the engine\'s unscored sentinels (all-zero shape) to null + unscored — never "AI 0"', () => {
    const snap = buildResultsSnapshot({
      _id: { toString: () => 's1' },
      status: 'completed',
      createdAt: new Date(),
      feedback: {
        overall_score: 0,
        pass_probability: 'Low',
        confidence_level: 'Low',
        dimensions: {
          answer_quality: { score: 0, strengths: [], weaknesses: ['Answered 2 of 6 planned — not enough to score.'] },
          communication: { score: 0, wpm: 0, filler_rate: 0, pause_score: 0, rambling_index: 0 },
        },
        red_flags: ['Interview ended after 2 answers'],
      },
      evaluations: [{ questionIndex: 0, question: 'Q', relevance: 70, structure: 60, specificity: 65, ownership: 70 }],
    })
    expect(snap.unscored).toBe(true)
    expect(snap.overallScore).toBeNull()
    expect(snap.answerQualityScore).toBeNull()
    expect(snap.communicationScore).toBeNull()
    expect(snap.passProbability).toBeUndefined()
    // The engine's explanation survives; real per-answer scores survive.
    expect(snap.redFlags).toEqual(['Interview ended after 2 answers'])
    expect(snap.perQuestion![0].score).toBe(66)
  })

  it('a genuine low score is NOT mistaken for the unscored sentinel', () => {
    const snap = buildResultsSnapshot({
      _id: { toString: () => 's1' },
      status: 'completed',
      createdAt: new Date(),
      feedback: {
        overall_score: 0,
        dimensions: { answer_quality: { score: 12 }, communication: { score: 8 } },
      },
      evaluations: [],
    })
    expect(snap.unscored).toBeUndefined()
    expect(snap.overallScore).toBe(0)
  })

  it('marks the snapshot pending when session-level feedback is absent', () => {
    const snap = buildResultsSnapshot({
      _id: { toString: () => 's1' },
      status: 'completed',
      createdAt: new Date(),
      feedback: null,
      evaluations: [{ questionIndex: 0, question: 'Q', relevance: 50 }],
    })
    expect(snap.pending).toBe(true)
    expect(snap.overallScore).toBeNull()
    expect(snap.perQuestion![0].score).toBe(50)
  })

  it('suppresses the fabricated numbers of FAILED evaluations (keeps the Q&A visible)', () => {
    const snap = buildResultsSnapshot({
      _id: { toString: () => 's1' },
      status: 'completed',
      createdAt: new Date(),
      feedback: { overall_score: 70 },
      evaluations: [
        {
          questionIndex: 0,
          question: 'Q1',
          answer: 'The answer text',
          // The engine persists fallback placeholders on failure — its own
          // aggregates exclude these rows (G.4); hiring evidence must too.
          status: 'failed',
          relevance: 60,
          structure: 55,
          specificity: 55,
          ownership: 60,
        },
        { questionIndex: 1, question: 'Q2', relevance: 80, structure: 70, specificity: 75, ownership: 85 },
      ],
    })
    const failed = snap.perQuestion![0]
    expect(failed.evaluationFailed).toBe(true)
    expect(failed.score).toBeNull()
    expect(failed.relevance).toBeNull()
    expect(failed.ownership).toBeNull()
    expect(failed.answer).toBe('The answer text')
    const ok = snap.perQuestion![1]
    expect(ok.evaluationFailed).toBeUndefined()
    expect(ok.score).toBe(78)
  })
})

describe('reconcileApplicationRounds', () => {
  const PREPARED_AT = new Date(Date.now() - 3600_000)
  const round = (over: Record<string, unknown> = {}) => ({
    _id: { toString: () => 'r1' },
    status: 'prepared',
    kind: 'ai',
    guestUserId: 'guest-1',
    preparedAt: PREPARED_AT,
    jdHash: sha256('The JD'),
    config: { role: 'Backend Engineer', interviewType: 'behavioral', experience: '3-6', duration: 15 },
    sessionId: undefined,
    results: undefined,
    ...over,
  })
  const session = (over: Record<string, unknown> = {}) => ({
    _id: { toString: () => 's1' },
    status: 'completed',
    createdAt: new Date(),
    config: { role: 'Backend Engineer' },
    jobDescription: 'The JD',
    feedback: { overall_score: 75 },
    evaluations: [],
    ...over,
  })

  it('links the matching completed session with an atomic unclaimed-only update', async () => {
    mockRound.find.mockResolvedValue([round()])
    mockSessionFind.mockReturnValue(chainTo([session()]))
    mockRound.findOneAndUpdate.mockResolvedValue({ _id: 'r1' })

    const result = await reconcileApplicationRounds('ws-A', 'a1')
    // The claimed round's guest is reported for retirement (budget → 0 in
    // the app layer) so month-boundary counter resets can't re-arm it.
    expect(result.completedGuestUserIds).toEqual(['guest-1'])

    const [sessionFilter] = mockSessionFind.mock.calls[0]
    expect(sessionFilter.userId).toBe('guest-1')
    expect(sessionFilter.createdAt.$gte).toBe(PREPARED_AT)

    const [claimFilter, claimUpdate] = mockRound.findOneAndUpdate.mock.calls[0]
    expect(claimFilter).toMatchObject({ workspaceId: 'ws-A', sessionId: { $exists: false } })
    expect(claimUpdate.$set.status).toBe('completed')
    expect(claimUpdate.$set.results.overallScore).toBe(75)
    expect(claimUpdate.$unset).toEqual({ live: 1 })
    expect(mockAppendEvent).toHaveBeenCalledWith(
      'ws-A',
      'a1',
      expect.objectContaining({ type: 'ai_result_linked', actorName: 'System' })
    )
  })

  it('ignores sessions whose role or JD hash does not match the round', async () => {
    mockRound.find.mockResolvedValue([round()])
    mockSessionFind.mockReturnValue(
      chainTo([
        session({ config: { role: 'Other Role' } }),
        session({ jobDescription: 'Different JD' }),
      ])
    )
    await reconcileApplicationRounds('ws-A', 'a1')
    expect(mockRound.findOneAndUpdate).not.toHaveBeenCalled()
  })

  it('reports in-progress matches as transient activity without claiming', async () => {
    mockRound.find.mockResolvedValue([round()])
    mockSessionFind.mockReturnValue(chainTo([session({ status: 'in_progress' })]))
    const result = await reconcileApplicationRounds('ws-A', 'a1')
    expect(result.activity).toEqual([{ roundId: 'r1', inProgress: true }])
    expect(result.completedGuestUserIds).toEqual([])
    expect(mockRound.findOneAndUpdate).not.toHaveBeenCalled()
  })

  it('persists attemptCount so retries are visible on the card, never silently absorbed', async () => {
    mockRound.find.mockResolvedValue([round()])
    mockSessionFind.mockReturnValue(
      chainTo([
        session({ status: 'in_progress' }),
        session({ _id: { toString: () => 's2' } }),
      ])
    )
    mockRound.findOneAndUpdate.mockResolvedValue({ _id: 'r1' })
    await reconcileApplicationRounds('ws-A', 'a1')
    const attemptUpdate = mockRound.updateOne.mock.calls.find(
      ([, update]) => update.$set?.attemptCount !== undefined
    )
    expect(attemptUpdate).toBeDefined()
    expect(attemptUpdate![1].$set.attemptCount).toBe(2)
  })

  it('on a duplicate-claim race (E11000) it tries the next candidate session', async () => {
    mockRound.find.mockResolvedValue([round()])
    mockSessionFind.mockReturnValue(
      chainTo([session(), session({ _id: { toString: () => 's2' } })])
    )
    mockRound.findOneAndUpdate.mockRejectedValueOnce(
      Object.assign(new Error('dup'), { code: 11000 })
    )
    mockRound.findOneAndUpdate.mockResolvedValueOnce({ _id: 'r1' })

    await reconcileApplicationRounds('ws-A', 'a1')
    expect(mockRound.findOneAndUpdate).toHaveBeenCalledTimes(2)
  })

  it('refreshes a pending snapshot once feedback lands', async () => {
    mockRound.find.mockResolvedValue([
      round({ sessionId: '.session-1', results: { overallScore: null, pending: true } }),
    ])
    mockSessionFindById.mockReturnValue({
      select: () => ({
        lean: () => Promise.resolve(session({ feedback: { overall_score: 81 } })),
      }),
    })
    await reconcileApplicationRounds('ws-A', 'a1')
    const [filter, update] = mockRound.updateOne.mock.calls[0]
    expect(filter).toMatchObject({ workspaceId: 'ws-A' })
    expect(update.$set.results.overallScore).toBe(81)
    expect(update.$set.results.pending).toBe(false)
  })

  it('skips rounds that never reached prepare', async () => {
    mockRound.find.mockResolvedValue([
      round({ preparedAt: undefined }),
      round({ guestUserId: undefined }),
    ])
    await reconcileApplicationRounds('ws-A', 'a1')
    expect(mockSessionFind).not.toHaveBeenCalled()
  })

  it('flags a completion that happened AFTER the revoke — never silently untracked', async () => {
    const revokedAt = new Date(Date.now() - 3600_000)
    mockRound.find.mockResolvedValue([round({ status: 'revoked', revokedAt })])
    mockSessionFind.mockReturnValue(
      chainTo([session({ completedAt: new Date() })]) // completed an hour after revoke
    )
    mockRound.findOneAndUpdate.mockResolvedValue({ _id: 'r1' })

    await reconcileApplicationRounds('ws-A', 'a1')
    const [, update] = mockRound.findOneAndUpdate.mock.calls[0]
    expect(update.$set.results.completedAfterRevoke).toBe(true)
    // The round stays administratively revoked — results attached, status kept.
    expect(update.$set.status).toBeUndefined()
    expect(mockAppendEvent).toHaveBeenCalledWith(
      'ws-A',
      'a1',
      expect.objectContaining({
        type: 'ai_result_linked',
        note: expect.stringContaining('AFTER the link was revoked'),
      })
    )
  })

  it('a completion BEFORE the revoke is a normal completion — no false flag (timestamps compared)', async () => {
    const revokedAt = new Date(Date.now() - 3600_000)
    mockRound.find.mockResolvedValue([round({ status: 'revoked', revokedAt })])
    mockSessionFind.mockReturnValue(
      chainTo([session({ completedAt: new Date(Date.now() - 2 * 3600_000) })]) // done BEFORE revoke
    )
    mockRound.findOneAndUpdate.mockResolvedValue({ _id: 'r1' })

    await reconcileApplicationRounds('ws-A', 'a1')
    const [, update] = mockRound.findOneAndUpdate.mock.calls[0]
    expect(update.$set.results.completedAfterRevoke).toBeUndefined()
    expect(update.$set.status).toBe('completed')
    expect(mockAppendEvent).toHaveBeenCalledWith(
      'ws-A',
      'a1',
      expect.objectContaining({ note: 'AI interview completed — results attached' })
    )
  })

  it('keeps counting attempts for already-linked rounds (second-device retakes stay visible)', async () => {
    mockRound.find.mockResolvedValue([
      round({ sessionId: '.session-1', results: { overallScore: 80, pending: false }, attemptCount: 1 }),
    ])
    mockSessionFind.mockReturnValue(
      chainTo([session(), session({ _id: { toString: () => 's2' }, status: 'in_progress' })])
    )
    const result = await reconcileApplicationRounds('ws-A', 'a1')
    // Idempotent retirement: an ALREADY-linked round re-reports its guest on
    // every pass, so a previously-failed budget retirement heals itself.
    expect(result.completedGuestUserIds).toEqual(['guest-1'])
    const attemptUpdate = mockRound.updateOne.mock.calls.find(
      ([, update]) => update.$set?.attemptCount !== undefined
    )
    expect(attemptUpdate![1].$set.attemptCount).toBe(2)
    // Linked round: no re-claim attempted.
    expect(mockRound.findOneAndUpdate).not.toHaveBeenCalled()
  })
})
