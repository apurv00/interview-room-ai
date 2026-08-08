import { describe, expect, it } from 'vitest'
import { getPlanLimits } from '../stripe'

describe('legacy plan-limit compatibility', () => {
  it('maps Plus explicitly instead of falling back to Free', () => {
    const plus = getPlanLimits('plus')
    const free = getPlanLimits('free')

    expect(plus).toMatchObject({
      name: 'plus',
      label: 'Plus',
      monthlyInterviewLimit: 10,
      monthlyAnalysisLimit: 10,
      rateLimitPerMin: 30,
      priceMonthly: 599,
    })
    expect(plus).not.toBe(free)
  })
})
