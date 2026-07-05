import { describe, it, expect } from 'vitest'
import { computeEmotionChangeMarkers } from '../emotionChangeMarkers'
import type { FacialSegment } from '@shared/types/multimodal'

// Minimal FacialSegment factory — only dominantExpression matters here.
const seg = (dominantExpression?: string): FacialSegment => ({
  startSec: 0,
  endSec: 30,
  avgEyeContact: 0.8,
  dominantExpression,
  headStability: 0.9,
  gestureLevel: 'minimal',
})

const questions = (n: number) => Array.from({ length: n }, (_, i) => ({ offsetSeconds: i * 60 }))

describe('computeEmotionChangeMarkers', () => {
  it('emits nothing when every question reads neutral (the old wall-of-😐 case)', () => {
    const facial = [seg('neutral'), seg('neutral'), seg('neutral')]
    expect(computeEmotionChangeMarkers(facial, questions(3))).toEqual([])
  })

  it('marks only the START of a sustained non-neutral run, once', () => {
    // neutral, neutral, smile, smile, neutral, focused
    const facial = [seg('neutral'), seg('neutral'), seg('smile'), seg('smile'), seg('neutral'), seg('focused')]
    expect(computeEmotionChangeMarkers(facial, questions(6))).toEqual([
      { sec: 120, expression: 'smile' }, // Q3 (index 2 → 2*60)
      { sec: 300, expression: 'focused' }, // Q6 (index 5 → 5*60)
    ])
  })

  it('does not emit a marker for a change back to neutral', () => {
    const facial = [seg('smile'), seg('neutral'), seg('smile')]
    // smile@0, (neutral@60 = no marker), smile@120 (new run → marker)
    expect(computeEmotionChangeMarkers(facial, questions(3))).toEqual([
      { sec: 0, expression: 'smile' },
      { sec: 120, expression: 'smile' },
    ])
  })

  it('marks a direct non-neutral → non-neutral transition', () => {
    const facial = [seg('smile'), seg('frown')]
    expect(computeEmotionChangeMarkers(facial, questions(2))).toEqual([
      { sec: 0, expression: 'smile' },
      { sec: 60, expression: 'frown' },
    ])
  })

  it('skips no-data windows without resetting the run', () => {
    // smile, (no data), smile → still one continuous smile run, one marker
    const facial = [seg('smile'), seg(undefined), seg('smile')]
    expect(computeEmotionChangeMarkers(facial, questions(3))).toEqual([
      { sec: 0, expression: 'smile' },
    ])
  })

  it('returns empty for no facial data at all', () => {
    expect(computeEmotionChangeMarkers([], questions(3))).toEqual([])
    expect(computeEmotionChangeMarkers([undefined, undefined], questions(2))).toEqual([])
  })
})
