import { describe, it, expect } from 'vitest'
import { getLiveCaptionText, DEFAULT_LIVE_CAPTION_MAX_WORDS } from '../liveCaption'
import type { WhisperSegment, WhisperWord } from '@shared/types/multimodal'

function w(word: string, start: number, end = start + 0.4): WhisperWord {
  return { word, start, end, confidence: 1 }
}

function seg(id: number, start: number, end: number, text: string, words: WhisperWord[]): WhisperSegment {
  return { id, start, end, text, words }
}

describe('getLiveCaptionText', () => {
  it('returns empty string for undefined / empty input', () => {
    expect(getLiveCaptionText(undefined, 10)).toBe('')
    expect(getLiveCaptionText([], 10)).toBe('')
  })

  it('returns empty string when no word has been spoken yet (word-level)', () => {
    const segs = [seg(0, 5, 10, 'hi there', [w('hi', 5), w('there', 6)])]
    expect(getLiveCaptionText(segs, 0)).toBe('')
  })

  it('returns words up to currentTime (word-level)', () => {
    const segs = [seg(0, 0, 5, 'one two three four', [w('one', 0), w('two', 1), w('three', 2), w('four', 3)])]
    expect(getLiveCaptionText(segs, 0.5)).toBe('one')
    expect(getLiveCaptionText(segs, 2.5)).toBe('one two three')
    expect(getLiveCaptionText(segs, 10)).toBe('one two three four')
  })

  it('joins words across multiple segments', () => {
    const segs = [
      seg(0, 0, 2, 'one two', [w('one', 0), w('two', 1)]),
      seg(1, 2, 4, 'three four', [w('three', 2), w('four', 3)]),
    ]
    expect(getLiveCaptionText(segs, 3.5)).toBe('one two three four')
  })

  it('caps the result to the rolling window of the last N words', () => {
    const words: WhisperWord[] = []
    for (let i = 0; i < 40; i++) words.push(w(`x${i}`, i))
    const segs = [seg(0, 0, 40, '', words)]
    const out = getLiveCaptionText(segs, 40, 25)
    expect(out.split(' ').length).toBe(25)
    expect(out.split(' ')[0]).toBe('x15') // 40 − 25
    expect(out.split(' ').at(-1)).toBe('x39')
  })

  it('uses DEFAULT_LIVE_CAPTION_MAX_WORDS when maxWords omitted', () => {
    expect(DEFAULT_LIVE_CAPTION_MAX_WORDS).toBeGreaterThan(0)
    const words: WhisperWord[] = []
    for (let i = 0; i < DEFAULT_LIVE_CAPTION_MAX_WORDS + 5; i++) words.push(w(`x${i}`, i))
    const segs = [seg(0, 0, 100, '', words)]
    const out = getLiveCaptionText(segs, 100)
    expect(out.split(' ').length).toBe(DEFAULT_LIVE_CAPTION_MAX_WORDS)
  })

  it('falls back to active-segment text when every segment has empty words[]', () => {
    const segs = [
      seg(0, 0, 5, 'first line', []),
      seg(1, 5, 10, 'second line', []),
      seg(2, 10, 15, 'third line', []),
    ]
    expect(getLiveCaptionText(segs, 7)).toBe('second line')
  })

  it('falls back to empty string in legacy mode when currentTime is before the first segment', () => {
    const segs = [seg(0, 10, 15, 'late line', [])]
    expect(getLiveCaptionText(segs, 5)).toBe('')
  })

  it('mixes word-level coverage: any segment having words triggers word-level path', () => {
    // First segment has words, second doesn't — word-level path wins and the
    // second (text-only) segment is invisible until its words land.
    const segs = [
      seg(0, 0, 2, 'one two', [w('one', 0), w('two', 1)]),
      seg(1, 2, 4, 'three four', []), // legacy, but ignored by word-level path
    ]
    expect(getLiveCaptionText(segs, 3.5)).toBe('one two')
  })

  it('tightens punctuation spacing emitted by Whisper (" , " → ", ")', () => {
    const segs = [seg(0, 0, 5, 'hello , world', [
      w('hello', 0), w(',', 1), w('world', 2),
    ])]
    expect(getLiveCaptionText(segs, 3)).toBe('hello, world')
  })
})
