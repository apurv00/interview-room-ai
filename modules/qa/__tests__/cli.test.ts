import { describe, it, expect } from 'vitest'
import { parseCliArgs } from '../cli/parseArgs'
import { effectiveQuestionLimit, plannedQuestionCount } from '../config/thresholds'

describe('QA CLI args', () => {
  it('defaults to smoke mode', () => {
    const args = parseCliArgs([])
    expect(args.mode).toBe('smoke')
    expect(args.stages).toContain('drill')
  })

  it('parses full and filters', () => {
    const args = parseCliArgs(['--full', '--domain', 'pm', '--depth', 'behavioral', '--questions', '3'])
    expect(args.mode).toBe('full')
    expect(args.questions).toBe(3)
  })
})

describe('question limits', () => {
  it('caps coding at 1 for 10min', () => {
    expect(plannedQuestionCount(10, 'coding')).toBe(1)
    expect(effectiveQuestionLimit(10, 'behavioral', 99)).toBe(6)
  })
})
