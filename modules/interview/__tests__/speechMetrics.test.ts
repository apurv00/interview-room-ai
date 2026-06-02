import { describe, expect, it } from 'vitest'
import { computeFillerMetrics } from '../config/fillerMetrics'
import { aggregateMetrics, analyzeSpeech } from '../config/speechMetrics'

describe('filler metrics', () => {
  it('counts punctuated fillers from smart-formatted transcripts', () => {
    const metrics = analyzeSpeech('Um, I mean, uh... we improved retention.', 0.1)

    expect(metrics.totalWords).toBe(7)
    expect(metrics.fillerWordCount).toBe(3)
    expect(metrics.fillerRate).toBeCloseTo(3 / 7, 3)
  })

  it('does not count semantic like as a filler', () => {
    const metrics = computeFillerMetrics('A marketplace like this needs seller trust.')

    expect(metrics.fillerWordCount).toBe(0)
  })

  it('counts pause-adjacent like as a filler when word timings exist', () => {
    const metrics = computeFillerMetrics([
      { word: 'I', start: 0, end: 0.1 },
      { word: 'like', start: 0.6, end: 0.8 },
      { word: 'mapped', start: 1.3, end: 1.6 },
      { word: 'the', start: 1.7, end: 1.8 },
      { word: 'flow', start: 1.9, end: 2.1 },
    ])

    expect(metrics.fillerWords.map((f) => f.word)).toContain('like')
  })

  it('aggregates filler rate by total words instead of averaging percentages', () => {
    const aggregate = aggregateMetrics([
      {
        wpm: 100,
        fillerRate: 0.5,
        pauseScore: 80,
        ramblingIndex: 0,
        totalWords: 10,
        fillerWordCount: 5,
        durationMinutes: 0.1,
      },
      {
        wpm: 100,
        fillerRate: 0.01,
        pauseScore: 80,
        ramblingIndex: 0,
        totalWords: 100,
        fillerWordCount: 1,
        durationMinutes: 1,
      },
    ])

    expect(aggregate.fillerWordCount).toBe(6)
    expect(aggregate.totalWords).toBe(110)
    expect(aggregate.fillerRate).toBeCloseTo(6 / 110, 3)
  })
})
