import { describe, it, expect } from 'vitest'
import {
  getShortFormMinAnswers,
  getPlannedQuestionCountForFeedback,
  isSubstantiveSingleTaskInterview,
} from '@interview/services/eval/sessionScoringPolicy'

describe('sessionScoringPolicy', () => {
  it('treats coding and system-design as single-task interviews', () => {
    expect(isSubstantiveSingleTaskInterview('coding')).toBe(true)
    expect(isSubstantiveSingleTaskInterview('system-design')).toBe(true)
    expect(isSubstantiveSingleTaskInterview('behavioral')).toBe(false)
  })

  it('uses min 1 answer for coding/SD and 3 for behavioral', () => {
    expect(getShortFormMinAnswers('coding')).toBe(1)
    expect(getShortFormMinAnswers('system-design')).toBe(1)
    expect(getShortFormMinAnswers('behavioral')).toBe(3)
    expect(getShortFormMinAnswers(undefined)).toBe(3)
  })

  it('uses coding question budget for planned count', () => {
    expect(getPlannedQuestionCountForFeedback('coding', 30)).toBe(2)
    expect(getPlannedQuestionCountForFeedback('system-design', 20)).toBe(1)
    expect(getPlannedQuestionCountForFeedback('behavioral', 20)).toBe(11)
  })
})
