import { describe, it, expect } from 'vitest'
import {
  normalizeToken,
  buildWhisperWordIndex,
  clarityForLine,
  LOW_CLARITY_THRESHOLD,
} from '../clarityIndex'
import type { WhisperSegment } from '@shared/types/multimodal'

function seg(id: number, start: number, end: number, words: Array<{ word: string; start: number; conf: number }>): WhisperSegment {
  return {
    id,
    start,
    end,
    text: words.map((w) => w.word).join(' '),
    words: words.map((w) => ({
      word: w.word,
      start: w.start,
      end: w.start + 0.4,
      confidence: w.conf,
    })),
  }
}

describe('normalizeToken', () => {
  it('lowercases and strips wrapping punctuation', () => {
    expect(normalizeToken('Hello,')).toBe('hello')
    expect(normalizeToken('"yes"')).toBe('yes')
    expect(normalizeToken('THAT.')).toBe('that')
  })

  it('preserves internal apostrophes (contractions)', () => {
    expect(normalizeToken("don't")).toBe("don't")
    expect(normalizeToken("It's,")).toBe("it's")
  })

  it('drops wrapping brackets entirely (filler markers handled separately)', () => {
    expect(normalizeToken('[uh]')).toBe('uh')
  })

  it('returns empty string for tokens with no alphanumerics', () => {
    expect(normalizeToken('...')).toBe('')
    expect(normalizeToken('---')).toBe('')
  })

  it('handles empty input', () => {
    expect(normalizeToken('')).toBe('')
  })
})

describe('buildWhisperWordIndex', () => {
  it('returns [] for empty / undefined input', () => {
    expect(buildWhisperWordIndex(undefined)).toEqual([])
    expect(buildWhisperWordIndex([])).toEqual([])
  })

  it('flattens words from all segments, normalized', () => {
    const segments = [
      seg(0, 0, 5, [
        { word: 'Hello,', start: 0, conf: 0.95 },
        { word: 'how', start: 1, conf: 0.9 },
      ]),
      seg(1, 5, 10, [
        { word: 'are', start: 5.5, conf: 0.6 },
        { word: 'you?', start: 6, conf: 0.85 },
      ]),
    ]
    const idx = buildWhisperWordIndex(segments)
    expect(idx).toEqual([
      { word: 'hello', startSec: 0, confidence: 0.95 },
      { word: 'how', startSec: 1, confidence: 0.9 },
      { word: 'are', startSec: 5.5, confidence: 0.6 },
      { word: 'you', startSec: 6, confidence: 0.85 },
    ])
  })

  it('skips segments with empty words arrays (older session data)', () => {
    const segments: WhisperSegment[] = [
      { id: 0, start: 0, end: 5, text: 'old format', words: [] },
      seg(1, 5, 10, [{ word: 'hello', start: 5, conf: 0.9 }]),
    ]
    expect(buildWhisperWordIndex(segments)).toHaveLength(1)
  })

  it('drops entries with non-finite start or confidence', () => {
    const segments = [
      seg(0, 0, 5, [
        { word: 'good', start: 0, conf: 0.9 },
        { word: 'bad', start: NaN, conf: 0.9 },
        { word: 'bad2', start: 2, conf: NaN },
      ]),
    ]
    expect(buildWhisperWordIndex(segments)).toEqual([
      { word: 'good', startSec: 0, confidence: 0.9 },
    ])
  })

  it('sorts by startSec ascending (defensive against out-of-order segments)', () => {
    const segments = [
      seg(0, 5, 10, [{ word: 'second', start: 5, conf: 0.9 }]),
      seg(1, 0, 5, [{ word: 'first', start: 0, conf: 0.9 }]),
    ]
    const idx = buildWhisperWordIndex(segments)
    expect(idx[0].word).toBe('first')
    expect(idx[1].word).toBe('second')
  })
})

describe('clarityForLine — per-line annotation', () => {
  const segments = [
    seg(0, 0, 10, [
      { word: 'Hi', start: 0, conf: 0.95 },
      { word: 'I', start: 1, conf: 0.92 },
      { word: 'mumbled', start: 2, conf: 0.5 }, // low
      { word: 'here', start: 3, conf: 0.4 },    // low
      { word: 'clearly', start: 4, conf: 0.9 },
    ]),
  ]
  const index = buildWhisperWordIndex(segments)

  it('returns [] for empty line text', () => {
    expect(clarityForLine('', 0, 10, index)).toEqual([])
  })

  it('flags only words with confidence below threshold', () => {
    const out = clarityForLine('Hi I mumbled here clearly', 0, 10, index)
    expect(out).toEqual([
      { raw: 'Hi', isLowClarity: false },
      { raw: 'I', isLowClarity: false },
      { raw: 'mumbled', isLowClarity: true },
      { raw: 'here', isLowClarity: true },
      { raw: 'clearly', isLowClarity: false },
    ])
  })

  it('returns isLowClarity=false when no whisper data exists', () => {
    const out = clarityForLine('Hi there', 0, 10, [])
    expect(out.every((w) => !w.isLowClarity)).toBe(true)
  })

  it('returns isLowClarity=false for line words not present in the index window', () => {
    const out = clarityForLine('something completely else', 0, 10, index)
    expect(out.every((w) => !w.isLowClarity)).toBe(true)
  })

  it('respects the line time window — words outside are ignored', () => {
    // Line window is [100, 200) — none of the index words fall inside, so
    // nothing matches and nothing is flagged.
    const out = clarityForLine('Hi I mumbled', 100, 200, index)
    expect(out.every((w) => !w.isLowClarity)).toBe(true)
  })

  it('matches repeated words via pointer advance (second "um" hits second whisper "um")', () => {
    const repIndex = buildWhisperWordIndex([
      seg(0, 0, 10, [
        { word: 'um', start: 1, conf: 0.9 }, // first — high
        { word: 'um', start: 2, conf: 0.3 }, // second — low
      ]),
    ])
    const out = clarityForLine('um um', 0, 10, repIndex)
    expect(out[0].isLowClarity).toBe(false) // first um → 0.9
    expect(out[1].isLowClarity).toBe(true)  // second um → 0.3
  })

  it('handles punctuation and case differences between line and whisper', () => {
    const out = clarityForLine('hi, MUMBLED.', 0, 10, index)
    expect(out[0].raw).toBe('hi,')
    expect(out[0].isLowClarity).toBe(false)
    expect(out[1].raw).toBe('MUMBLED.')
    expect(out[1].isLowClarity).toBe(true) // normalized 'mumbled' matches
  })

  it('does not flag bracketed filler markers as low-clarity', () => {
    const out = clarityForLine('[uh] mumbled', 0, 10, index)
    expect(out[0].isLowClarity).toBe(false)
    expect(out[1].isLowClarity).toBe(true)
  })

  it('respects a custom threshold', () => {
    const out = clarityForLine('Hi I clearly', 0, 10, index, 0.99)
    // With threshold 0.99 even confidences of 0.95/0.92/0.9 are low.
    expect(out.every((w) => w.isLowClarity)).toBe(true)
  })

  it('exposes LOW_CLARITY_THRESHOLD as the default', () => {
    expect(LOW_CLARITY_THRESHOLD).toBe(0.8)
  })
})
