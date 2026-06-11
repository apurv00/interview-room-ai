import { describe, it, expect } from 'vitest'
import { buildAntiRepeatBlock } from '../flow/promptBuilder'

describe('buildAntiRepeatBlock', () => {
  it('returns empty string when there is no prior history', () => {
    expect(buildAntiRepeatBlock([], 'Finance Analyst', 'case-study')).toBe('')
    expect(buildAntiRepeatBlock(['', '   '], 'Finance Analyst', 'case-study')).toBe('')
  })

  it('names the role + type and lists each prior question', () => {
    const block = buildAntiRepeatBlock(
      ['Design a payment reconciliation flow', 'Walk me through a DCF'],
      'Finance Analyst',
      'case-study',
    )
    expect(block).toContain('Finance Analyst case-study')
    expect(block.toLowerCase()).toContain('do not repeat')
    expect(block).toContain('- Design a payment reconciliation flow')
    expect(block).toContain('- Walk me through a DCF')
  })

  it('dedupes case-insensitively and skips blanks/whitespace', () => {
    const block = buildAntiRepeatBlock(['Same Q', 'same q', '  Same Q  ', '', 'Other'], 'PM', 'case-study')
    expect((block.match(/- Same Q$/gm) || []).length).toBe(1) // kept once (first display form)
    expect(block).toContain('- Other')
  })

  it('caps the list at `max`', () => {
    const qs = Array.from({ length: 30 }, (_, i) => `Distinct question number ${i}`)
    const block = buildAntiRepeatBlock(qs, 'PM', 'behavioral', 12)
    expect((block.match(/^- /gm) || []).length).toBe(12)
  })

  it('truncates very long questions with an ellipsis', () => {
    const block = buildAntiRepeatBlock(['x'.repeat(300)], 'PM', 'technical')
    expect(block).toContain('…')
    const line = block.split('\n').find((l) => l.startsWith('- '))!
    expect(line.length).toBeLessThanOrEqual(182)
  })
})
