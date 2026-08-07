import { describe, expect, it } from 'vitest'
import {
  interviewDurationOptionsForUser,
  isBasicPersonalInterviewUser,
  normalizeInterviewDurationForUser,
} from '@interview/config/interviewDurationPolicy'

describe('interview duration policy', () => {
  it('defaults anonymous and personal free candidates to the Basic 10-minute option', () => {
    expect(interviewDurationOptionsForUser()).toEqual([10])
    expect(isBasicPersonalInterviewUser({
      plan: 'free',
      role: 'candidate',
    })).toBe(true)
    expect(normalizeInterviewDurationForUser({
      plan: 'free',
      role: 'candidate',
    }, 30)).toBe(10)
  })

  it.each(['plus', 'pro'])(
    'keeps all product durations available for the %s plan',
    (plan) => {
      const user = { plan, role: 'candidate' }
      expect(interviewDurationOptionsForUser(user)).toEqual([10, 20, 30])
      expect(normalizeInterviewDurationForUser(user, 30)).toBe(30)
    },
  )

  it('does not apply the personal Basic cap to organization accounts', () => {
    const user = {
      plan: 'free',
      role: 'candidate',
      organizationId: '507f1f77bcf86cd799439099',
    }
    expect(isBasicPersonalInterviewUser(user)).toBe(false)
    expect(interviewDurationOptionsForUser(user)).toEqual([10, 20, 30])
  })
})
