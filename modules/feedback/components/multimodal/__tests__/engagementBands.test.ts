import { describe, it, expect } from 'vitest'
import { bandForEyeContact, downsampleHeatmap } from '../engagementBands'
import type { FacialSegment } from '@shared/types/multimodal'

function seg(startSec: number, endSec: number, avgEyeContact: number): FacialSegment {
  return {
    startSec,
    endSec,
    avgEyeContact,
    dominantExpression: 'neutral',
    headStability: 0.9,
    gestureLevel: 'moderate',
  } as FacialSegment
}

describe('bandForEyeContact', () => {
  it('returns no-data for null / undefined / non-finite', () => {
    expect(bandForEyeContact(null)).toBe('no-data')
    expect(bandForEyeContact(undefined)).toBe('no-data')
    expect(bandForEyeContact(NaN)).toBe('no-data')
    expect(bandForEyeContact(Infinity)).toBe('no-data')
  })

  it('returns no-data for the -1 sentinel (facialAggregator "no usable frames")', () => {
    expect(bandForEyeContact(-1)).toBe('no-data')
  })

  it('returns no-data for negative values (defensive — should never occur)', () => {
    expect(bandForEyeContact(-0.5)).toBe('no-data')
  })

  it('maps >= 0.75 to "strong"', () => {
    expect(bandForEyeContact(0.75)).toBe('strong')
    expect(bandForEyeContact(0.9)).toBe('strong')
    expect(bandForEyeContact(1)).toBe('strong')
  })

  it('maps 0.50 to 0.749 to "okay"', () => {
    expect(bandForEyeContact(0.5)).toBe('okay')
    expect(bandForEyeContact(0.6)).toBe('okay')
    expect(bandForEyeContact(0.7499)).toBe('okay')
  })

  it('maps 0 to 0.499 to "weak"', () => {
    expect(bandForEyeContact(0)).toBe('weak')
    expect(bandForEyeContact(0.3)).toBe('weak')
    expect(bandForEyeContact(0.4999)).toBe('weak')
  })
})

describe('downsampleHeatmap', () => {
  it('returns [] for undefined / empty input', () => {
    expect(downsampleHeatmap(undefined)).toEqual([])
    expect(downsampleHeatmap([])).toEqual([])
  })

  it('returns [] when maxBuckets is 0 or negative', () => {
    expect(downsampleHeatmap([seg(0, 1, 0.5)], 0)).toEqual([])
    expect(downsampleHeatmap([seg(0, 1, 0.5)], -1)).toEqual([])
  })

  it('passes through unchanged when timeseries fits within maxBuckets', () => {
    const ts = [seg(0, 1, 0.9), seg(1, 2, 0.5), seg(2, 3, 0.3)]
    const out = downsampleHeatmap(ts, 600)
    expect(out).toHaveLength(3)
    expect(out[0].avgEyeContact).toBe(0.9)
    expect(out[1].avgEyeContact).toBe(0.5)
    expect(out[2].avgEyeContact).toBe(0.3)
  })

  it('preserves segment boundaries and exposes sampleCount in pass-through mode', () => {
    const ts = [seg(0, 1, 0.8), seg(1, 2, 0.4)]
    const out = downsampleHeatmap(ts, 600)
    expect(out[0]).toEqual({ startSec: 0, endSec: 1, avgEyeContact: 0.8, sampleCount: 1 })
    expect(out[1]).toEqual({ startSec: 1, endSec: 2, avgEyeContact: 0.4, sampleCount: 1 })
  })

  it('marks sentinel/invalid values as null avgEyeContact in pass-through mode', () => {
    const ts = [seg(0, 1, -1), seg(1, 2, NaN), seg(2, 3, 0.8)]
    const out = downsampleHeatmap(ts, 600)
    expect(out[0].avgEyeContact).toBeNull()
    expect(out[0].sampleCount).toBe(0)
    expect(out[1].avgEyeContact).toBeNull()
    expect(out[2].avgEyeContact).toBe(0.8)
  })

  it('downsamples when timeseries length exceeds maxBuckets', () => {
    // 10 segments, maxBuckets=2 → groupSize=5 → 2 buckets
    const ts = [
      seg(0, 1, 0.9), seg(1, 2, 0.9), seg(2, 3, 0.9), seg(3, 4, 0.9), seg(4, 5, 0.9),
      seg(5, 6, 0.3), seg(6, 7, 0.3), seg(7, 8, 0.3), seg(8, 9, 0.3), seg(9, 10, 0.3),
    ]
    const out = downsampleHeatmap(ts, 2)
    expect(out).toHaveLength(2)
    expect(out[0].avgEyeContact).toBeCloseTo(0.9)
    expect(out[1].avgEyeContact).toBeCloseTo(0.3)
    expect(out[0].startSec).toBe(0)
    expect(out[0].endSec).toBe(5)
    expect(out[1].startSec).toBe(5)
    expect(out[1].endSec).toBe(10)
  })

  it('excludes sentinel values from the bucket mean but keeps the bucket', () => {
    // 4 segments, maxBuckets=1 → all into one bucket. -1 sentinel excluded.
    const ts = [seg(0, 1, 0.8), seg(1, 2, -1), seg(2, 3, 0.6), seg(3, 4, -1)]
    const out = downsampleHeatmap(ts, 1)
    expect(out).toHaveLength(1)
    // mean of (0.8, 0.6) = 0.7
    expect(out[0].avgEyeContact).toBeCloseTo(0.7)
    expect(out[0].sampleCount).toBe(2)
  })

  it('returns null avgEyeContact for a bucket where every input was a sentinel', () => {
    const ts = [seg(0, 1, -1), seg(1, 2, -1), seg(2, 3, -1)]
    const out = downsampleHeatmap(ts, 1)
    expect(out).toHaveLength(1)
    expect(out[0].avgEyeContact).toBeNull()
    expect(out[0].sampleCount).toBe(0)
  })

  it('handles uneven downsample (last bucket smaller)', () => {
    // 7 segments, maxBuckets=3 → groupSize=ceil(7/3)=3 → buckets of 3, 3, 1
    const ts = [
      seg(0, 1, 0.9), seg(1, 2, 0.9), seg(2, 3, 0.9),
      seg(3, 4, 0.5), seg(4, 5, 0.5), seg(5, 6, 0.5),
      seg(6, 7, 0.1),
    ]
    const out = downsampleHeatmap(ts, 3)
    expect(out).toHaveLength(3)
    expect(out[0].avgEyeContact).toBeCloseTo(0.9)
    expect(out[1].avgEyeContact).toBeCloseTo(0.5)
    expect(out[2].avgEyeContact).toBeCloseTo(0.1)
    expect(out[2].sampleCount).toBe(1) // last bucket only has 1 segment
  })

  it('caps the rendered bucket count at maxBuckets even on extreme input', () => {
    const ts = Array.from({ length: 3000 }, (_, i) => seg(i, i + 1, 0.7))
    const out = downsampleHeatmap(ts, 600)
    expect(out.length).toBeLessThanOrEqual(600)
    // Coverage: spans the full 0..3000 range
    expect(out[0].startSec).toBe(0)
    expect(out[out.length - 1].endSec).toBe(3000)
  })
})
