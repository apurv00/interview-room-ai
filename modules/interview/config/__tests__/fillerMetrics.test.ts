import { describe, it, expect } from 'vitest'
import { computeFillerMetrics } from '../fillerMetrics'

describe('computeFillerMetrics', () => {
  const count = (text: string) => computeFillerMetrics(text).fillerWordCount
  const words = (text: string) => computeFillerMetrics(text).fillerWords.map((f) => f.word)

  it('still counts the base single-word fillers', () => {
    expect(count('um uh er ah')).toBe(4)
  })

  it('catches elongated spellings STT emits (the reported undercount)', () => {
    // Previously only {um,uh,er,ah} matched, so all of these slipped through.
    expect(count('umm uhh uhm ummm uhhh')).toBe(5)
  })

  it('folds elongated spellings to a canonical form so chips group', () => {
    // "umm"/"uhm"/"ummm" should all report as 'um', not three distinct chips.
    expect(words('umm uhm ummm')).toEqual(['um', 'um', 'um'])
    expect(words('uhh uhhh')).toEqual(['uh', 'uh'])
  })

  it('catches hmm / hesitation and backchannel variants', () => {
    expect(count('hmm hm')).toBe(2)
    expect(words('hmm')).toEqual(['hmm'])
    expect(count('mhm mm-hmm uh-huh')).toBe(3)
  })

  it('does not flag ordinary words as fillers', () => {
    const result = computeFillerMetrics('I built a system that scaled to a million users')
    expect(result.fillerWordCount).toBe(0)
  })

  it('does NOT flag the verb "err" but DOES catch "erm"/"ermm"', () => {
    // "I'd rather err on the side of caution" — err is a real word, not a filler.
    expect(count('I would rather err on the side of caution')).toBe(0)
    expect(words('erm ermm')).toEqual(['er', 'er'])
  })

  it('still matches multi-word fillers', () => {
    // "you know" (bigram) + "um"
    expect(count('so you know um that was hard')).toBe(2)
  })

  it('computes fillerRate over total words', () => {
    // 2 fillers out of 4 tokens.
    const r = computeFillerMetrics('um uh good answer'.trim())
    expect(r.totalWords).toBe(4)
    expect(r.fillerWordCount).toBe(2)
    expect(r.fillerRate).toBeCloseTo(0.5, 3)
  })

  it('honors an explicit isFiller flag from word-level input', () => {
    const r = computeFillerMetrics([
      { word: 'so' },
      { word: 'basically', isFiller: true },
      { word: 'yes' },
    ])
    expect(r.fillerWordCount).toBe(1)
    expect(r.fillerWords[0].word).toBe('basically')
  })
})
