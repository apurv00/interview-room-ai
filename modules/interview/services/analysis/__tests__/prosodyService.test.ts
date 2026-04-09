import { describe, it, expect } from 'vitest'
import { extractProsody } from '../prosodyService'
import type { WhisperSegment } from '@shared/types/multimodal'

describe('prosodyService', () => {
  const makeSegments = (words: Array<{ word: string; start: number; end: number }>): WhisperSegment[] => [
    {
      id: 0,
      start: words[0]?.start || 0,
      end: words[words.length - 1]?.end || 0,
      text: words.map((w) => w.word).join(' '),
      words: words.map((w) => ({ ...w, confidence: 1 })),
    },
  ]

  it('returns empty array when no segments', () => {
    expect(extractProsody([], [0], 60)).toEqual([])
  })

  it('returns empty array when no question boundaries', () => {
    const segments = makeSegments([{ word: 'hello', start: 0, end: 0.5 }])
    expect(extractProsody(segments, [], 60)).toEqual([])
  })

  it('computes WPM correctly for a single window', () => {
    // 10 words spread over 6 seconds = 100 WPM
    const words = Array.from({ length: 10 }, (_, i) => ({
      word: `word${i}`,
      start: i * 0.6,
      end: i * 0.6 + 0.4,
    }))
    const segments = makeSegments(words)
    const result = extractProsody(segments, [0], 10)

    expect(result).toHaveLength(1)
    expect(result[0].wpm).toBeGreaterThan(0)
    expect(result[0].questionIndex).toBe(0)
  })

  it('detects filler words', () => {
    const words = [
      { word: 'so', start: 0, end: 0.3 },
      { word: 'um', start: 0.5, end: 0.7 },
      { word: 'I', start: 1, end: 1.1 },
      { word: 'like', start: 1.3, end: 1.5 },
      { word: 'worked', start: 1.7, end: 2 },
      { word: 'you', start: 2.2, end: 2.4 },
      { word: 'know', start: 2.5, end: 2.7 },
    ]
    const segments = makeSegments(words)
    const result = extractProsody(segments, [0], 10)

    expect(result[0].fillerWords.length).toBeGreaterThanOrEqual(2) // "um" and "like" at minimum
    const fillerTexts = result[0].fillerWords.map((f) => f.word)
    expect(fillerTexts).toContain('um')
    expect(fillerTexts).toContain('like')
  })

  it('detects pauses between words', () => {
    const words = [
      { word: 'hello', start: 0, end: 0.5 },
      // 2 second gap
      { word: 'world', start: 2.5, end: 3 },
    ]
    const segments = makeSegments(words)
    const result = extractProsody(segments, [0], 5)

    expect(result[0].pauseDurationSec).toBeGreaterThanOrEqual(1.5)
  })

  it('splits words into multiple question windows', () => {
    const words = [
      { word: 'answer1', start: 1, end: 1.5 },
      { word: 'to', start: 1.6, end: 1.8 },
      { word: 'q1', start: 2, end: 2.3 },
      { word: 'answer2', start: 11, end: 11.5 },
      { word: 'to', start: 11.6, end: 11.8 },
      { word: 'q2', start: 12, end: 12.3 },
    ]
    const segments = makeSegments(words)
    const result = extractProsody(segments, [0, 10], 20)

    expect(result).toHaveLength(2)
    expect(result[0].questionIndex).toBe(0)
    expect(result[1].questionIndex).toBe(1)
  })

  it('assigns confidence markers based on metrics', () => {
    // Stable pace, no fillers — should be high
    const words = Array.from({ length: 20 }, (_, i) => ({
      word: `word${i}`,
      start: i * 0.45,
      end: i * 0.45 + 0.3,
    }))
    const segments = makeSegments(words)
    const result = extractProsody(segments, [0], 15)

    expect(['high', 'medium', 'low']).toContain(result[0].confidenceMarker)
  })
})
