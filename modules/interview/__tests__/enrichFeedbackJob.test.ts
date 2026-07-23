import { describe, it, expect, vi, beforeEach } from 'vitest'

const {
  mockFindByIdAndUpdate,
  mockUpdateOne,
  mockFindOne,
  mockRunEnrichment,
  mockTrackUsage,
  mockFlushUsage,
} = vi.hoisted(() => ({
  mockFindByIdAndUpdate: vi.fn().mockResolvedValue(undefined),
  mockUpdateOne: vi.fn().mockResolvedValue({ modifiedCount: 1 }),
  mockFindOne: vi.fn(),
  mockRunEnrichment: vi.fn(),
  mockTrackUsage: vi.fn().mockResolvedValue(undefined),
  mockFlushUsage: vi.fn().mockResolvedValue(undefined),
}))

vi.mock('@shared/services/inngest', () => ({
  inngest: {
    send: vi.fn().mockResolvedValue({ ids: ['evt-1'] }),
    createFunction: (_cfg: unknown, handler: unknown) => ({ id: 'mock', handler }),
  },
}))
vi.mock('@shared/db/connection', () => ({ connectDB: vi.fn().mockResolvedValue(undefined) }))
vi.mock('@shared/db/models', () => ({
  InterviewSession: {
    findByIdAndUpdate: (...a: unknown[]) => mockFindByIdAndUpdate(...a),
    updateOne: (...a: unknown[]) => mockUpdateOne(...a),
    findOne: (...a: unknown[]) => mockFindOne(...a),
  },
}))
vi.mock('@shared/logger', () => ({
  aiLogger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}))
vi.mock('@shared/services/usageTracking', () => ({ trackUsage: mockTrackUsage }))
vi.mock('@shared/services/usageBuffer', () => ({ flushUsageBuffer: (...a: unknown[]) => mockFlushUsage(...a) }))
vi.mock('@interview/config/interviewConfig', () => ({ getDomainLabel: (r: string) => `Domain ${r}` }))
vi.mock('@interview/services/eval/feedbackEnrichment', () => ({
  runFeedbackEnrichment: (...a: unknown[]) => mockRunEnrichment(...a),
}))

import { runEnrichFeedbackJobHandler } from '../jobs/enrichFeedbackJob'

const step = { run: <T,>(_name: string, fn: () => Promise<T> | T) => Promise.resolve(fn()) }

const SESSION_ID = '507f1f77bcf86cd799439011'
const USER_ID = '507f1f77bcf86cd799439099'

function sessionDoc(overrides: Record<string, unknown> = {}) {
  return {
    select: vi.fn().mockReturnThis(),
    lean: vi.fn().mockResolvedValue({
      config: { role: 'pm', interviewType: 'screening' },
      evaluations: [{ questionIndex: 0, question: 'Q?', answer: 'A', relevance: 40, structure: 40, specificity: 40, ownership: 40 }],
      userId: USER_ID,
      ...overrides,
    }),
  }
}

function enrichmentResult() {
  return {
    ideal_answers: [
      { questionIndex: 0, strongAnswer: 'Strong.', keyElements: ['metric'] },
      { questionIndex: 2, strongAnswer: 'Also strong.', keyElements: ['tradeoff'] },
    ],
    drill_recommendations: [{ skillArea: 'STAR', practiceQuestions: ['A', 'B'] }],
    usage: { inputTokens: 1200, outputTokens: 2400 },
    model: 'gpt-5.6-luna',
  }
}

describe('enrichFeedbackJob handler', () => {
  beforeEach(() => {
    mockFindByIdAndUpdate.mockReset().mockResolvedValue(undefined)
    mockUpdateOne.mockReset().mockResolvedValue({ modifiedCount: 1 })
    mockFindOne.mockReset()
    mockRunEnrichment.mockReset()
    mockTrackUsage.mockReset().mockResolvedValue(undefined)
    mockFlushUsage.mockReset().mockResolvedValue(undefined)
  })

  it('happy path: running → generation → persists fields + succeeded → bills usage', async () => {
    mockFindOne.mockReturnValue(sessionDoc())
    mockRunEnrichment.mockResolvedValue(enrichmentResult())

    const out = await runEnrichFeedbackJobHandler(
      { id: 'event-1', data: { sessionId: SESSION_ID, userId: USER_ID, reason: 'post-feedback' } },
      step,
    )

    expect(out).toMatchObject({ sessionId: SESSION_ID, status: 'completed', idealAnswers: 2 })
    expect(mockUpdateOne).toHaveBeenCalledWith(
      {
        _id: SESSION_ID,
        userId: USER_ID,
        $or: [
          {
            enrichmentStatus: 'pending',
            enrichmentClaimToken: 'event-1',
          },
          {
            enrichmentStatus: 'pending',
            enrichmentClaimToken: { $in: [null, ''] },
          },
          { enrichmentStatus: { $exists: false } },
          { enrichmentStatus: 'running', enrichmentClaimToken: 'event-1' },
        ],
      },
      {
        $set: {
          enrichmentStatus: 'running',
          enrichmentClaimToken: 'event-1',
        },
        $unset: { enrichmentError: 1, enrichmentCompletedAt: 1 },
      },
    )
    // Final write: succeeded + both feedback fields
    const persist = mockFindByIdAndUpdate.mock.calls.at(-1)![1] as {
      $set: Record<string, unknown>
      $unset: Record<string, unknown>
    }
    expect(persist.$set.enrichmentStatus).toBe('succeeded')
    expect(persist.$set['feedback.ideal_answers']).toHaveLength(2)
    expect(persist.$set['feedback.drill_recommendations']).toHaveLength(1)
    expect(persist.$unset).toEqual({ enrichmentClaimToken: 1 })
    // Usage billed under the long-standing feedback bucket, own record
    expect(mockTrackUsage).toHaveBeenCalledTimes(1)
    expect(mockTrackUsage.mock.calls[0][0]).toMatchObject({
      type: 'api_call_feedback',
      sessionId: SESSION_ID,
      inputTokens: 1200,
      outputTokens: 2400,
      modelUsed: 'gpt-5.6-luna',
      success: true,
    })
  })

  it('flushes the usage buffer so the record cannot rot in Redis (Codex P2 #552)', async () => {
    mockFindOne.mockReturnValue(sessionDoc())
    mockRunEnrichment.mockResolvedValue(enrichmentResult())

    await runEnrichFeedbackJobHandler(
      { id: 'event-1', data: { sessionId: SESSION_ID, userId: USER_ID, reason: 'post-feedback' } },
      step,
    )

    expect(mockFlushUsage).toHaveBeenCalledWith(SESSION_ID)
  })

  it('passes the drilled questionIndex through so the requested question is generated (Codex P2 #552)', async () => {
    mockFindOne.mockReturnValue(sessionDoc())
    mockRunEnrichment.mockResolvedValue(enrichmentResult())

    await runEnrichFeedbackJobHandler(
      { id: 'event-1', data: { sessionId: SESSION_ID, userId: USER_ID, reason: 'drill-backfill', questionIndex: 11 } },
      step,
    )

    expect(mockRunEnrichment.mock.calls[0][0]).toMatchObject({ mustIncludeQuestionIndex: 11 })
  })

  it('admits only one concurrent event to paid enrichment and usage', async () => {
    let status = 'pending'
    mockUpdateOne.mockImplementation(async () => {
      if (status !== 'pending') return { modifiedCount: 0 }
      status = 'running'
      return { modifiedCount: 1 }
    })
    mockFindOne.mockReturnValue(sessionDoc())
    mockRunEnrichment.mockResolvedValue(enrichmentResult())

    const results = await Promise.all([
      runEnrichFeedbackJobHandler(
        { id: 'event-1', data: { sessionId: SESSION_ID, userId: USER_ID, reason: 'post-feedback' } },
        step,
      ),
      runEnrichFeedbackJobHandler(
        { id: 'event-2', data: { sessionId: SESSION_ID, userId: USER_ID, reason: 'post-feedback' } },
        step,
      ),
    ])

    expect(results.map((result) => result.status).sort()).toEqual(['completed', 'skipped'])
    expect(mockRunEnrichment).toHaveBeenCalledTimes(1)
    expect(mockTrackUsage).toHaveBeenCalledTimes(1)
    expect(mockFlushUsage).toHaveBeenCalledTimes(1)
  })

  it('resumes a pre-rollout job whose completed mark-running step returned no value', async () => {
    mockFindOne.mockReturnValue(sessionDoc())
    mockRunEnrichment.mockResolvedValue(enrichmentResult())
    const resumedStep = {
      run: async <T,>(name: string, fn: () => Promise<T> | T): Promise<T> => {
        if (name === 'mark-running') return undefined as T
        return fn()
      },
    }

    const out = await runEnrichFeedbackJobHandler(
      { id: 'event-1', data: { sessionId: SESSION_ID, userId: USER_ID, reason: 'post-feedback' } },
      resumedStep,
    )

    expect(out.status).toBe('completed')
    expect(mockUpdateOne).not.toHaveBeenCalled()
    expect(mockRunEnrichment).toHaveBeenCalledTimes(1)
    expect(mockTrackUsage).toHaveBeenCalledTimes(1)
  })

  it('lets the owning event retry an uncheckpointed running claim', async () => {
    mockUpdateOne.mockResolvedValue({ matchedCount: 1, modifiedCount: 0 })
    mockFindOne.mockReturnValue(sessionDoc())
    mockRunEnrichment.mockResolvedValue(enrichmentResult())

    const out = await runEnrichFeedbackJobHandler(
      { id: 'event-owner', data: { sessionId: SESSION_ID, userId: USER_ID, reason: 'post-feedback' } },
      step,
    )

    expect(out.status).toBe('completed')
    expect(mockUpdateOne.mock.calls[0][0]).toMatchObject({
      $or: expect.arrayContaining([
        {
          enrichmentStatus: 'running',
          enrichmentClaimToken: 'event-owner',
        },
      ]),
    })
    expect(mockRunEnrichment).toHaveBeenCalledTimes(1)
    expect(mockTrackUsage).toHaveBeenCalledTimes(1)
  })

  it('fails closed before Mongo when the claim token is missing', async () => {
    await expect(
      runEnrichFeedbackJobHandler(
        { id: '', data: { sessionId: SESSION_ID, userId: USER_ID, reason: 'post-feedback' } },
        step,
      ),
    ).rejects.toThrow('missing Inngest event id')

    expect(mockUpdateOne).not.toHaveBeenCalled()
    expect(mockRunEnrichment).not.toHaveBeenCalled()
  })

  it('does not adopt a tokenless running row from an active old worker', async () => {
    mockUpdateOne.mockResolvedValue({ matchedCount: 0, modifiedCount: 0 })

    const out = await runEnrichFeedbackJobHandler(
      { id: 'delayed-event', data: { sessionId: SESSION_ID, userId: USER_ID, reason: 'post-feedback' } },
      step,
    )

    expect(out.status).toBe('skipped')
    expect(mockRunEnrichment).not.toHaveBeenCalled()
    const filter = mockUpdateOne.mock.calls[0][0] as { $or: unknown[] }
    expect(filter.$or).not.toContainEqual({
      enrichmentStatus: 'running',
      enrichmentClaimToken: { $in: [null, ''] },
    })
  })

  it('union-merges ideal_answers by questionIndex — a backfill run never drops existing entries', async () => {
    mockFindOne.mockReturnValue(
      sessionDoc({
        feedback: {
          ideal_answers: [
            { questionIndex: 0, strongAnswer: 'Old for Q1.', keyElements: ['keep me'] },
            { questionIndex: 5, strongAnswer: 'Old for Q6.', keyElements: ['keep me too'] },
          ],
        },
      }),
    )
    mockRunEnrichment.mockResolvedValue(enrichmentResult()) // generates indexes 0 and 2

    await runEnrichFeedbackJobHandler(
      { id: 'event-1', data: { sessionId: SESSION_ID, userId: USER_ID, reason: 'drill-backfill' } },
      step,
    )

    const persist = mockFindByIdAndUpdate.mock.calls.at(-1)![1] as { $set: Record<string, unknown> }
    const merged = persist.$set['feedback.ideal_answers'] as Array<{ questionIndex: number; strongAnswer: string }>
    expect(merged.map((a) => a.questionIndex)).toEqual([0, 2, 5])
    // index 0: new entry wins; index 5: preserved from the earlier run
    expect(merged.find((a) => a.questionIndex === 0)!.strongAnswer).toBe('Strong.')
    expect(merged.find((a) => a.questionIndex === 5)!.strongAnswer).toBe('Old for Q6.')
  })

  it('no weak questions (null result): marks succeeded without touching feedback fields', async () => {
    mockFindOne.mockReturnValue(sessionDoc())
    mockRunEnrichment.mockResolvedValue(null)

    const out = await runEnrichFeedbackJobHandler(
      { id: 'event-1', data: { sessionId: SESSION_ID, userId: USER_ID, reason: 'drill-backfill' } },
      step,
    )

    expect(out.status).toBe('skipped')
    const persist = mockFindByIdAndUpdate.mock.calls.at(-1)![1] as { $set: Record<string, unknown> }
    expect(persist.$set.enrichmentStatus).toBe('succeeded')
    expect(persist.$set['feedback.ideal_answers']).toBeUndefined()
    expect(mockTrackUsage).not.toHaveBeenCalled()
  })

  it('throws (→ Inngest retry) when the session has no evaluations', async () => {
    mockFindOne.mockReturnValue(sessionDoc({ evaluations: [] }))
    await expect(
      runEnrichFeedbackJobHandler(
        { id: 'event-1', data: { sessionId: SESSION_ID, userId: USER_ID, reason: 'post-feedback' } },
        step,
      ),
    ).rejects.toThrow('no evaluations')
  })

  it('throws on user mismatch (event forgery / stale id)', async () => {
    mockFindOne.mockReturnValue(sessionDoc({ userId: 'someone-else' }))
    await expect(
      runEnrichFeedbackJobHandler(
        { id: 'event-1', data: { sessionId: SESSION_ID, userId: USER_ID, reason: 'post-feedback' } },
        step,
      ),
    ).rejects.toThrow('user mismatch')
  })

  it('propagates generation failure (→ Inngest retry, onFailure marks failed)', async () => {
    mockFindOne.mockReturnValue(sessionDoc())
    mockRunEnrichment.mockRejectedValue(new Error('provider 500'))
    await expect(
      runEnrichFeedbackJobHandler(
        { id: 'event-1', data: { sessionId: SESSION_ID, userId: USER_ID, reason: 'post-feedback' } },
        step,
      ),
    ).rejects.toThrow('provider 500')
    // No succeeded write happened
    const wroteSucceeded = mockFindByIdAndUpdate.mock.calls.some(
      (c) => (c[1] as { $set?: { enrichmentStatus?: string } }).$set?.enrichmentStatus === 'succeeded',
    )
    expect(wroteSucceeded).toBe(false)
  })
})
