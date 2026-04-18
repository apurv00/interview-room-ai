import { describe, it, expect } from 'vitest'
import { appendTranscriptWithoutDuplicates as append } from '@interview/audio/transcriptAppend'

describe('appendTranscriptWithoutDuplicates', () => {
  // ── Empty-string edge cases (identical to pre-fix behavior) ────────────

  it('returns incoming when existing is empty', () => {
    expect(append('', 'Hello world')).toBe('Hello world')
  })

  it('returns existing when incoming is empty', () => {
    expect(append('Hello world', '')).toBe('Hello world')
  })

  it('returns empty string when both are empty', () => {
    expect(append('', '')).toBe('')
  })

  it('trims whitespace in both inputs', () => {
    expect(append('  Hello  ', '  world  ')).toBe('Hello world')
  })

  // ── No-overlap cases (byte-identical to pre-fix concatenation) ─────────

  it('joins with a single space when there is no overlap', () => {
    expect(append('Hello', 'world')).toBe('Hello world')
  })

  it('joins disjoint multi-word phrases with a single space', () => {
    expect(append('Good morning', 'how are you')).toBe('Good morning how are you')
  })

  // ── Production reproducers (session 69e36b369c13dfe7e7ea90a3) ──────────

  it('dedupes "Oh," prefix overlap from session 69e36b369c13dfe7e7ea90a3', () => {
    // Observed logs: "Oh, Oh, So NorthStar was NorthStar was the user."
    // Producing sequence of finals:
    let buf = append('', 'Oh,')
    buf = append(buf, 'Oh, So NorthStar was')
    buf = append(buf, 'NorthStar was the user.')
    expect(buf).toBe('Oh, So NorthStar was the user.')
  })

  it('dedupes "I would" repeated phrase from the same session', () => {
    // Observed: "I would I would I check check I would I would not do anything."
    let buf = append('', 'I would')
    buf = append(buf, 'I would')
    buf = append(buf, 'I check')
    buf = append(buf, 'check')
    buf = append(buf, 'I would')
    buf = append(buf, 'I would not do anything.')
    // Exact intermediate structure depends on how overlaps chain, but the
    // final buffer must not contain the doubled-word pattern.
    expect(buf).not.toMatch(/\bI would I would\b/)
    expect(buf).not.toMatch(/\bcheck check\b/)
    expect(buf.endsWith('not do anything.')).toBe(true)
  })

  it('dedupes "Input was" repeat', () => {
    let buf = append('dealer producer.', 'Input was')
    buf = append(buf, 'Input was user data.')
    expect(buf).toBe('dealer producer. Input was user data.')
  })

  it('dedupes "These are the matrices" repeat', () => {
    let buf = append('', 'These are the matrices')
    buf = append(buf, 'These are the matrices that is')
    buf = append(buf, 'that is you asked that.')
    expect(buf).toBe('These are the matrices that is you asked that.')
  })

  // ── Full-overlap cases ────────────────────────────────────────────────

  it('returns existing unchanged when incoming is fully contained in the tail', () => {
    expect(append('Hello world', 'world')).toBe('Hello world')
  })

  it('returns existing unchanged when incoming exactly matches the tail', () => {
    expect(append('Hello beautiful world', 'beautiful world')).toBe('Hello beautiful world')
  })

  it('returns existing unchanged when incoming equals the full existing', () => {
    expect(append('Hello world', 'Hello world')).toBe('Hello world')
  })

  // ── Case + punctuation tolerance ──────────────────────────────────────

  it('matches overlap case-insensitively', () => {
    expect(append('the User', 'user was present')).toBe('the User was present')
  })

  it('ignores trailing punctuation differences in overlap match', () => {
    // existing ends with "was," new starts with "was" — same word
    expect(append('NorthStar was,', 'was the user.')).toBe('NorthStar was, the user.')
  })

  it('preserves internal apostrophes as part of the word', () => {
    // "don't" and "dont" are NOT equal — no overlap
    expect(append("I don't", 'dont know')).toBe("I don't dont know")
  })

  // ── Longest-overlap preference ────────────────────────────────────────

  it('prefers the longest overlap when multiple are possible', () => {
    // existing ends "...a b a b", incoming starts "a b a b c"
    // k=2 "a b" matches, k=4 "a b a b" also matches — pick k=4
    expect(append('x a b a b', 'a b a b c')).toBe('x a b a b c')
  })

  // ── Word-boundary respect ─────────────────────────────────────────────

  it('does not fuse partial words across the boundary', () => {
    // "working" should not match "work" — we're word-aligned, not char
    expect(append('I was working', 'work with him')).toBe('I was working work with him')
  })

  // ── Single-word cases ─────────────────────────────────────────────────

  it('dedupes a single-word exact repeat', () => {
    expect(append('hello', 'hello')).toBe('hello')
  })

  it('dedupes a single-word case-insensitive repeat', () => {
    expect(append('Hello', 'hello world')).toBe('Hello world')
  })
})
