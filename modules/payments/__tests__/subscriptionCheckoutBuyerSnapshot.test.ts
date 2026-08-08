import { describe, expect, it } from 'vitest'
import {
  checkoutBuyerSnapshot,
} from '../services/subscriptionCheckoutService'

describe('individual subscription checkout buyer snapshot', () => {
  it('creates checkout authority without a GST billing profile', () => {
    expect(checkoutBuyerSnapshot({
      name: 'Apurv Abhishek',
      email: 'apurv@example.com',
    })).toEqual({
      name: 'Apurv Abhishek',
      email: 'apurv@example.com',
      purchaseProfile: {
        accountKind: 'individual',
        financialDocumentPolicy: 'not_required',
        version: 1,
      },
    })
  })

  it('still rejects missing server-owned buyer identity', () => {
    expect(() => checkoutBuyerSnapshot({
      name: '',
      email: 'apurv@example.com',
    })).toThrow(expect.objectContaining({ code: 'buyer_unavailable' }))
  })
})
