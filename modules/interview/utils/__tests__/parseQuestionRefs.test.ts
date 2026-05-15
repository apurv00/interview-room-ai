import { describe, it, expect } from 'vitest'
import { parseQuestionRefs, parseQuestionRefSegments } from '../parseQuestionRefs'

describe('parseQuestionRefs', () => {
  it('returns empty for empty input', () => {
    expect(parseQuestionRefs('')).toEqual([])
    expect(parseQuestionRefs('no references here')).toEqual([])
  })

  it('parses a single Q-token (1-based → 0-based)', () => {
    expect(parseQuestionRefs('In Q3 you said something.')).toEqual([2])
    expect(parseQuestionRefs('Q1 was strong.')).toEqual([0])
  })

  it('parses multiple Q-tokens in first-appearance order', () => {
    expect(parseQuestionRefs('In Q1 and Q4 you...')).toEqual([0, 3])
    expect(parseQuestionRefs('Q5 came after Q3 unexpectedly.')).toEqual([4, 2])
  })

  it('expands ranges with hyphen / en-dash / em-dash', () => {
    expect(parseQuestionRefs('Q3-Q5 weakness')).toEqual([2, 3, 4])
    expect(parseQuestionRefs('Q3–Q5 weakness')).toEqual([2, 3, 4])
    expect(parseQuestionRefs('Q3—Q5 weakness')).toEqual([2, 3, 4])
    expect(parseQuestionRefs('Q3-5 weakness')).toEqual([2, 3, 4])
  })

  it('deduplicates across mentions and ranges', () => {
    expect(parseQuestionRefs('In Q3 you... and again Q3 was weak.')).toEqual([2])
    expect(parseQuestionRefs('Q1-Q2 then Q2 alone')).toEqual([0, 1])
  })

  it('is case-insensitive on the Q token', () => {
    expect(parseQuestionRefs('q3 was weak')).toEqual([2])
  })

  it('handles double-digit question numbers', () => {
    expect(parseQuestionRefs('Q12 was the longest answer')).toEqual([11])
    expect(parseQuestionRefs('Q9-Q11 had drift')).toEqual([8, 9, 10])
  })

  it('does NOT match Q embedded in non-word context', () => {
    // "BBQ3" should not match — \b word boundary before Q
    expect(parseQuestionRefs('Yum BBQ3 sauce')).toEqual([])
  })
})

describe('parseQuestionRefSegments', () => {
  it('returns a single text segment when no Q-tokens exist', () => {
    expect(parseQuestionRefSegments('plain text')).toEqual([
      { kind: 'text', text: 'plain text' },
    ])
  })

  it('alternates text and chip segments preserving original spacing', () => {
    const segments = parseQuestionRefSegments('In Q3 you said X')
    expect(segments).toEqual([
      { kind: 'text', text: 'In ' },
      { kind: 'chip', questionIndex: 2, raw: 'Q3', rangeEndIndex: undefined },
      { kind: 'text', text: ' you said X' },
    ])
  })

  it('captures range tokens as a single chip with rangeEndIndex set', () => {
    const segments = parseQuestionRefSegments('Q3-Q5 weakness')
    expect(segments).toEqual([
      { kind: 'chip', questionIndex: 2, raw: 'Q3-Q5', rangeEndIndex: 4 },
      { kind: 'text', text: ' weakness' },
    ])
  })

  it('handles consecutive Q-tokens', () => {
    const segments = parseQuestionRefSegments('Q1 Q2 Q3')
    expect(segments.filter((s) => s.kind === 'chip')).toHaveLength(3)
  })
})
