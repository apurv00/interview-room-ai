import { beforeEach, describe, expect, it } from 'vitest'
import { clearAllInterviewStorage } from '@shared/storageKeys'
import {
  readBillingAuthIntent,
  readBillingCheckoutRecovery,
  saveBillingAuthIntent,
  saveBillingCheckoutRecovery,
} from '../billingIntentStorage'

const ACCOUNT_A = '64b64c0f2f4e8b6a8c7d9e10'
const ACCOUNT_B = '64b64c0f2f4e8b6a8c7d9e11'

function saveRecovery(accountId: string, intentId: string) {
  return saveBillingCheckoutRecovery({
    accountId,
    intentId,
    planKey: 'plus',
    catalogVersion: 'consumer-inr-v1',
    idempotencyKey: `billing-subscription:${intentId}`,
  })
}

beforeEach(() => {
  localStorage.clear()
  sessionStorage.clear()
})

describe('billing checkout recovery storage', () => {
  it('keeps recovery isolated to the authenticated account', () => {
    saveRecovery(ACCOUNT_A, '74b64c0f2f4e8b6a8c7d9e10')
    saveRecovery(ACCOUNT_B, '74b64c0f2f4e8b6a8c7d9e11')

    expect(readBillingCheckoutRecovery(ACCOUNT_A)).toMatchObject({
      schemaVersion: 2,
      accountId: ACCOUNT_A,
      intentId: '74b64c0f2f4e8b6a8c7d9e10',
    })
    expect(readBillingCheckoutRecovery(ACCOUNT_B)).toMatchObject({
      schemaVersion: 2,
      accountId: ACCOUNT_B,
      intentId: '74b64c0f2f4e8b6a8c7d9e11',
    })
  })

  it('discards the old unscoped recovery record', () => {
    localStorage.setItem('ipg_billing_checkout_v1', JSON.stringify({
      schemaVersion: 1,
      intentId: '74b64c0f2f4e8b6a8c7d9e10',
      planKey: 'plus',
      catalogVersion: 'consumer-inr-v1',
      idempotencyKey: 'billing-subscription:legacy',
      createdAtMs: Date.now(),
      expiresAtMs: Date.now() + 60_000,
    }))

    expect(readBillingCheckoutRecovery(ACCOUNT_A)).toBeNull()
    expect(localStorage.getItem('ipg_billing_checkout_v1')).toBeNull()
  })

  it('clears every account checkout on identity cleanup but retains pre-auth intent', async () => {
    saveRecovery(ACCOUNT_A, '74b64c0f2f4e8b6a8c7d9e10')
    saveRecovery(ACCOUNT_B, '74b64c0f2f4e8b6a8c7d9e11')
    saveBillingAuthIntent('pro', 'pricing')

    await clearAllInterviewStorage()

    expect(readBillingCheckoutRecovery(ACCOUNT_A)).toBeNull()
    expect(readBillingCheckoutRecovery(ACCOUNT_B)).toBeNull()
    expect(readBillingAuthIntent()).toMatchObject({
      planKey: 'pro',
      surface: 'pricing',
    })
  })
})
