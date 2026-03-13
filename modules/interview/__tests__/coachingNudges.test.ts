import { describe, it, expect } from 'vitest'
import { deriveNudge } from '../config/coachingNudges'
import type { SpeechMetrics } from '@shared/types'

function makeMetrics(overrides: Partial<SpeechMetrics> = {}): SpeechMetrics {
  return {
    wpm: 140,
    fillerRate: 0.03,
    pauseScore: 70,
    ramblingIndex: 0.2,
    totalWords: 50,
    fillerWordCount: 2,
    durationMinutes: 0.5,
    ...overrides,
  }
}

describe('deriveNudge', () => {
  // ── Guard: totalWords < 5 ──
  it('returns null when totalWords < 5', () => {
    expect(deriveNudge(makeMetrics({ totalWords: 4 }), 15)).toBeNull()
  })

  it('returns null when totalWords is 0', () => {
    expect(deriveNudge(makeMetrics({ totalWords: 0 }), 15)).toBeNull()
  })

  // ── WPM too high (> 180) ──
  it('returns slow-down nudge when wpm > 180', () => {
    const nudge = deriveNudge(makeMetrics({ wpm: 181 }), 15)
    expect(nudge).not.toBeNull()
    expect(nudge!.id).toBe('slow-down')
    expect(nudge!.type).toBe('pace')
    expect(nudge!.severity).toBe('warning')
  })

  it('returns null when wpm is exactly 180 (boundary)', () => {
    const nudge = deriveNudge(makeMetrics({ wpm: 180 }), 15)
    // wpm <= 180 should not trigger slow-down
    expect(nudge?.id).not.toBe('slow-down')
  })

  // ── WPM too low (< 100 && elapsed > 10s) ──
  it('returns speed-up nudge when wpm < 100 and elapsed > 10s', () => {
    const nudge = deriveNudge(makeMetrics({ wpm: 80 }), 15)
    expect(nudge).not.toBeNull()
    expect(nudge!.id).toBe('speed-up')
    expect(nudge!.type).toBe('pace')
  })

  it('returns null when wpm < 100 but elapsed <= 10s', () => {
    const nudge = deriveNudge(makeMetrics({ wpm: 80 }), 10)
    expect(nudge?.id).not.toBe('speed-up')
  })

  it('returns null when wpm is exactly 100 (boundary)', () => {
    const nudge = deriveNudge(makeMetrics({ wpm: 100 }), 15)
    expect(nudge?.id).not.toBe('speed-up')
  })

  // ── Filler rate too high (> 0.08) ──
  it('returns fillers nudge when fillerRate > 0.08', () => {
    const nudge = deriveNudge(makeMetrics({ fillerRate: 0.081 }), 15)
    expect(nudge).not.toBeNull()
    expect(nudge!.id).toBe('fillers')
    expect(nudge!.type).toBe('filler')
    expect(nudge!.severity).toBe('warning')
  })

  it('returns null when fillerRate is exactly 0.08 (boundary)', () => {
    const nudge = deriveNudge(makeMetrics({ fillerRate: 0.08 }), 15)
    expect(nudge?.id).not.toBe('fillers')
  })

  // ── Too many words (> 150) ──
  it('returns wrap-up nudge when totalWords > 150', () => {
    const nudge = deriveNudge(makeMetrics({ totalWords: 151 }), 15)
    expect(nudge).not.toBeNull()
    expect(nudge!.id).toBe('wrap-up')
    expect(nudge!.type).toBe('length')
  })

  it('does not trigger wrap-up at exactly 150 words', () => {
    const nudge = deriveNudge(makeMetrics({ totalWords: 150 }), 15)
    expect(nudge?.id).not.toBe('wrap-up')
  })

  // ── Too few words (< 30 && elapsed > 30s) ──
  it('returns more-detail nudge when totalWords < 30 and elapsed > 30s', () => {
    const nudge = deriveNudge(makeMetrics({ totalWords: 20 }), 35)
    expect(nudge).not.toBeNull()
    expect(nudge!.id).toBe('more-detail')
    expect(nudge!.type).toBe('detail')
  })

  it('does not trigger more-detail when elapsed <= 30s', () => {
    const nudge = deriveNudge(makeMetrics({ totalWords: 20 }), 30)
    expect(nudge?.id).not.toBe('more-detail')
  })

  // ── Priority: fast speech takes precedence over filler ──
  it('slow-down takes priority over fillers', () => {
    const nudge = deriveNudge(makeMetrics({ wpm: 200, fillerRate: 0.1 }), 15)
    expect(nudge!.id).toBe('slow-down')
  })

  // ── No nudge when metrics are normal ──
  it('returns null when all metrics are normal', () => {
    const nudge = deriveNudge(makeMetrics(), 15)
    expect(nudge).toBeNull()
  })
})
