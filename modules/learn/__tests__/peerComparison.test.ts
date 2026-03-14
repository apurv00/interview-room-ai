import { describe, it, expect } from 'vitest'
import { computePercentile } from '@learn/lib/peerComparison'

describe('computePercentile', () => {
  it('returns 50 for empty scores array', () => {
    expect(computePercentile([], 75)).toBe(50)
  })

  it('returns 100 when user score is above all scores', () => {
    expect(computePercentile([10, 20, 30, 40, 50], 60)).toBe(100)
  })

  it('returns 0 when user score is below all scores', () => {
    expect(computePercentile([60, 70, 80, 90, 100], 50)).toBe(0)
  })

  it('computes percentile for score in the middle', () => {
    // [10, 20, 30, 40, 50], user=30
    // bisectLeft=2, bisectRight=3, avg=2.5, percentile = 2.5/5 * 100 = 50
    expect(computePercentile([10, 20, 30, 40, 50], 30)).toBe(50)
  })

  it('handles single element - user below', () => {
    // [50], user=30 → bisectLeft=0, bisectRight=0 → 0/1*100 = 0
    expect(computePercentile([50], 30)).toBe(0)
  })

  it('handles single element - user above', () => {
    // [50], user=70 → bisectLeft=1, bisectRight=1 → 1/1*100 = 100
    expect(computePercentile([50], 70)).toBe(100)
  })

  it('handles single element - user ties', () => {
    // [50], user=50 → bisectLeft=0, bisectRight=1 → 0.5/1*100 = 50
    expect(computePercentile([50], 50)).toBe(50)
  })

  it('handles all ties correctly', () => {
    // [50, 50, 50, 50, 50], user=50
    // bisectLeft=0, bisectRight=5 → avg=2.5, 2.5/5*100 = 50
    expect(computePercentile([50, 50, 50, 50, 50], 50)).toBe(50)
  })

  it('handles score at lower boundary', () => {
    // [10, 20, 30, 40, 50], user=10
    // bisectLeft=0, bisectRight=1 → avg=0.5, 0.5/5*100 = 10
    expect(computePercentile([10, 20, 30, 40, 50], 10)).toBe(10)
  })

  it('handles score at upper boundary', () => {
    // [10, 20, 30, 40, 50], user=50
    // bisectLeft=4, bisectRight=5 → avg=4.5, 4.5/5*100 = 90
    expect(computePercentile([10, 20, 30, 40, 50], 50)).toBe(90)
  })

  it('handles large arrays correctly', () => {
    // 100 scores from 1 to 100
    const scores = Array.from({ length: 100 }, (_, i) => i + 1)
    // user=50 → bisectLeft=49, bisectRight=50, avg=49.5, 49.5/100*100=50 → 50
    expect(computePercentile(scores, 50)).toBe(50)
  })

  it('rounds to nearest integer', () => {
    // [10, 20, 30], user=20
    // bisectLeft=1, bisectRight=2 → avg=1.5, 1.5/3*100 = 50
    expect(computePercentile([10, 20, 30], 20)).toBe(50)
  })

  it('handles duplicates below user score', () => {
    // [10, 10, 10, 50, 60], user=50
    // bisectLeft=3, bisectRight=4 → avg=3.5, 3.5/5*100 = 70
    expect(computePercentile([10, 10, 10, 50, 60], 50)).toBe(70)
  })
})
