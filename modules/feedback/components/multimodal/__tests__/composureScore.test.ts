import { describe, it, expect } from 'vitest'
import { composureLevel, composureLevels } from '../composureScore'
import type { ProsodySegment, FacialSegment } from '@shared/types/multimodal'

function prosody(marker: ProsodySegment['confidenceMarker']): ProsodySegment {
  return {
    startSec: 0,
    endSec: 30,
    wpm: 140,
    fillerWords: [],
    pauseDurationSec: 0,
    confidenceMarker: marker,
  } as ProsodySegment
}

function facial(eye: number, stab: number, expr: string = 'neutral'): FacialSegment {
  return {
    startSec: 0,
    endSec: 30,
    avgEyeContact: eye,
    dominantExpression: expr,
    headStability: stab,
    gestureLevel: 'moderate',
  } as FacialSegment
}

describe('composureScore.composureLevel — pure derivation (Round 5b #8)', () => {
  it('returns null when both prosody and facial are missing', () => {
    expect(composureLevel(undefined, undefined)).toBeNull()
  })

  it('returns null when prosody is missing and facial signals are both sentinel (-1)', () => {
    // -1 is the facialAggregator sentinel for "window had no usable frames"
    expect(composureLevel(undefined, facial(-1, -1))).toBeNull()
  })

  it('maps high audio + strong facial to level 3', () => {
    // audio=1.0, facial=(0.9+0.9)/2=0.9 → composite=0.95 → level 3
    expect(composureLevel(prosody('high'), facial(0.9, 0.9))).toBe(3)
  })

  it('maps low audio + weak facial to level 1', () => {
    // audio=0, facial=(0.1+0.1)/2=0.1 → composite=0.05 → level 1
    expect(composureLevel(prosody('low'), facial(0.1, 0.1))).toBe(1)
  })

  it('maps medium-everything to level 2', () => {
    // audio=0.5, facial=(0.5+0.5)/2=0.5 → composite=0.5 → level 2
    expect(composureLevel(prosody('medium'), facial(0.5, 0.5))).toBe(2)
  })

  it('audio-only fallback: high → 3, medium → 2, low → 1 when facial absent', () => {
    expect(composureLevel(prosody('high'), undefined)).toBe(3)
    expect(composureLevel(prosody('medium'), undefined)).toBe(2)
    expect(composureLevel(prosody('low'), undefined)).toBe(1)
  })

  it('audio-only fallback when facial passed but all signals are sentinel/missing', () => {
    expect(composureLevel(prosody('high'), facial(-1, -1))).toBe(3)
  })

  it('facial-only fallback when prosody is missing', () => {
    // facial=(0.8+0.9)/2=0.85 → level 3
    expect(composureLevel(undefined, facial(0.8, 0.9))).toBe(3)
    // facial=(0.4+0.4)/2=0.4 → level 2
    expect(composureLevel(undefined, facial(0.4, 0.4))).toBe(2)
  })

  it('facial mixed sentinel — averages the valid signal only', () => {
    // eye=0.9 valid, stability=-1 sentinel → facial=0.9 → level 3
    expect(composureLevel(undefined, facial(0.9, -1))).toBe(3)
    // eye=-1 sentinel, stability=0.1 valid → facial=0.1 → level 1
    expect(composureLevel(undefined, facial(-1, 0.1))).toBe(1)
  })

  it('clamps out-of-range facial values to [0, 1]', () => {
    // eye=2.0 clamps to 1, stability=-0.5 clamps to 0 → facial=0.5 → level 2
    expect(composureLevel(undefined, facial(2, -0.5))).toBe(2)
  })

  it('threshold check: composite just above 0.67 lands in level 3', () => {
    // audio=0.5 + facial=(0.9+0.9)/2=0.9 → (0.5+0.9)/2=0.7 → 3
    expect(composureLevel(prosody('medium'), facial(0.9, 0.9))).toBe(3)
  })

  it('threshold check: composite just above 0.34 lands in level 2', () => {
    // audio=0 + facial=(0.75+0.75)/2=0.75 → (0+0.75)/2=0.375 → 2
    expect(composureLevel(prosody('low'), facial(0.75, 0.75))).toBe(2)
  })
})

describe('composureScore.composureLevels — array alignment', () => {
  it('aligns by index, padding to questionCount with nulls when arrays are short', () => {
    const out = composureLevels([prosody('high')], [facial(0.9, 0.9)], 3)
    expect(out).toEqual([3, null, null])
  })

  it('returns all nulls when both inputs are undefined', () => {
    expect(composureLevels(undefined, undefined, 4)).toEqual([null, null, null, null])
  })

  it('mixes audio-only and full-signal questions correctly', () => {
    const out = composureLevels(
      [prosody('high'), prosody('low')],
      [facial(0.9, 0.9), undefined as unknown as FacialSegment],
      2,
    )
    // Q1: full signal, composite 0.95 → 3
    // Q2: audio-only, low → 1
    expect(out).toEqual([3, 1])
  })

  it('returns empty array when questionCount is 0', () => {
    expect(composureLevels([prosody('high')], [facial(0.9, 0.9)], 0)).toEqual([])
  })
})
