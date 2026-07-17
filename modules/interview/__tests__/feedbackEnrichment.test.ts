import { describe, it, expect, vi, beforeEach } from 'vitest'

const { mockCompletion } = vi.hoisted(() => ({ mockCompletion: vi.fn() }))

vi.mock('@shared/services/modelRouter', () => ({ completion: mockCompletion }))
vi.mock('@shared/services/promptSecurity', () => ({
  DATA_BOUNDARY_RULE: 'BOUNDARY',
  JSON_OUTPUT_RULE: 'JSON_RULE',
}))

import { runFeedbackEnrichment, weakestQuestionContext } from '../services/eval/feedbackEnrichment'

function weakEval(i: number, avg = 40) {
  return {
    questionIndex: i,
    question: `Q${i + 1}?`,
    answer: `Answer ${i + 1}`,
    relevance: avg,
    structure: avg,
    specificity: avg,
    ownership: avg,
  }
}

function llmResult(overrides: Record<string, unknown> = {}) {
  return {
    text: JSON.stringify({
      ideal_answers: [{ questionIndex: 0, strongAnswer: 'Strong.', keyElements: ['metric'] }],
      drill_recommendations: [{ skillArea: 'STAR', practiceQuestions: ['A', 'B'] }],
    }),
    model: 'gpt-5.6-luna',
    provider: 'openai',
    inputTokens: 900,
    outputTokens: 700,
    usedFallback: false,
    truncated: false,
    ...overrides,
  }
}

// The full-quality envelope: enrichment left the request path 2026-07-17
// (async enrichFeedbackJob) precisely so this call can afford 'high'.
// The 12k budget is sized for the 30-MINUTE worst case (10 weak questions
// ≈ 3.5k content tokens + high-effort reasoning tokens billed against the
// output budget). If you change any of these, re-verify a full 30-minute
// interview end-to-end — not just a 10-minute one.
describe('runFeedbackEnrichment envelope', () => {
  beforeEach(() => mockCompletion.mockReset())

  it('runs at reasoningEffort high with the 30-min-sized token budget', async () => {
    mockCompletion.mockResolvedValue(llmResult())

    const result = await runFeedbackEnrichment({
      evaluations: [weakEval(0)],
      domainLabel: 'Product Manager',
      interviewType: 'screening',
    })

    expect(result).not.toBeNull()
    const params = mockCompletion.mock.calls[0][0] as {
      taskSlot: string
      reasoningEffort?: string
      maxTokens?: number
    }
    expect(params.taskSlot).toBe('interview.generate-feedback')
    expect(params.reasoningEffort).toBe('high')
    expect(params.maxTokens).toBe(12_000)
  })

  it('returns null without an LLM call when no question is weak', async () => {
    const result = await runFeedbackEnrichment({
      evaluations: [weakEval(0, 80)],
      domainLabel: 'PM',
      interviewType: 'screening',
    })
    expect(result).toBeNull()
    expect(mockCompletion).not.toHaveBeenCalled()
  })

  it('throws on truncation so the job retries instead of persisting partial output', async () => {
    mockCompletion.mockResolvedValue(llmResult({ truncated: true }))
    await expect(
      runFeedbackEnrichment({ evaluations: [weakEval(0)], domainLabel: 'PM', interviewType: 'screening' }),
    ).rejects.toThrow('truncated')
  })

  it('parses arrays and reports usage + model', async () => {
    mockCompletion.mockResolvedValue(llmResult())
    const result = await runFeedbackEnrichment({
      evaluations: [weakEval(0)],
      domainLabel: 'PM',
      interviewType: 'screening',
    })
    expect(result!.ideal_answers).toHaveLength(1)
    expect(result!.drill_recommendations).toHaveLength(1)
    expect(result!.usage).toEqual({ inputTokens: 900, outputTokens: 700 })
    expect(result!.model).toBe('gpt-5.6-luna')
  })
})

// Ported from the pre-async route tests (2026-05-19 semantics): every weak
// question gets an entry, capped at 10 — the cap is what bounds the prompt
// on 20/30-minute interviews.
describe('weakestQuestionContext', () => {
  it('includes every weak question (avg < 60), weakest first, capped at 10', () => {
    const evals = [
      ...Array.from({ length: 12 }, (_, i) => weakEval(i, 30 + i)), // 12 weak, ascending
      weakEval(20, 75), // strong — excluded
    ]
    const ctx = weakestQuestionContext(evals)
    for (let i = 1; i <= 10; i++) {
      expect(ctx).toContain(`Q${i} (avg`)
    }
    expect(ctx).not.toContain('Q11 (avg')
    expect(ctx).not.toContain('Q12 (avg')
    expect(ctx).not.toContain('Q21 (avg')
  })

  it('guarantees the drilled question is included even when it ranks outside the cap (Codex P2 #552)', () => {
    // 12 weak questions, ascending weakness — Q12 (index 11) is the LEAST
    // weak and would normally be cut by the cap. A drill-backfill for it
    // must still generate it (the 20/30-min case the old JIT path served).
    const evals = Array.from({ length: 12 }, (_, i) => weakEval(i, 30 + i))
    const ctx = weakestQuestionContext(evals, 10, 11)
    expect(ctx).toContain('Q12 (avg')
    // Still capped at 10 entries — the least-weak default pick was swapped out.
    expect(ctx.split('Question:').length - 1).toBe(10)
    expect(ctx).not.toContain('Q10 (avg')
  })

  it('excludes failed evaluations and returns empty string when nothing is weak', () => {
    expect(weakestQuestionContext([{ ...weakEval(0, 40), status: 'failed' }])).toBe('')
    expect(weakestQuestionContext([weakEval(0, 70)])).toBe('')
  })
})
