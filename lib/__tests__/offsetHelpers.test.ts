import { describe, it, expect } from 'vitest'
import { computeOffsetSeconds } from '../offsetHelpers'

describe('computeOffsetSeconds', () => {
  it('returns offset in seconds for valid timestamp and startedAt', () => {
    const startedAt = 1000000
    const timestamp = 1005000 // 5 seconds later
    expect(computeOffsetSeconds(timestamp, startedAt)).toBe(5)
  })

  it('returns 0 when startedAt is null', () => {
    expect(computeOffsetSeconds(1234567890, null)).toBe(0)
  })

  it('returns 0 when startedAt is 0 (falsy)', () => {
    expect(computeOffsetSeconds(5000, 0)).toBe(0)
  })

  it('clamps negative offset (clock skew) to 0', () => {
    const startedAt = 1005000
    const timestamp = 1000000 // before startedAt
    expect(computeOffsetSeconds(timestamp, startedAt)).toBe(0)
  })

  it('returns 0 when timestamp equals startedAt', () => {
    expect(computeOffsetSeconds(5000, 5000)).toBe(0)
  })

  it('handles sub-second offsets correctly', () => {
    const startedAt = 1000000
    const timestamp = 1000500 // 500ms later
    expect(computeOffsetSeconds(timestamp, startedAt)).toBe(0.5)
  })

  it('handles large offsets', () => {
    const startedAt = 1000000
    const timestamp = startedAt + 3600000 // 1 hour later
    expect(computeOffsetSeconds(timestamp, startedAt)).toBe(3600)
  })
})
