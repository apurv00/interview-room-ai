import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from '@testing-library/react'
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
vi.mock('../BillingCheckoutDialog', () => ({
  BillingCheckoutDialog: () => null,
}))
vi.mock('../FutureSubscriptionCheckoutDialog', () => ({
  FutureSubscriptionCheckoutDialog: (props: {
    operation: string
    currentPlanKey: string
    targetPlanKey: string
  }) => (
    <div data-testid="future-plan-dialog">
      {props.operation}:{props.currentPlanKey}:{props.targetPlanKey}
    </div>
  ),
}))

import { BillingPricingExperience } from '../BillingPricingExperience'

const ACCOUNT_ID = '64b64c0f2f4e8b6a8c7d9e10'

function paidSummary(cancelAtPeriodEnd: boolean) {
  return {
    schemaVersion: 1,
    environment: 'live',
    customerBillingUiReady: true,
    accountState: 'active',
    saleAvailability: 'available',
    entitlement: {
      initialized: true,
      planKey: 'plus',
      source: 'subscription',
      usagePeriodKey: 'sub-cycle-1',
      interviewsUsed: 0,
      interviewLimit: 10,
      interviewsRemaining: 10,
      premiumResumesUsed: 0,
      premiumResumeLimit: 5,
      premiumResumesRemaining: 5,
      hasFreeBasicResume: true,
      version: 4,
      environmentConsistency: 'verified',
    },
    subscription: {
      state: 'current',
      billingHealth: cancelAtPeriodEnd ? 'ending' : 'healthy',
      planKey: 'plus',
      status: 'active',
      currentPeriodStart: '2026-08-01T00:00:00.000Z',
      currentPeriodEnd: '2026-09-01T00:00:00.000Z',
      cancelAtPeriodEnd,
      discountedCyclesRemaining: 0,
    },
    interviewUnlocks: {},
    resumeEntitlements: {},
    billingProfile: { configured: true, version: 1 },
  }
}

function renderPricing(cancelAtPeriodEnd: boolean) {
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(
    JSON.stringify(paidSummary(cancelAtPeriodEnd)),
    { status: 200, headers: { 'Content-Type': 'application/json' } },
  )))
  return render(
    <BillingPricingExperience
      currentPlan="plus"
      authStatus="authenticated"
      accountId={ACCOUNT_ID}
      refreshSession={vi.fn().mockResolvedValue(undefined)}
    />,
  )
}

beforeEach(() => {
  vi.clearAllMocks()
})

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

describe('paid plan management on Pricing', () => {
  it('locks paid actions and explains a subscription under review', async () => {
    const review = {
      ...paidSummary(false),
      entitlement: {
        ...paidSummary(false).entitlement,
        planKey: 'free',
        source: 'free',
        usagePeriodKey: 'basic:2026-08',
        interviewLimit: 1,
        interviewsRemaining: 1,
        premiumResumeLimit: 0,
        premiumResumesRemaining: 0,
      },
      subscription: {
        state: 'review',
        billingHealth: 'review',
        planKey: 'plus',
      },
    }
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(
      JSON.stringify(review),
      { status: 200, headers: { 'Content-Type': 'application/json' } },
    )))
    render(
      <BillingPricingExperience
        currentPlan="free"
        authStatus="authenticated"
        accountId={ACCOUNT_ID}
        refreshSession={vi.fn().mockResolvedValue(undefined)}
      />,
    )

    await screen.findByRole('heading', {
      name: 'Subscription review in progress',
    })
    const lockedActions = screen.getAllByRole('button', {
      name: 'Billing review in progress',
    })
    expect(lockedActions).toHaveLength(2)
    expect(lockedActions.every((button) => button.hasAttribute('disabled')))
      .toBe(true)
    expect(screen.queryByRole('button', { name: 'Choose Plus' })).toBeNull()
    expect(screen.queryByRole('button', { name: 'Choose Pro' })).toBeNull()
  })

  it('opens a future tier-change flow for the alternate paid plan', async () => {
    renderPricing(false)

    fireEvent.click(await screen.findByRole('button', {
      name: 'Switch to Pro',
    }))
    expect(screen.getByTestId('future-plan-dialog')).toHaveTextContent(
      'tier_change:plus:pro',
    )
  })

  it('offers same-tier resubscribe after period-end cancellation', async () => {
    renderPricing(true)

    const resume = await screen.findByRole('button', {
      name: 'Resume renewal',
    })
    expect(screen.queryByRole('button', {
      name: 'Switch to Pro',
    })).toBeNull()
    fireEvent.click(resume)
    await waitFor(() => {
      expect(screen.getByTestId('future-plan-dialog')).toHaveTextContent(
        'resubscribe:plus:plus',
      )
    })
  })

  it('cancels the exact pending future change from Pricing', async () => {
    const scheduled = {
      ...paidSummary(false),
      scheduledPlanChange: {
        planChangeRequestId: '507f1f77bcf86cd799439005',
        fromPlanKey: 'plus',
        toPlanKey: 'pro',
        status: 'authorization_pending',
        requestedAt: '2026-08-07T10:00:00.000Z',
        effectiveAt: '2026-09-01T00:00:00.000Z',
      },
    }
    let summaryReads = 0
    vi.stubGlobal('confirm', vi.fn(() => true))
    vi.stubGlobal('fetch', vi.fn((input: RequestInfo | URL) => {
      const url = String(input)
      if (url === '/api/billing/me') {
        summaryReads += 1
        return Promise.resolve(new Response(JSON.stringify(
          summaryReads === 1 ? scheduled : paidSummary(false),
        ), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        }))
      }
      if (url === '/api/billing/subscription/plan-change/cancel') {
        return Promise.resolve(new Response(JSON.stringify({
          planChangeRequestId: '507f1f77bcf86cd799439005',
          status: 'cancelled',
          effectiveAt: '2026-09-01T00:00:00.000Z',
          reused: false,
        }), {
          status: 202,
          headers: { 'Content-Type': 'application/json' },
        }))
      }
      throw new Error(`Unexpected request: ${url}`)
    }))
    render(
      <BillingPricingExperience
        currentPlan="plus"
        authStatus="authenticated"
        accountId={ACCOUNT_ID}
        refreshSession={vi.fn().mockResolvedValue(undefined)}
      />,
    )

    fireEvent.click(await screen.findByRole('button', {
      name: 'Cancel scheduled change',
    }))
    await screen.findByText(
      'Pending plan change cancelled. Your current subscription continues unchanged.',
    )
    const cancellationCall = vi.mocked(fetch).mock.calls.find(
      ([input]) => String(input) ===
        '/api/billing/subscription/plan-change/cancel',
    )
    expect(JSON.parse(String(cancellationCall?.[1]?.body))).toEqual({
      planChangeRequestId: '507f1f77bcf86cd799439005',
    })
  })
})
