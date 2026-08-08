import { describe, expect, it } from 'vitest'
import { shouldOfferPaidInterviewCheckout } from '../interviewUnlockEligibility'

describe('additional interview checkout eligibility', () => {
  it('opens for an exhausted Basic allowance', () => {
    expect(shouldOfferPaidInterviewCheckout(
      { duration: 10 },
      {
        plan: 'free',
        monthlyInterviewsUsed: 1,
        monthlyInterviewLimit: 1,
      },
    )).toBe(true)
  })

  it('opens for a Basic 20/30-minute interview even before the 10-minute credit is used', () => {
    expect(shouldOfferPaidInterviewCheckout(
      { duration: 30 },
      {
        plan: 'free',
        monthlyInterviewsUsed: 0,
        monthlyInterviewLimit: 1,
      },
    )).toBe(true)
  })

  it('does not intercept available Basic or paid-plan interviews', () => {
    expect(shouldOfferPaidInterviewCheckout(
      { duration: 10 },
      {
        plan: 'free',
        monthlyInterviewsUsed: 0,
        monthlyInterviewLimit: 1,
      },
    )).toBe(false)
    expect(shouldOfferPaidInterviewCheckout(
      { duration: 30 },
      {
        plan: 'plus',
        monthlyInterviewsUsed: 10,
        monthlyInterviewLimit: 10,
      },
    )).toBe(false)
  })
})
