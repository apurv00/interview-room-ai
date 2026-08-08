import { render, screen } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  PR6_CUSTOMER_BILLING_UI_READY,
} from '@shared/services/planConfig'

const mocks = vi.hoisted(() => ({
  catalogState: {
    catalog: null as null | Record<string, unknown>,
    error: null as string | null,
    loading: false,
    reload: vi.fn(),
  },
  track: vi.fn(),
}))

vi.mock('../usePublicBillingCatalog', () => ({
  usePublicBillingCatalog: () => mocks.catalogState,
}))

vi.mock('@shared/analytics/track', () => ({
  track: mocks.track,
}))

import { BillingPricingExperience } from '../BillingPricingExperience'

const pausedCatalog = {
  schemaVersion: 1,
  catalogVersion: 'consumer-inr-v1',
  effectiveAt: '2026-07-24T00:00:00.000Z',
  currency: 'INR',
  gstInclusive: true,
  gstRatePercent: 18,
  customerBillingUiReady: false,
  checkoutRequiresAuthentication: true,
  plans: {},
  oneTimeProducts: {},
}

describe('PR6 customer billing dark gate', () => {
  beforeEach(() => {
    mocks.catalogState.catalog = pausedCatalog
    mocks.catalogState.error = null
    mocks.catalogState.loading = false
    mocks.catalogState.reload.mockReset()
    mocks.track.mockReset()
    vi.stubGlobal('fetch', vi.fn())
  })

  it('enables the client code while the runtime catalog can remain paused', () => {
    expect(PR6_CUSTOMER_BILLING_UI_READY).toBe(true)
  })

  it('makes no protected pricing, quote, checkout, or Razorpay request while paused', () => {
    render(
      <BillingPricingExperience
        currentPlan="free"
        authStatus="authenticated"
        accountId="64b64c0f2f4e8b6a8c7d9e10"
        refreshSession={vi.fn().mockResolvedValue(undefined)}
      />,
    )

    expect(
      screen.getByText('Updated pricing is being prepared'),
    ).toBeTruthy()
    expect(fetch).not.toHaveBeenCalled()
    expect(mocks.track).not.toHaveBeenCalled()
    expect(
      document.querySelector(
        'script[src="https://checkout.razorpay.com/v1/checkout.js"]',
      ),
    ).toBeNull()
  })

})
