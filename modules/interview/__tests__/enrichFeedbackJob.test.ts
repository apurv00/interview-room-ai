import { describe, it, expect, vi, beforeEach } from 'vitest'

const {
  mockFindByIdAndUpdate,
  mockFindOne,
  mockRunEnrichment,
  mockTrackUsage,
} = vi.hoisted(() => ({
  mockFindByIdAndUpdate: vi.fn().mockResolvedValue(undefined),
  mockFindOne: vi.fn(),
  mockRunEnrichment: vi.fn(),
  mockTrackUsage: vi.fn().mockResolvedValue(undefined),
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
    findOne: (...a: unknown[]) => mockFindOne(...a),
  },
}))
vi.mock('@shared/logger', () => ({
  aiLogger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}))
vi.mock('@shared/services/usageTracking', () => ({ trackUsage: mockTrackUsage }))
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
    mockFindOne.mockReset()
    mockRunEnrichment.mockReset()
    mockTrackUsage.mockReset().mockResolvedValue(undefined)
  })

  it('happy path: running → generation → persists fields + succeeded → bills usage', async () => {
    mockFindOne.mockReturnValue(sessionDoc())
    mockRunEnrichment.mockResolvedValue(enrichmentResult())

    const out = await runEnrichFeedbackJobHandler(
      { data: { sessionId: SESSION_ID, userId: USER_ID, reason: 'post-feedback' } },
      step,
    )

    expect(out).toMatchObject({ sessionId: SESSION_ID, status: 'completed', idealAnswers: 2 })
    // First write: running
    expect(mockFindByIdAndUpdate.mock.calls[0][1]).toMatchObject({
      $set: { enrichmentStatus: 'running' },
    })
    // Final write: succeeded + both feedback fields
    const persist = mockFindByIdAndUpdate.mock.calls.at(-1)![1] as { $set: Record<string, unknown> }
    expect(persist.$set.enrichmentStatus).toBe('succeeded')
    expect(persist.$set['feedback.ideal_answers']).toHaveLength(2)
    expect(persist.$set['feedback.drill_recommendations']).toHaveLength(1)
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

  it('no weak questions (null result): marks succeeded without touching feedback fields', async () => {
    mockFindOne.mockReturnValue(sessionDoc())
    mockRunEnrichment.mockResolvedValue(null)

    const out = await runEnrichFeedbackJobHandler(
      { data: { sessionId: SESSION_ID, userId: USER_ID, reason: 'drill-backfill' } },
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
        { data: { sessionId: SESSION_ID, userId: USER_ID, reason: 'post-feedback' } },
        step,
      ),
    ).rejects.toThrow('no evaluations')
  })

  it('throws on user mismatch (event forgery / stale id)', async () => {
    mockFindOne.mockReturnValue(sessionDoc({ userId: 'someone-else' }))
    await expect(
      runEnrichFeedbackJobHandler(
        { data: { sessionId: SESSION_ID, userId: USER_ID, reason: 'post-feedback' } },
        step,
      ),
    ).rejects.toThrow('user mismatch')
  })

  it('propagates generation failure (→ Inngest retry, onFailure marks failed)', async () => {
    mockFindOne.mockReturnValue(sessionDoc())
    mockRunEnrichment.mockRejectedValue(new Error('provider 500'))
    await expect(
      runEnrichFeedbackJobHandler(
        { data: { sessionId: SESSION_ID, userId: USER_ID, reason: 'post-feedback' } },
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
