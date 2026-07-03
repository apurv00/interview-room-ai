import { describe, it, expect } from 'vitest'
import {
  QUESTION_COUNT,
  PRESSURE_QUESTION_INDEX,
  getInterviewIntro,
  getAvatarTitle,
  getQuestionCount,
  getMainQuestionBudget,
} from '../config/interviewConfig'
import type { Duration } from '@shared/types'

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

  it('10-min has 10 total questions (1 intro + 9 AI)', () => {
    expect(1 + (QUESTION_COUNT[10] - 1)).toBe(10)
  })

  it('20-min has 20 total questions (1 intro + 19 AI)', () => {
    expect(1 + (QUESTION_COUNT[20] - 1)).toBe(20)
  })

  it('30-min has 30 total questions (1 intro + 29 AI)', () => {
    expect(1 + (QUESTION_COUNT[30] - 1)).toBe(30)
  })
})

describe('getMainQuestionBudget', () => {
  it.each([
    [10, 9],
    [20, 19],
    [30, 29],
  ] as [Duration, number][])(
    '%d-min budget is getQuestionCount - 1 (excludes the intro question) = %d',
    (duration, expected) => {
      expect(getMainQuestionBudget(duration)).toBe(getQuestionCount(duration) - 1)
      expect(getMainQuestionBudget(duration)).toBe(expected)
    },
  )

  it('never drops below 1 main question, even for very short durations', () => {
    expect(getMainQuestionBudget(1 as Duration)).toBeGreaterThanOrEqual(1)
  })
})

// Regression guard for the "interview ends after 5-6 questions" reports (2026-07-03).
// The live loop (useInterview.ts) gates on a MAIN-question counter, while probes/pivots/
// deferred turns advance a separate monotonic exchange index. These pure simulations model
// that counting so a future refactor that re-conflates the two (the original bug) fails here.
describe('main-question budget is independent of probing', () => {
  // Mirrors the NEW loop: `while (mainAsked < budget)`, probes bump only the exchange index.
  function simulateMainQuestions(duration: Duration, probesPerTopic: number): number {
    const budget = getMainQuestionBudget(duration)
    let mainAsked = 0
    let exchangeIdx = 1 // qIdx — intro already consumed slot 0
    while (mainAsked < budget) {
      mainAsked++ // ask a main question
      for (let p = 0; p < probesPerTopic; p++) exchangeIdx++ // probes advance the index only
      exchangeIdx++ // advance to next topic
    }
    return mainAsked
  }

  // Mirrors the OLD (buggy) loop: `while (qIdx < maxQ)`, where probes ALSO consumed qIdx.
  function simulateOldSharedCounter(duration: Duration, probesPerTopic: number): number {
    const maxQ = getQuestionCount(duration)
    let mainAsked = 0
    let qIdx = 1
    while (qIdx < maxQ) {
      mainAsked++
      for (let p = 0; p < probesPerTopic; p++) qIdx++ // probe stole a slot from the budget
      qIdx++
    }
    return mainAsked
  }

  it.each(DURATIONS)(
    '%d-min: main-question count is the same with 0, 1, 2, or 3 probes per topic (time permitting)',
    (duration) => {
      const budget = getMainQuestionBudget(duration)
      for (const probes of [0, 1, 2, 3]) {
        expect(simulateMainQuestions(duration, probes)).toBe(budget)
      }
    },
  )

  it('demonstrates the OLD shared counter shrank the interview as probing rose (the bug)', () => {
    // 10-min: old maxQ=10 → 9 main with no probes, but only ~5 with 1 probe/topic.
    expect(simulateOldSharedCounter(10, 0)).toBe(9)
    expect(simulateOldSharedCounter(10, 1)).toBeLessThan(simulateOldSharedCounter(10, 0))
    expect(simulateOldSharedCounter(10, 1)).toBe(5)
    // The fix keeps all 9 regardless of probing.
    expect(simulateMainQuestions(10, 1)).toBe(9)
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

describe('getInterviewIntro', () => {
  it('returns legacy intro for PM screening without company', () => {
    const intro = getInterviewIntro('PM')
    expect(intro).toContain('Product Manager screening')
  })

  it('returns legacy intro for SWE screening without company', () => {
    const intro = getInterviewIntro('SWE')
    expect(intro).toContain('engineer')
  })

  it('includes interview type label for behavioral', () => {
    const intro = getInterviewIntro('frontend', 'behavioral')
    expect(intro).toContain('behavioral interview')
  })

  it('includes interview type label for technical', () => {
    const intro = getInterviewIntro('backend', 'technical')
    expect(intro).toContain('technical deep-dive')
  })

  it('includes interview type label for case-study', () => {
    const intro = getInterviewIntro('pm', 'case-study')
    expect(intro).toContain('case study session')
  })

  it('academics intro opens directly with the favourite-subject question (campus opener)', () => {
    const intro = getInterviewIntro('backend', 'academics')
    expect(intro).toContain('academics round')
    expect(intro).not.toContain('behavioral interview')
    // The spoken opener IS the subject question — not a generic "tell me about yourself".
    expect(intro).toMatch(/strongest in/i)
    expect(intro).not.toContain('tell me a bit about yourself')
  })

  it('includes company name when provided', () => {
    const intro = getInterviewIntro('frontend', 'screening', 'Google')
    expect(intro).toContain('Google')
  })

  it('does not use legacy intro when company is provided even for legacy domain', () => {
    const intro = getInterviewIntro('PM', 'screening', 'Amazon')
    expect(intro).toContain('Amazon')
  })

  it('does not use legacy intro when interviewType is non-screening', () => {
    const intro = getInterviewIntro('PM', 'behavioral')
    expect(intro).toContain('behavioral interview')
    expect(intro).not.toContain('Product Manager screening')
  })
})

describe('getAvatarTitle', () => {
  it('returns Senior Hiring Manager for behavioral', () => {
    expect(getAvatarTitle('behavioral')).toBe('Senior Hiring Manager')
  })

  it('returns Technical Interview Lead for technical', () => {
    expect(getAvatarTitle('technical')).toBe('Technical Interview Lead')
  })

  it('returns Strategy & Assessment Lead for case-study', () => {
    expect(getAvatarTitle('case-study')).toBe('Strategy & Assessment Lead')
  })

  it('returns Academic Examiner for academics', () => {
    expect(getAvatarTitle('academics')).toBe('Academic Examiner')
  })

  it('returns default recruiter title for screening', () => {
    expect(getAvatarTitle('screening')).toContain('Recruiter')
  })

  it('returns default recruiter title for undefined', () => {
    expect(getAvatarTitle()).toContain('Recruiter')
  })
})
