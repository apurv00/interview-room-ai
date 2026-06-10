import { describe, it, expect, vi, beforeEach } from 'vitest'

const { mockCompletion } = vi.hoisted(() => ({ mockCompletion: vi.fn() }))
vi.mock('@shared/services/modelRouter', () => ({ completion: mockCompletion }))
vi.mock('@shared/services/promptSecurity', () => ({ JSON_OUTPUT_RULE: 'JSON_RULE' }))
vi.mock('@shared/logger', () => ({
  aiLogger: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() },
}))

import { generateCodingProblem } from '../services/core/codingProblemGenerator'

const cjk = String.fromCharCode(0x5177, 0x4f53) // stray CJK glyphs to be sanitized
const ok = (obj: unknown) => ({ text: JSON.stringify(obj), inputTokens: 1, outputTokens: 1 })

beforeEach(() => mockCompletion.mockReset())

describe('generateCodingProblem', () => {
  it('parses a clean response into a CodingProblem tagged to the role', async () => {
    mockCompletion.mockResolvedValue(ok({
      id: 'x', title: 'T', description: 'D', examples: [], constraints: ['c'],
      hints: ['h'], starterCode: { python: '' }, tags: ['t'],
    }))
    const p = await generateCodingProblem('ml-engineer', '3-6', [])
    expect(p).toBeTruthy()
    expect(p!.applicableDomains).toEqual(['ml-engineer'])
    expect(p!.difficulty).toBe('medium')
    expect(p!.id).toMatch(/^ai-/)
  })

  it('sanitizes stray CJK glyphs out of generated fields', async () => {
    mockCompletion.mockResolvedValue(ok({
      id: 'x', title: `Implement ${cjk} metric`, description: `do ${cjk} thing`,
      constraints: [], hints: [], tags: [],
    }))
    const p = await generateCodingProblem('data-analyst', '3-6', [])
    expect(p!.title).toBe('Implement metric')
    expect(p!.description).toBe('do thing')
  })

  it('injects role-specific domain focus + the resume into the prompt', async () => {
    mockCompletion.mockResolvedValue(ok({ id: 'x', title: 'T', description: 'D' }))
    await generateCodingProblem('data-analyst', '3-6', [], 'Built churn dashboards at Acme')
    const userMsg = mockCompletion.mock.calls[0][0].messages[0].content as string
    expect(userMsg).toContain('pandas')                  // data-analyst gets a data focus, not "general"
    expect(userMsg).toContain('Built churn dashboards at Acme')
    expect(userMsg.toLowerCase()).toContain('candidate background')
  })

  it('omits the background block when no resume is provided', async () => {
    mockCompletion.mockResolvedValue(ok({ id: 'x', title: 'T', description: 'D' }))
    await generateCodingProblem('ml-engineer', '7+', [])
    const userMsg = mockCompletion.mock.calls[0][0].messages[0].content as string
    expect(userMsg.toLowerCase()).not.toContain('candidate background')
  })

  it('returns null on malformed JSON (caller falls back to the static pool)', async () => {
    mockCompletion.mockResolvedValue({ text: 'no json here', inputTokens: 1, outputTokens: 1 })
    expect(await generateCodingProblem('backend', '3-6', [])).toBeNull()
  })
})
