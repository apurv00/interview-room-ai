/**
 * Tests for the JIT ideal-answer backfill helper.
 *
 * This helper exists because the batch enrichment in
 * /api/generate-feedback routinely produces partial coverage of
 * `feedback.ideal_answers` — users see "no strong-answer outline" on
 * weak drill questions even though the prompt asks for one per weak
 * question. The helper generates a single outline on demand when the
 * drill context route detects a missing entry.
 *
 * Contract pinned here:
 *   1. Returns null fast on missing question (no LLM call)
 *   2. Returns the parsed { strongAnswer, keyElements } on a clean LLM response
 *   3. Returns null on LLM error / timeout / truncated / malformed JSON
 *      (caller falls back to QuestionInsightStrip)
 *   4. Filters empty / whitespace-only keyElements out of the response
 *   5. Uses the interview.generate-feedback task slot (so CMS routing
 *      can swap models without touching this file)
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'

const { mockCompletion, mockWarn } = vi.hoisted(() => ({
  mockCompletion: vi.fn(),
  mockWarn: vi.fn(),
}))

vi.mock('@shared/services/modelRouter', () => ({ completion: mockCompletion }))
vi.mock('@shared/services/promptSecurity', () => ({ DATA_BOUNDARY_RULE: 'BOUNDARY' }))
vi.mock('@shared/logger', () => ({
  logger: { warn: mockWarn, error: vi.fn(), info: vi.fn(), debug: vi.fn() },
}))

import { generateIdealAnswerForQuestion } from '../services/idealAnswerBackfill'

function llmResult(text: string, opts: Partial<{ truncated: boolean }> = {}) {
  return {
    text,
    inputTokens: 100,
    outputTokens: 50,
    truncated: opts.truncated ?? false,
    model: 'haiku',
    provider: 'anthropic',
  }
}

const baseInput = {
  question: 'Tell me about a time you owned an outcome under constraint.',
  candidateAnswer: 'I worked on a feature and shipped it.',
  domainLabel: 'Product Manager',
  interviewType: 'behavioral',
  sessionId: 'sess-1',
  questionIndex: 2,
}

beforeEach(() => {
  mockCompletion.mockReset()
  mockWarn.mockReset()
})

describe('generateIdealAnswerForQuestion', () => {
  it('returns null without calling the LLM when question is empty', async () => {
    const out = await generateIdealAnswerForQuestion({ ...baseInput, question: '   ' })
    expect(out).toBeNull()
    expect(mockCompletion).not.toHaveBeenCalled()
  })

  it('parses a clean LLM response into { strongAnswer, keyElements }', async () => {
    mockCompletion.mockResolvedValueOnce(
      llmResult(
        JSON.stringify({
          strongAnswer: 'I prioritized the funnel fix because data showed bounce rate was high...',
          keyElements: ['Cites funnel data', 'Explains tradeoff', 'Includes measurable impact'],
        }),
      ),
    )
    const out = await generateIdealAnswerForQuestion(baseInput)
    expect(out).toEqual({
      strongAnswer: expect.stringContaining('I prioritized'),
      keyElements: ['Cites funnel data', 'Explains tradeoff', 'Includes measurable impact'],
    })

    // Sanity: routed through the same task slot as the batch enrichment so
    // CMS overrides apply consistently.
    expect(mockCompletion).toHaveBeenCalledTimes(1)
    const args = mockCompletion.mock.calls[0][0]
    expect(args.taskSlot).toBe('interview.generate-feedback')
    expect(args.responseFormat?.name).toBe('single_ideal_answer')
  })

  it('returns null when the LLM call throws (e.g. provider error)', async () => {
    mockCompletion.mockRejectedValueOnce(new Error('rate limited'))
    const out = await generateIdealAnswerForQuestion(baseInput)
    expect(out).toBeNull()
    expect(mockWarn).toHaveBeenCalled()
  })

  it('returns null when the response is truncated', async () => {
    mockCompletion.mockResolvedValueOnce(
      llmResult(JSON.stringify({ strongAnswer: 'partial', keyElements: ['x'] }), { truncated: true }),
    )
    const out = await generateIdealAnswerForQuestion(baseInput)
    expect(out).toBeNull()
    expect(mockWarn).toHaveBeenCalled()
  })

  it('returns null when the response is malformed JSON', async () => {
    mockCompletion.mockResolvedValueOnce(llmResult('this is not json at all'))
    const out = await generateIdealAnswerForQuestion(baseInput)
    expect(out).toBeNull()
  })

  it('returns null when strongAnswer is empty even if keyElements have content', async () => {
    mockCompletion.mockResolvedValueOnce(
      llmResult(JSON.stringify({ strongAnswer: '   ', keyElements: ['a', 'b'] })),
    )
    const out = await generateIdealAnswerForQuestion(baseInput)
    expect(out).toBeNull()
  })

  it('filters empty / whitespace keyElements and rejects when none remain', async () => {
    mockCompletion.mockResolvedValueOnce(
      llmResult(JSON.stringify({ strongAnswer: 'a real answer', keyElements: ['', '  ', '\t'] })),
    )
    const out = await generateIdealAnswerForQuestion(baseInput)
    expect(out).toBeNull()
  })

  it('trims and keeps non-empty keyElements when at least one survives', async () => {
    mockCompletion.mockResolvedValueOnce(
      llmResult(
        JSON.stringify({
          strongAnswer: 'I led the redesign...',
          keyElements: ['  Show user research  ', '', 'State the outcome'],
        }),
      ),
    )
    const out = await generateIdealAnswerForQuestion(baseInput)
    expect(out).toEqual({
      strongAnswer: 'I led the redesign...',
      keyElements: ['Show user research', 'State the outcome'],
    })
  })
})
