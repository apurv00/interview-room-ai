import { describe, it, expect } from 'vitest'
import { QUESTION_COUNT, PRESSURE_QUESTION_INDEX } from '../interviewConfig'
import type { Duration } from '../types'

const DURATIONS: Duration[] = [10, 20, 30]

describe('QUESTION_COUNT', () => {
  it.each(DURATIONS)(
    '%d-min: total questions = 1 (intro) + (QUESTION_COUNT - 1) AI questions',
    (duration) => {
      const maxQ = QUESTION_COUNT[duration]
      // Loop runs from 1..<maxQ, so AI questions = maxQ - 1
      const aiQuestions = maxQ - 1
      const totalQuestions = 1 + aiQuestions // intro + AI
      expect(totalQuestions).toBeGreaterThanOrEqual(2)
      expect(maxQ).toBeGreaterThanOrEqual(2) // need at least 1 AI question
    }
  )

  it('10-min has 6 total questions (1 intro + 5 AI)', () => {
    expect(1 + (QUESTION_COUNT[10] - 1)).toBe(6)
  })

  it('20-min has 11 total questions (1 intro + 10 AI)', () => {
    expect(1 + (QUESTION_COUNT[20] - 1)).toBe(11)
  })

  it('30-min has 16 total questions (1 intro + 15 AI)', () => {
    expect(1 + (QUESTION_COUNT[30] - 1)).toBe(16)
  })
})

describe('PRESSURE_QUESTION_INDEX', () => {
  it.each(DURATIONS)(
    '%d-min: pressure index is within the loop range [1, QUESTION_COUNT)',
    (duration) => {
      const pressureIdx = PRESSURE_QUESTION_INDEX[duration]
      const maxQ = QUESTION_COUNT[duration]
      expect(pressureIdx).toBeGreaterThanOrEqual(1)
      expect(pressureIdx).toBeLessThan(maxQ)
    }
  )

  it.each(DURATIONS)(
    '%d-min: pressure question is in the latter half of the interview',
    (duration) => {
      const pressureIdx = PRESSURE_QUESTION_INDEX[duration]
      const maxQ = QUESTION_COUNT[duration]
      const midpoint = Math.floor(maxQ / 2)
      expect(pressureIdx).toBeGreaterThanOrEqual(midpoint)
    }
  )
})
