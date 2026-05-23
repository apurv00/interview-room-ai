import { describe, it, expect } from 'vitest'
import { pickPersonaAnswer, questionQualityHeuristics } from '../config/personas'
import { synthesizeLiveWords } from '../runners/interviewRunner'

describe('QA personas', () => {
  it('returns different lengths for strong vs weak', () => {
    const strong = pickPersonaAnswer('behavioral', 'strong', 'Tell me about a conflict.')
    const weak = pickPersonaAnswer('behavioral', 'weak', 'Tell me about a conflict.')
    expect(strong.length).toBeGreaterThan(weak.length)
  })

  it('flags coding question without implementation cues', () => {
    const issues = questionQualityHeuristics('Tell me about yourself.', 'backend', 'coding')
    expect(issues.some((i) => i.includes('Coding'))).toBe(true)
  })
})

describe('synthesizeLiveWords', () => {
  it('builds words from candidate transcript lines', () => {
    const words = synthesizeLiveWords([
      { speaker: 'interviewer', text: 'Hi', timestamp: 1 },
      { speaker: 'candidate', text: 'Hello world', timestamp: 2, questionIndex: 0 },
    ])
    expect(words.length).toBeGreaterThanOrEqual(2)
    expect(words[0].word).toBe('Hello')
  })
})
