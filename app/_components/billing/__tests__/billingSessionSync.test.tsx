import { cleanup, render, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { CONSUMER_CATALOG_V1 } from '@shared/services/planConfig'
import { billingResponseSchemas } from '../billingClient'

const mocks = vi.hoisted(() => ({
  reload: vi.fn(),
}))

const catalog = billingResponseSchemas.catalog.parse({
  ...CONSUMER_CATALOG_V1,
  effectiveAt: '2026-08-01T00:00:00.000Z',
  customerBillingUiReady: true,
  checkoutRequiresAuthentication: true,
})

vi.mock('../usePublicBillingCatalog', () => ({
  usePublicBillingCatalog: () => ({
    catalog,
    error: null,
    loading: false,
    reload: mocks.reload,
  }),
}))

import { BillingPricingExperience } from '../BillingPricingExperience'

const ACCOUNT_ID = '64b64c0f2f4e8b6a8c7d9e10'

function summary(planKey: 'free' | 'plus', cancelAtPeriodEnd = false) {
  const paid = planKey === 'plus'
  return {
    schemaVersion: 1,
    environment: 'live',
    customerBillingUiReady: true,
    accountState: 'active',
    saleAvailability: 'available',
    entitlement: {
      initialized: true,
      planKey,
      source: paid ? 'subscription' : 'free',
      usagePeriodKey: paid ? 'sub-cycle-1' : '2026-08',
      interviewsUsed: 0,
      interviewLimit: paid ? 10 : 1,
      interviewsRemaining: paid ? 10 : 1,
      premiumResumesUsed: 0,
      premiumResumeLimit: paid ? 5 : 0,
      premiumResumesRemaining: paid ? 5 : 0,
      hasFreeBasicResume: true,
      version: 4,
      environmentConsistency: paid ? 'verified' : 'not_applicable',
    },
    subscription: paid ? {
      state: 'current',
      billingHealth: cancelAtPeriodEnd ? 'ending' : 'healthy',
      planKey: 'plus',
      status: 'active',
      currentPeriodStart: '2026-08-01T00:00:00.000Z',
      currentPeriodEnd: '2026-09-01T00:00:00.000Z',
      cancelAtPeriodEnd,
      discountedCyclesRemaining: 0,
    } : { state: 'none' },
    interviewUnlocks: {},
    resumeEntitlements: {},
    billingProfile: { configured: false },
  }
}

beforeEach(() => {
  localStorage.clear()
})

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

describe('billing session convergence', () => {
  it('refreshes a stale paid JWT after the authoritative period-end downgrade', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(
      JSON.stringify(summary('free')),
      { status: 200, headers: { 'Content-Type': 'application/json' } },
    )))
    const refreshSession = vi.fn().mockResolvedValue(undefined)

    render(
      <BillingPricingExperience
        currentPlan="plus"
        authStatus="authenticated"
        accountId={ACCOUNT_ID}
        refreshSession={refreshSession}
      />,
    )

    await waitFor(() => expect(refreshSession).toHaveBeenCalledOnce())
  })

  it('does not downgrade a cancellation that is only scheduled for period end', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(
      JSON.stringify(summary('plus', true)),
      { status: 200, headers: { 'Content-Type': 'application/json' } },
    )))
    const refreshSession = vi.fn().mockResolvedValue(undefined)

    render(
      <BillingPricingExperience
        currentPlan="plus"
        authStatus="authenticated"
        accountId={ACCOUNT_ID}
        refreshSession={refreshSession}
      />,
    )

    await waitFor(() => expect(fetch).toHaveBeenCalledWith(
      '/api/billing/me',
      expect.any(Object),
    ))
    expect(refreshSession).not.toHaveBeenCalled()
  })
})
