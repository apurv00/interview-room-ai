import { describe, it, expect } from 'vitest'
import { MINIMUM_TOPICS, QUESTION_COUNT } from '@interview/config/interviewConfig'
import type { Duration } from '@shared/types'

const DURATIONS: Duration[] = [10, 20, 30]

describe('MINIMUM_TOPICS', () => {
  it('has entries for all durations', () => {
    expect(MINIMUM_TOPICS[10]).toBeDefined()
    expect(MINIMUM_TOPICS[20]).toBeDefined()
    expect(MINIMUM_TOPICS[30]).toBeDefined()
  })

  it('has expected values', () => {
    expect(MINIMUM_TOPICS[10]).toBe(4)
    expect(MINIMUM_TOPICS[20]).toBe(7)
    expect(MINIMUM_TOPICS[30]).toBe(10)
  })

  it.each(DURATIONS)('%d-min: MINIMUM_TOPICS <= QUESTION_COUNT', (duration) => {
    expect(MINIMUM_TOPICS[duration]).toBeLessThanOrEqual(QUESTION_COUNT[duration])
  })

  it.each(DURATIONS)('%d-min: values are positive integers', (duration) => {
    expect(MINIMUM_TOPICS[duration]).toBeGreaterThan(0)
    expect(Number.isInteger(MINIMUM_TOPICS[duration])).toBe(true)
  })

  it.each(DURATIONS)('%d-min: longer durations have more topics', (duration) => {
    if (duration > 10) {
      const prevDuration = (duration === 20 ? 10 : 20) as Duration
      expect(MINIMUM_TOPICS[duration]).toBeGreaterThan(MINIMUM_TOPICS[prevDuration])
    }
  })
})
