import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { CONSUMER_CATALOG_V1 } from '@shared/services/planConfig'
import { saveBillingCheckoutRecovery } from '../billingIntentStorage'
import { billingResponseSchemas } from '../billingClient'

const mocks = vi.hoisted(() => ({
  checkoutProps: vi.fn(),
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
    reload: vi.fn(),
  }),
}))

vi.mock('../BillingCheckoutDialog', () => ({
  BillingCheckoutDialog: (props: Record<string, unknown>) => {
    mocks.checkoutProps(props)
    return <div data-testid="direct-checkout-controller" />
  },
}))

vi.mock('../FutureSubscriptionCheckoutDialog', () => ({
  FutureSubscriptionCheckoutDialog: () => null,
}))

import { BillingPricingExperience } from '../BillingPricingExperience'

const ACCOUNT_ID = '64b64c0f2f4e8b6a8c7d9e10'
const CUSTOMER_EMAIL = 'customer@example.com'

const summary = {
  schemaVersion: 1,
  environment: 'live',
  customerBillingUiReady: true,
  accountState: 'active',
  saleAvailability: 'available',
  entitlement: {
    initialized: true,
    planKey: 'free',
    source: 'free',
    usagePeriodKey: '2026-08',
    interviewsUsed: 0,
    interviewLimit: 1,
    interviewsRemaining: 1,
    premiumResumesUsed: 0,
    premiumResumeLimit: 0,
    premiumResumesRemaining: 0,
    hasFreeBasicResume: true,
    version: 1,
    environmentConsistency: 'not_applicable',
  },
  subscription: { state: 'none' },
  interviewUnlocks: {},
  resumeEntitlements: {},
  billingProfile: { configured: true, version: 1 },
}

function quote(
  planKey: 'plus' | 'pro',
  manualCodeResult?: 'applied' | 'invalid' | 'ineligible',
) {
  const listPricePaise = planKey === 'plus' ? 59_900 : 99_900
  const discountPaise = manualCodeResult === 'applied' ? 10_000 : 0
  const displayName = planKey === 'plus' ? 'Plus' : 'Pro'
  const termsText = 'Save ₹100 for the first billing cycle.'
  return {
    quoteId: planKey === 'plus'
      ? '123e4567-e89b-42d3-a456-426614174000'
      : '123e4567-e89b-42d3-a456-426614174001',
    expiresAt: '2099-08-08T10:15:00.000Z',
    catalogVersion: catalog.catalogVersion,
    currency: 'INR',
    gstInclusive: true,
    gstRatePercent: 18,
    listPricePaise,
    discountPaise,
    payablePaise: listPricePaise - discountPaise,
    nextChargePaise: listPricePaise,
    planKey,
    renewalPricePaise: listPricePaise,
    ...(manualCodeResult ? { manualCodeResult } : {}),
    ...(manualCodeResult === 'applied'
      ? {
          discountedBillingCycles: 1,
          coupon: {
            campaignId: '84b64c0f2f4e8b6a8c7d9e10',
            revision: 1,
            mode: 'code',
            code: 'GURU100',
            displayText: 'Save ₹100 on your subscription',
            termsText,
            whyApplied: 'Coupon code GURU100 applied.',
          },
        }
      : {}),
    disclosure: {
      summary: `${displayName} monthly subscription`,
      why: manualCodeResult === 'applied'
        ? 'Coupon code GURU100 applied.'
        : 'Standard monthly price.',
      ...(manualCodeResult === 'applied' ? { terms: termsText } : {}),
      gst: 'GST included.',
      cancellation: 'Auto-renews until cancelled.',
    },
    entitlementSummary: {},
  }
}

function response(body: unknown) {
  return Promise.resolve(new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  }))
}

function installFetch(
  manualResult: (planKey: 'plus' | 'pro') =>
    'applied' | 'invalid' | 'ineligible' = () => 'applied',
) {
  const fetchMock = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input)
    if (url === '/api/billing/me') return response(summary)
    if (url === '/api/billing/quote') {
      const body = JSON.parse(String(init?.body)) as {
        planKey: 'plus' | 'pro'
        manualCouponCode?: string
      }
      return response(quote(
        body.planKey,
        body.manualCouponCode ? manualResult(body.planKey) : undefined,
      ))
    }
    throw new Error(`Unexpected request: ${url}`)
  })
  vi.stubGlobal('fetch', fetchMock)
  return fetchMock
}

beforeEach(() => {
  localStorage.clear()
  mocks.checkoutProps.mockReset()
})

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

describe('direct acquisition checkout on Pricing', () => {
  it('does not show coupon or payment-explanation copy before sign-in', () => {
    installFetch()
    render(
      <BillingPricingExperience
        currentPlan="free"
        authStatus="unauthenticated"
        accountId={null}
        refreshSession={vi.fn().mockResolvedValue(undefined)}
      />,
    )

    expect(screen.queryByText(/Sign in from a paid plan below/))
      .not.toBeInTheDocument()
    expect(screen.queryByText(/By selecting Pay/)).not.toBeInTheDocument()
    expect(screen.queryByRole('textbox', {
      name: 'Coupon code (optional)',
    })).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Sign in to buy Plus' }))
      .toBeEnabled()
  })

  it('turns the plan card into the only pre-Razorpay payment click', async () => {
    installFetch()
    render(
      <BillingPricingExperience
        currentPlan="free"
        authStatus="authenticated"
        accountId={ACCOUNT_ID}
        customerEmail={CUSTOMER_EMAIL}
        refreshSession={vi.fn().mockResolvedValue(undefined)}
      />,
    )

    fireEvent.click(await screen.findByRole('button', {
      name: 'Pay ₹599 Now',
    }))

    expect(screen.getByTestId('direct-checkout-controller'))
      .toBeInTheDocument()
    expect(mocks.checkoutProps).toHaveBeenLastCalledWith(
      expect.objectContaining({
        planKey: 'plus',
        autoStart: true,
        customerEmail: CUSTOMER_EMAIL,
      }),
    )
  })

  it('checks a typed coupon on the page and sends its exact code from Pay', async () => {
    installFetch()
    render(
      <BillingPricingExperience
        currentPlan="free"
        authStatus="authenticated"
        accountId={ACCOUNT_ID}
        refreshSession={vi.fn().mockResolvedValue(undefined)}
      />,
    )

    const coupon = await screen.findByRole('textbox', {
      name: 'Coupon code (optional)',
    })
    fireEvent.change(coupon, { target: { value: 'guru100' } })

    await screen.findByText(
      'GURU100 applied to Plus and Pro. The Pay button shows the updated amount.',
    )
    expect(screen.getByRole('button', { name: 'Pay ₹499 Now' }))
      .toBeEnabled()
    fireEvent.click(screen.getByRole('button', { name: 'Pay ₹899 Now' }))

    expect(mocks.checkoutProps).toHaveBeenLastCalledWith(
      expect.objectContaining({
        planKey: 'pro',
        initialManualCouponCode: 'GURU100',
        autoStart: true,
      }),
    )
  })

  it('rechecks a coupon held by an abandoned Plus checkout from one Pro Pay click', async () => {
    saveBillingCheckoutRecovery({
      accountId: ACCOUNT_ID,
      intentId: '74b64c0f2f4e8b6a8c7d9e10',
      planKey: 'plus',
      catalogVersion: catalog.catalogVersion,
      idempotencyKey: 'billing-subscription:previous-plus',
      manualCouponCode: 'GURU100',
    })
    installFetch(() => 'ineligible')
    render(
      <BillingPricingExperience
        currentPlan="free"
        authStatus="authenticated"
        accountId={ACCOUNT_ID}
        refreshSession={vi.fn().mockResolvedValue(undefined)}
      />,
    )

    expect(await screen.findByText('Unfinished Plus payment'))
      .toBeInTheDocument()
    fireEvent.change(screen.getByRole('textbox', {
      name: 'Coupon code (optional)',
    }), { target: { value: 'GURU100' } })

    await screen.findByText(
      /Your previous checkout may hold this coupon/,
    )
    fireEvent.click(screen.getByRole('button', { name: 'Pay ₹999 Now' }))

    await waitFor(() => expect(mocks.checkoutProps)
      .toHaveBeenLastCalledWith(expect.objectContaining({
        planKey: 'pro',
        initialManualCouponCode: 'GURU100',
        autoStart: true,
      })))
  })

  it('does not start checkout while a coupon is authoritatively invalid', async () => {
    installFetch(() => 'invalid')
    render(
      <BillingPricingExperience
        currentPlan="free"
        authStatus="authenticated"
        accountId={ACCOUNT_ID}
        refreshSession={vi.fn().mockResolvedValue(undefined)}
      />,
    )

    fireEvent.change(await screen.findByRole('textbox', {
      name: 'Coupon code (optional)',
    }), { target: { value: 'NOPE100' } })

    await screen.findByText(
      'This coupon is not available for the selected paid plan.',
    )
    const blocked = screen.getAllByRole('button', {
      name: 'Coupon unavailable',
    })
    expect(blocked).toHaveLength(2)
    expect(blocked.every((button) => button.hasAttribute('disabled')))
      .toBe(true)
    expect(mocks.checkoutProps).not.toHaveBeenCalled()
  })
})
