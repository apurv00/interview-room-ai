/**
 * Adaptive grace (turn-latency feedback) — selectGraceMs is the pure helper that picks
 * the post-UtteranceEnd grace window. The load-bearing safety property: the adaptive
 * fast-path shortens ONLY a confidently-complete answer; every other case keeps its full
 * legacy window, so it can never raise the mid-pause cutoff risk.
 */
import { describe, it, expect, vi } from 'vitest'

// Top-level imports of the hook module (the helper lives there).
vi.mock('@interview/audio/recordingClock', () => ({ wallClockMsToAudioSeconds: vi.fn(() => 0) }))
vi.mock('@shared/analytics/track', () => ({ track: vi.fn() }))

import { selectGraceMs } from '@interview/hooks/useDeepgramRecognition'

const COMPLETE = 3000
const INCOMPLETE = 4500
const THINKING = 30000
const CONFIDENT = 1100

describe('selectGraceMs — flag OFF (legacy behavior preserved)', () => {
  it('returns the legacy GRACE_MS_BY_INTENT window for every intent, ignoring confidence', () => {
    expect(selectGraceMs('complete', 'I led the migration.', true, false)).toBe(COMPLETE)
    expect(selectGraceMs('incomplete', 'and then I', false, false)).toBe(INCOMPLETE)
    expect(selectGraceMs('thinkingRequest', 'let me think', true, false)).toBe(THINKING)
  })
})

describe('selectGraceMs — flag ON (adaptive fast-path)', () => {
  it('shortens a complete answer when Deepgram is endpoint-confident (speech_final)', () => {
    expect(selectGraceMs('complete', 'I shipped it', true, true)).toBe(CONFIDENT)
  })

  it('shortens a complete answer ending in terminal punctuation (. ? !)', () => {
    expect(selectGraceMs('complete', 'I shipped it.', false, true)).toBe(CONFIDENT)
    expect(selectGraceMs('complete', 'Was it worth it?', false, true)).toBe(CONFIDENT)
    expect(selectGraceMs('complete', 'Absolutely!', false, true)).toBe(CONFIDENT)
    expect(selectGraceMs('complete', 'She said "done."', false, true)).toBe(CONFIDENT) // trailing quote tolerated
  })

  it('keeps the FULL window for a complete answer with NO confidence signal (ambiguous → no cutoff risk)', () => {
    expect(selectGraceMs('complete', 'I shipped it', false, true)).toBe(COMPLETE)
  })

  it('NEVER shortens incomplete answers, even with speech_final + punctuation', () => {
    expect(selectGraceMs('incomplete', 'and then', true, true)).toBe(INCOMPLETE)
    expect(selectGraceMs('incomplete', 'because.', true, true)).toBe(INCOMPLETE)
  })

  it('NEVER shortens thinkingRequest answers', () => {
    expect(selectGraceMs('thinkingRequest', 'let me think.', true, true)).toBe(THINKING)
  })
})
