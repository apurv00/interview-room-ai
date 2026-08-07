import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { CONSUMER_CATALOG_V1 } from '@shared/services/planConfig'
import {
  readBillingCheckoutRecovery,
  saveBillingCheckoutRecovery,
} from '../billingIntentStorage'
import { BillingRequestTimeoutError } from '../billingRequestTimeout'
import { billingResponseSchemas } from '../billingClient'

const mocks = vi.hoisted(() => ({
  loadRazorpayCheckout: vi.fn(),
}))

vi.mock('../razorpayBrowser', () => ({
  loadRazorpayCheckout: mocks.loadRazorpayCheckout,
}))

import { BillingCheckoutDialog } from '../BillingCheckoutDialog'

const ACCOUNT_ID = '64b64c0f2f4e8b6a8c7d9e10'
const INTENT_ID = '74b64c0f2f4e8b6a8c7d9e10'
const NOW = '2026-08-07T10:00:00.000Z'

const catalog = billingResponseSchemas.catalog.parse({
  ...CONSUMER_CATALOG_V1,
  effectiveAt: '2026-08-01T00:00:00.000Z',
  customerBillingUiReady: true,
  checkoutRequiresAuthentication: true,
})

const entitlementSummary = {
  kind: 'subscription',
  displayName: 'Plus',
  billingPeriod: 'monthly',
  interview: {
    includedPerPeriod: 10,
    periodOwner: 'razorpay_billing_cycle',
    maxDurationMinutes: 30,
    supportedDurationsMinutes: [10, 20, 30],
    analysisAndReplayIncluded: true,
  },
  resume: {
    basicSavedResumeLimit: 1,
    premiumSavedResumeLimitPerPeriod: 5,
  },
}

const quote = {
  quoteId: '123e4567-e89b-42d3-a456-426614174000',
  expiresAt: '2026-08-07T10:15:00.000Z',
  catalogVersion: 'consumer-inr-2026-07-v1',
  currency: 'INR',
  gstInclusive: true,
  gstRatePercent: 18,
  listPricePaise: 59_900,
  discountPaise: 0,
  payablePaise: 59_900,
  nextChargePaise: 59_900,
  planKey: 'plus',
  renewalPricePaise: 59_900,
  disclosure: {
    summary: 'Plus monthly subscription',
    why: 'Standard monthly price.',
    gst: 'GST included.',
    cancellation: 'Auto-renews until cancelled.',
  },
  entitlementSummary,
}

const profile = {
  configured: true,
  version: 1,
  placeOfSupply: { stateCode: '20', countryCode: 'IN' },
  updatedAt: NOW,
}

const summary = {
  schemaVersion: 1,
  environment: 'test',
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

const checkout = {
  intentId: INTENT_ID,
  providerMode: 'test',
  intentStatus: 'remote_created',
  reused: false,
  checkout: {
    keyId: 'rzp_test_checkoutkey',
    subscriptionId: 'sub_checkout123',
  },
  quote: {
    catalogVersion: quote.catalogVersion,
    planKey: 'plus',
    currency: 'INR',
    gstInclusive: true,
    gstRatePercent: 18,
    listPricePaise: 59_900,
    discountPaise: 0,
    payablePaise: 59_900,
    nextChargePaise: 59_900,
    renewalPricePaise: 59_900,
    renewalSchedule: {
      cadence: 'monthly',
      status: 'pending_authorization',
      scheduledAt: null,
    },
    disclosure: quote.disclosure,
    entitlementSummary,
  },
}

function response(body: unknown, status = 200) {
  return Promise.resolve(new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  }))
}

function standardFetch(input: RequestInfo | URL, init?: RequestInit) {
  const url = String(input)
  if (url === '/api/billing/quote') return response(quote)
  if (url === '/api/billing/profile' && init?.method !== 'PUT') {
    return response(profile)
  }
  if (url === '/api/billing/me') return response(summary)
  if (url === '/api/billing/subscriptions/checkout') return response(checkout, 201)
  if (url === '/api/billing/verify/subscription') {
    return response({
      intentId: INTENT_ID,
      paymentStatus: 'captured',
      status: 'completed',
    })
  }
  throw new Error(`Unexpected billing request: ${url}`)
}

beforeEach(() => {
  localStorage.clear()
  mocks.loadRazorpayCheckout.mockReset().mockResolvedValue(
    function FakeRazorpay(
      this: {
        on: () => void
        open: () => void
      },
      options: {
        handler: (payload: {
          razorpay_payment_id: string
          razorpay_signature: string
        }) => Promise<void>
      },
    ) {
      this.on = () => {}
      this.open = () => {
        void options.handler({
          razorpay_payment_id: 'pay_checkout123',
          razorpay_signature: 'valid-signature',
        })
      }
    },
  )
})

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

describe('BillingCheckoutDialog completion and recovery', () => {
  it('allows a server-side retry when another device has the pending checkout', async () => {
    const pendingSummary = {
      ...summary,
      subscription: {
        state: 'activation_pending',
        billingHealth: 'pending',
        planKey: 'plus',
        status: 'created',
        cancelAtPeriodEnd: false,
      },
    }
    const recoveredCheckout = { ...checkout, reused: true }
    const fetchMock = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input)
      if (url === '/api/billing/me') return response(pendingSummary)
      if (url === '/api/billing/subscriptions/checkout') {
        return response(recoveredCheckout)
      }
      return standardFetch(input, init)
    })
    vi.stubGlobal('fetch', fetchMock)

    render(
      <BillingCheckoutDialog
        catalog={catalog}
        planKey="plus"
        accountId={ACCOUNT_ID}
        refreshSession={vi.fn().mockResolvedValue(undefined)}
        onClose={vi.fn()}
        onCompleted={vi.fn().mockResolvedValue(undefined)}
      />,
    )

    fireEvent.click(await screen.findByRole('button', {
      name: 'Review secure checkout',
    }))

    expect(await screen.findByRole('button', {
      name: /Pay ₹599 with Razorpay/,
    })).toBeEnabled()
    expect(fetchMock).toHaveBeenCalledWith(
      '/api/billing/subscriptions/checkout',
      expect.objectContaining({ method: 'POST' }),
    )
    expect(readBillingCheckoutRecovery(ACCOUNT_ID)).toMatchObject({
      accountId: ACCOUNT_ID,
      intentId: INTENT_ID,
      planKey: 'plus',
    })
  })

  it('refreshes both NextAuth and billing summary after immediate verification', async () => {
    vi.stubGlobal('fetch', vi.fn(standardFetch))
    const refreshSession = vi.fn().mockResolvedValue(undefined)
    const onCompleted = vi.fn().mockResolvedValue(undefined)
    const onClose = vi.fn()

    render(
      <BillingCheckoutDialog
        catalog={catalog}
        planKey="plus"
        accountId={ACCOUNT_ID}
        refreshSession={refreshSession}
        onClose={onClose}
        onCompleted={onCompleted}
      />,
    )

    const review = await screen.findByRole('button', {
      name: 'Review secure checkout',
    })
    fireEvent.click(review)
    fireEvent.click(await screen.findByRole('button', {
      name: /Pay ₹599 with Razorpay/,
    }))

    await waitFor(() => expect(refreshSession).toHaveBeenCalledOnce())
    expect(onCompleted).toHaveBeenCalledOnce()
    expect(onClose).toHaveBeenCalledOnce()
    expect(screen.queryByText('View active plan')).not.toBeInTheDocument()
    expect(screen.queryByRole('button', {
      name: 'Finish later',
    })).not.toBeInTheDocument()
    expect(readBillingCheckoutRecovery(ACCOUNT_ID)).toBeNull()
  })

  it('does not offer Finish later after payment is received and closes on activation', async () => {
    let statusReads = 0
    vi.stubGlobal('fetch', vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input)
      if (url === '/api/billing/verify/subscription') {
        return response({
          intentId: INTENT_ID,
          paymentStatus: 'captured',
          status: 'processing',
          pollAfterMs: 1_000,
        })
      }
      if (url === `/api/billing/status/${INTENT_ID}`) {
        statusReads += 1
        return response(statusReads === 1
          ? {
              intentId: INTENT_ID,
              kind: 'subscription',
              status: 'processing',
              terminal: false,
              updatedAt: NOW,
              pollAfterMs: 1_000,
            }
          : {
              intentId: INTENT_ID,
              kind: 'subscription',
              status: 'completed',
              terminal: true,
              updatedAt: NOW,
            })
      }
      return standardFetch(input, init)
    }))
    const onClose = vi.fn()
    const onCompleted = vi.fn().mockResolvedValue(undefined)

    render(
      <BillingCheckoutDialog
        catalog={catalog}
        planKey="plus"
        accountId={ACCOUNT_ID}
        refreshSession={vi.fn().mockResolvedValue(undefined)}
        onClose={onClose}
        onCompleted={onCompleted}
      />,
    )

    fireEvent.click(await screen.findByRole('button', {
      name: 'Review secure checkout',
    }))
    fireEvent.click(await screen.findByRole('button', {
      name: /Pay ₹599 with Razorpay/,
    }))

    expect(await screen.findByText(
      'Payment was received and your plan is being activated.',
    )).toBeInTheDocument()
    expect(screen.queryByRole('button', {
      name: 'Finish later',
    })).not.toBeInTheDocument()

    await waitFor(() => expect(onClose).toHaveBeenCalledOnce(), {
      timeout: 3_000,
    })
    expect(onCompleted).toHaveBeenCalledOnce()
  })

  it('refreshes both projections when a recovered checkout is already complete', async () => {
    saveBillingCheckoutRecovery({
      accountId: ACCOUNT_ID,
      intentId: INTENT_ID,
      planKey: 'plus',
      catalogVersion: quote.catalogVersion,
      idempotencyKey: 'billing-subscription:recovered',
    })
    vi.stubGlobal('fetch', vi.fn((input: RequestInfo | URL) => {
      const url = String(input)
      if (url === '/api/billing/quote') return response(quote)
      if (url === `/api/billing/status/${INTENT_ID}`) {
        return response({
          intentId: INTENT_ID,
          kind: 'subscription',
          status: 'completed',
          terminal: true,
          updatedAt: NOW,
        })
      }
      throw new Error(`Unexpected recovery request: ${url}`)
    }))
    const refreshSession = vi.fn().mockResolvedValue(undefined)
    const onCompleted = vi.fn().mockResolvedValue(undefined)
    const onClose = vi.fn()

    render(
      <BillingCheckoutDialog
        catalog={catalog}
        planKey="plus"
        accountId={ACCOUNT_ID}
        refreshSession={refreshSession}
        onClose={onClose}
        onCompleted={onCompleted}
      />,
    )

    await waitFor(() => expect(refreshSession).toHaveBeenCalledOnce())
    expect(onCompleted).toHaveBeenCalledOnce()
    expect(onClose).toHaveBeenCalledOnce()
    expect(readBillingCheckoutRecovery(ACCOUNT_ID)).toBeNull()
  })

  it('returns a timed-out checkout preparation to a closeable review state', async () => {
    vi.stubGlobal('fetch', vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      if (String(input) === '/api/billing/subscriptions/checkout') {
        return Promise.reject(new BillingRequestTimeoutError())
      }
      return standardFetch(input, init)
    }))

    render(
      <BillingCheckoutDialog
        catalog={catalog}
        planKey="plus"
        accountId={ACCOUNT_ID}
        refreshSession={vi.fn().mockResolvedValue(undefined)}
        onClose={vi.fn()}
        onCompleted={vi.fn().mockResolvedValue(undefined)}
      />,
    )

    fireEvent.click(await screen.findByRole('button', {
      name: 'Review secure checkout',
    }))

    expect(await screen.findByRole('alert')).toHaveTextContent(
      'Secure checkout could not be prepared.',
    )
    expect(screen.getByRole('button', {
      name: 'Review secure checkout',
    })).toBeEnabled()
    const closeButtons = screen.getAllByRole('button', {
      name: 'Close checkout',
    })
    expect(closeButtons).toHaveLength(2)
    for (const closeButton of closeButtons) {
      expect(closeButton).toBeEnabled()
    }
  })
})
