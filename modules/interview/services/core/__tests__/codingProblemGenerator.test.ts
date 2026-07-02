/**
 * PR "seeded problem generation" — generator prompt assembly + near-dup retry.
 *
 * Contract under test: the user prompt carries the seed block, the titled
 * avoid-list, and (when earned) the progression nudge; a parsed result that
 * near-duplicates a served title triggers exactly ONE retry naming the
 * collision; a second collision is accepted (never block problem delivery)
 * and logged; parse failure returns null as before.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'

const mocks = vi.hoisted(() => ({
  completion: vi.fn(),
  buildCodingSeedBlock: vi.fn(),
  warn: vi.fn(),
}))

vi.mock('@shared/services/modelRouter', () => ({ completion: mocks.completion }))
vi.mock('@shared/services/promptSecurity', () => ({
  JSON_OUTPUT_RULE: 'JSON_OUTPUT_RULE',
  DATA_BOUNDARY_RULE: 'DATA_BOUNDARY_RULE',
}))
vi.mock('@shared/services/sanitizeGeneratedText', () => ({
  sanitizeGeneratedText: (s: unknown) => s,
}))
vi.mock('@shared/logger', () => ({
  aiLogger: { info: vi.fn(), warn: mocks.warn, error: vi.fn() },
}))
vi.mock('@interview/services/core/problemSeeds', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../problemSeeds')>()
  return {
    ...actual,
    buildCodingSeedBlock: mocks.buildCodingSeedBlock,
  }
})

import { generateCodingProblem } from '../codingProblemGenerator'

const llmProblem = (title: string) => ({
  text: JSON.stringify({ id: 'gen-x', title, description: 'desc', tags: ['tag'] }),
})

const promptOfCall = (n: number): string =>
  mocks.completion.mock.calls[n][0].messages[0].content as string

beforeEach(() => {
  vi.clearAllMocks()
  mocks.buildCodingSeedBlock.mockResolvedValue({ block: '\n<style_exemplars>SEED</style_exemplars>\n', exemplarTitles: [] })
  mocks.completion.mockResolvedValue(llmProblem('Cohort Retention Aggregator'))
})

describe('generateCodingProblem prompt assembly', () => {
  it('injects the seed block and titled avoid-list', async () => {
    await generateCodingProblem('backend', '3-6', [], undefined, 'medium', 15, {
      avoid: [
        { id: 'two-sum', title: 'Two Sum' },
        { id: 'ai-generated-1' },
      ],
    })
    const prompt = promptOfCall(0)
    expect(prompt).toContain('<style_exemplars>SEED</style_exemplars>')
    expect(prompt).toContain('- Two Sum (two-sum)')
    expect(prompt).toContain('- ai-generated-1')
    expect(mocks.buildCodingSeedBlock).toHaveBeenCalledWith('backend', 'medium')
  })

  it('falls back to bare solvedProblemIds when no opts.avoid is given', async () => {
    await generateCodingProblem('backend', '3-6', ['legacy-id'], undefined, 'medium', 15)
    expect(promptOfCall(0)).toContain('- legacy-id')
  })

  it('adds the progression nudge from the 3rd problem in a domain, below hard', async () => {
    await generateCodingProblem('backend', '3-6', [], undefined, 'medium', 15, {
      priorCountInDomain: 2,
    })
    expect(promptOfCall(0)).toContain('problem #3')
    expect(promptOfCall(0)).toContain('UPPER END of medium')
  })

  it('suppresses the nudge for hard difficulty and low counts', async () => {
    await generateCodingProblem('backend', '7+', [], undefined, 'hard', 25, {
      priorCountInDomain: 5,
    })
    expect(promptOfCall(0)).not.toContain('UPPER END')

    mocks.completion.mockClear()
    await generateCodingProblem('backend', '3-6', [], undefined, 'medium', 15, {
      priorCountInDomain: 1,
    })
    expect(promptOfCall(0)).not.toContain('UPPER END')
  })
})

describe('generateCodingProblem near-duplicate retry', () => {
  const avoid = [{ id: 'url-shortener', title: 'Design a URL Shortener' }]

  it('retries once, naming the collision, when the result matches a served title', async () => {
    mocks.completion
      .mockResolvedValueOnce(llmProblem('URL Shortener Service'))
      .mockResolvedValueOnce(llmProblem('Log Batch Deduplicator'))

    const problem = await generateCodingProblem('backend', '3-6', [], undefined, 'medium', 15, { avoid })
    expect(mocks.completion).toHaveBeenCalledTimes(2)
    expect(promptOfCall(1)).toContain('too similar to "Design a URL Shortener"')
    expect(problem!.title).toBe('Log Batch Deduplicator')
    expect(mocks.warn).not.toHaveBeenCalled()
  })

  it('accepts and logs a second collision instead of blocking delivery', async () => {
    mocks.completion
      .mockResolvedValueOnce(llmProblem('URL Shortener Service'))
      .mockResolvedValueOnce(llmProblem('The URL Shortener'))

    const problem = await generateCodingProblem('backend', '3-6', [], undefined, 'medium', 15, { avoid })
    expect(mocks.completion).toHaveBeenCalledTimes(2)
    expect(problem!.title).toBe('The URL Shortener')
    expect(mocks.warn).toHaveBeenCalled()
  })

  it('does not retry when there is no collision', async () => {
    await generateCodingProblem('backend', '3-6', [], undefined, 'medium', 15, { avoid })
    expect(mocks.completion).toHaveBeenCalledTimes(1)
  })

  it('delivers the near-duplicate first candidate when the retry is unparseable (Codex P2 on #486)', async () => {
    mocks.completion
      .mockResolvedValueOnce(llmProblem('URL Shortener Service'))
      .mockResolvedValueOnce({ text: 'sorry, no json here' })

    const problem = await generateCodingProblem('backend', '3-6', [], undefined, 'medium', 15, { avoid })
    expect(problem!.title).toBe('URL Shortener Service')
    expect(mocks.warn).toHaveBeenCalled()
  })

  it('delivers the first candidate when the retry call throws', async () => {
    mocks.completion
      .mockResolvedValueOnce(llmProblem('URL Shortener Service'))
      .mockRejectedValueOnce(new Error('LLM down'))

    const problem = await generateCodingProblem('backend', '3-6', [], undefined, 'medium', 15, { avoid })
    expect(problem!.title).toBe('URL Shortener Service')
  })

  it('treats the seed exemplar as a collision source — the model copying the shown exemplar triggers the retry', async () => {
    mocks.buildCodingSeedBlock.mockResolvedValue({
      block: '\n<style_exemplars>1. "Two Sum" — desc</style_exemplars>\n',
      exemplarTitles: [{ title: 'Two Sum' }],
    })
    mocks.completion
      .mockResolvedValueOnce(llmProblem('Two Sum'))
      .mockResolvedValueOnce(llmProblem('Log Batch Deduplicator'))

    const problem = await generateCodingProblem('backend', '3-6', [], undefined, 'medium', 15, {})
    expect(mocks.completion).toHaveBeenCalledTimes(2)
    expect(problem!.title).toBe('Log Batch Deduplicator')
  })
})

describe('generateCodingProblem failure paths', () => {
  it('returns null when the LLM output has no JSON', async () => {
    mocks.completion.mockResolvedValue({ text: 'nope' })
    await expect(
      generateCodingProblem('backend', '3-6', [], undefined, 'medium', 15)
    ).resolves.toBeNull()
  })

  it('returns null when completion throws', async () => {
    mocks.completion.mockRejectedValue(new Error('LLM down'))
    await expect(
      generateCodingProblem('backend', '3-6', [], undefined, 'medium', 15)
    ).resolves.toBeNull()
  })
})
