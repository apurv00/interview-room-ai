/**
 * PR "seeded problem generation" — exemplar seed blocks + avoid-list rendering.
 *
 * Seed blocks turn the static pools + QuestionBank rows into style exemplars
 * for the generation prompt. Contract: always includes a pool exemplar when
 * the domain (or its fallback) has one, appends up to 2 bank rows, and
 * degrades to '' when there is nothing to seed — never throws, never blocks.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'

const mocks = vi.hoisted(() => ({
  retrieveQuestions: vi.fn(),
}))

vi.mock('@interview/services/persona/retrievalService', () => ({
  retrieveQuestions: mocks.retrieveQuestions,
}))

import { buildCodingSeedBlock, buildDesignSeedBlock, formatAvoidList } from '../problemSeeds'

beforeEach(() => {
  vi.clearAllMocks()
  mocks.retrieveQuestions.mockResolvedValue([])
})

describe('buildCodingSeedBlock', () => {
  it('includes a static-pool exemplar for a native domain', async () => {
    const block = await buildCodingSeedBlock('backend', 'medium')
    expect(block).toContain('<style_exemplars>')
    expect(block).toContain('Do NOT reuse their scenario')
    expect(block).toMatch(/1\. "/)
  })

  it('borrows the fallback pool for domains without native problems', async () => {
    // ml-engineer borrows data-science via PROBLEM_POOL_FALLBACK
    const block = await buildCodingSeedBlock('ml-engineer', 'medium')
    expect(block).toContain('<style_exemplars>')
  })

  it('appends bank exemplars with ideal-answer points', async () => {
    mocks.retrieveQuestions.mockResolvedValue([
      {
        question: 'Implement a sliding-window rate limiter.',
        category: 'coding',
        targetCompetencies: [],
        difficulty: 'medium',
        idealAnswerPoints: ['window bookkeeping', 'O(1) checks', 'clock skew'],
      },
    ])
    const block = await buildCodingSeedBlock('backend', 'medium')
    expect(block).toContain('sliding-window rate limiter')
    expect(block).toContain('a strong answer covers: window bookkeeping; O(1) checks; clock skew')
    // trackUsage:false — exemplar reads must not bias the real RAG's
    // prefer-less-used ordering (Codex P2 on #486).
    expect(mocks.retrieveQuestions).toHaveBeenCalledWith({ domain: 'backend', interviewType: 'coding', limit: 2, trackUsage: false })
  })

  it('degrades to pool-only when bank retrieval throws', async () => {
    mocks.retrieveQuestions.mockRejectedValue(new Error('mongo down'))
    const block = await buildCodingSeedBlock('backend', 'easy')
    expect(block).toContain('<style_exemplars>')
  })
})

describe('buildDesignSeedBlock', () => {
  it('includes a design exemplar with requirements head', async () => {
    const block = await buildDesignSeedBlock('backend', 'medium')
    expect(block).toContain('<style_exemplars>')
    expect(block).toContain('Requirements include:')
    expect(mocks.retrieveQuestions).toHaveBeenCalledWith({ domain: 'backend', interviewType: 'system-design', limit: 2, trackUsage: false })
  })

  it('falls back to the whole pool for untagged domains', async () => {
    const block = await buildDesignSeedBlock('data-analyst', 'easy')
    expect(block).toContain('<style_exemplars>')
  })
})

describe('formatAvoidList', () => {
  it('renders titled entries as "- Title (id)" and bare entries as "- id"', () => {
    const out = formatAvoidList([
      { id: 'two-sum', title: 'Two Sum' },
      { id: 'ai-generated-123' },
    ])
    expect(out).toBe('- Two Sum (two-sum)\n- ai-generated-123')
  })

  it('caps at 30 entries keeping the front (freshest) of the list', () => {
    const entries = Array.from({ length: 40 }, (_, i) => ({ id: `p-${i}` }))
    const out = formatAvoidList(entries)
    expect(out.split('\n')).toHaveLength(30)
    expect(out).toContain('- p-0')
    expect(out).not.toContain('- p-30')
  })

  it('returns empty string for an empty list', () => {
    expect(formatAvoidList([])).toBe('')
  })
})
