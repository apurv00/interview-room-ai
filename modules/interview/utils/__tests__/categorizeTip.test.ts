import { describe, it, expect } from 'vitest'
import { categorizeTip } from '../categorizeTip'

describe('categorizeTip', () => {
  it('returns General for empty input', () => {
    expect(categorizeTip('')).toBe('General')
  })

  it('returns General when no keywords match', () => {
    expect(categorizeTip('Just keep practicing.')).toBe('General')
  })

  it('detects Behavior cues', () => {
    expect(categorizeTip('Maintain stronger eye contact.')).toBe('Behavior')
    expect(categorizeTip('Your gestures came across as nervous.')).toBe('Behavior')
    expect(categorizeTip('Smile more during your intro.')).toBe('Behavior')
  })

  it('detects Communication cues', () => {
    expect(categorizeTip('Slow your pace; you spoke at 180 wpm.')).toBe('Communication')
    expect(categorizeTip('Reduce filler words like "um".')).toBe('Communication')
    expect(categorizeTip('You hesitated a lot in Q3.')).toBe('Communication')
  })

  it('detects Content cues', () => {
    expect(categorizeTip('Use the STAR framework: Situation, Task, Action, Result.')).toBe('Content')
    expect(categorizeTip('Add specific metrics to your examples.')).toBe('Content')
    expect(categorizeTip('Use "I" instead of "we" to show ownership.')).toBe('Content')
  })

  it('picks the dominant category when multiple match', () => {
    // 1 behavior keyword, 3 content keywords → Content wins
    expect(categorizeTip('Use STAR with specific metrics and concrete examples; smile too.')).toBe('Content')
  })

  it('is case-insensitive', () => {
    expect(categorizeTip('EYE CONTACT was poor')).toBe('Behavior')
  })
})
