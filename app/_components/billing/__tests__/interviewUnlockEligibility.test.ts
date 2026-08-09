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

  it('never intercepts admin-granted accounts (comped users, hire guests) — mirrors the server authority', () => {
    // Long duration AND exhausted quota: the server admission honors the
    // admin_grant branch, so the pre-flight must not contradict it with a
    // personal checkout (a hire candidate saw the ₹69 modal — founder on #605).
    expect(shouldOfferPaidInterviewCheckout(
      { duration: 30 },
      {
        plan: 'free',
        entitlementSource: 'admin_grant',
        monthlyInterviewsUsed: 3,
        monthlyInterviewLimit: 3,
      },
    )).toBe(false)
    // A free account with any OTHER entitlementSource value still gets the
    // normal offer.
    expect(shouldOfferPaidInterviewCheckout(
      { duration: 30 },
      {
        plan: 'free',
        entitlementSource: 'legacy',
        monthlyInterviewsUsed: 0,
        monthlyInterviewLimit: 1,
      },
    )).toBe(true)
  })
})
