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
  openRazorpay: vi.fn(),
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
        mocks.openRazorpay()
        void options.handler({
          razorpay_payment_id: 'pay_checkout123',
          razorpay_signature: 'valid-signature',
        })
      }
    },
  )
  mocks.openRazorpay.mockReset()
})

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

describe('BillingCheckoutDialog completion and recovery', () => {
  it('shows the preloaded price immediately and opens Razorpay from one Pay click', async () => {
    let resolveCheckout!: (value: Response) => void
    const pendingCheckout = new Promise<Response>((resolve) => {
      resolveCheckout = resolve
    })
    const fetchMock = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      if (String(input) === '/api/billing/subscriptions/checkout') {
        return pendingCheckout
      }
      return standardFetch(input, init)
    })
    vi.stubGlobal('fetch', fetchMock)

    render(
      <BillingCheckoutDialog
        catalog={catalog}
        planKey="plus"
        accountId={ACCOUNT_ID}
        initialQuote={quote}
        initialSummary={summary}
        refreshSession={vi.fn().mockResolvedValue(undefined)}
        onClose={vi.fn()}
        onCompleted={vi.fn().mockResolvedValue(undefined)}
      />,
    )

    const pay = screen.getByRole('button', {
      name: 'Pay ₹599 Now',
    })
    expect(pay).toBeEnabled()
    expect(screen.queryByRole('button', {
      name: 'Review secure checkout',
    })).not.toBeInTheDocument()
    expect(screen.queryByText(/with Razorpay/i)).not.toBeInTheDocument()
    expect(screen.queryByRole('combobox', {
      name: 'Billing state / Union Territory',
    })).not.toBeInTheDocument()
    expect(screen.queryByText(/GST included/i)).not.toBeInTheDocument()
    expect(fetchMock.mock.calls.some(
      ([input]) => String(input) === '/api/billing/profile',
    )).toBe(false)
    expect(fetchMock.mock.calls.some(
      ([input]) => String(input) === '/api/billing/quote',
    )).toBe(false)
    expect(fetchMock.mock.calls.some(
      ([input]) => String(input) === '/api/billing/me',
    )).toBe(false)

    fireEvent.click(pay)

    expect(screen.getByRole('button', {
      name: 'Pay ₹599 Now',
    })).toBeDisabled()
    expect(screen.getByText('Preparing your secure payment…'))
      .toBeInTheDocument()
    expect(mocks.openRazorpay).not.toHaveBeenCalled()

    resolveCheckout(new Response(JSON.stringify(checkout), {
      status: 201,
      headers: { 'Content-Type': 'application/json' },
    }))
    await waitFor(() => expect(mocks.openRazorpay).toHaveBeenCalledOnce())
  })

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
    mocks.loadRazorpayCheckout.mockResolvedValue(
      function PendingRazorpay(
        this: { on: () => void; open: () => void },
      ) {
        this.on = () => {}
        this.open = () => mocks.openRazorpay()
      },
    )
    const fetchMock = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input)
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
        initialQuote={quote}
        initialSummary={pendingSummary}
        refreshSession={vi.fn().mockResolvedValue(undefined)}
        onClose={vi.fn()}
        onCompleted={vi.fn().mockResolvedValue(undefined)}
      />,
    )

    fireEvent.click(screen.getByRole('button', {
      name: 'Pay ₹599 Now',
    }))

    await waitFor(() => expect(mocks.openRazorpay).toHaveBeenCalledOnce())
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

  it('requires one extra confirmation only when the server price changed', async () => {
    const termsText = 'Save ₹100 for the first billing cycle.'
    const changedCheckout = {
      ...checkout,
      quote: {
        ...checkout.quote,
        discountPaise: 10_000,
        payablePaise: 49_900,
        nextChargePaise: 59_900,
        discountedBillingCycles: 1,
        coupon: {
          campaignId: '84b64c0f2f4e8b6a8c7d9e10',
          revision: 1,
          mode: 'code',
          code: 'GURU100',
          displayText: 'Save ₹100 on your subscription',
          termsText,
        },
        disclosure: {
          ...checkout.quote.disclosure,
          why: 'Coupon code GURU100 applied.',
          terms: termsText,
        },
      },
    }
    vi.stubGlobal('fetch', vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      if (String(input) === '/api/billing/subscriptions/checkout') {
        return response(changedCheckout, 201)
      }
      return standardFetch(input, init)
    }))

    render(
      <BillingCheckoutDialog
        catalog={catalog}
        planKey="plus"
        accountId={ACCOUNT_ID}
        initialQuote={quote}
        initialSummary={summary}
        refreshSession={vi.fn().mockResolvedValue(undefined)}
        onClose={vi.fn()}
        onCompleted={vi.fn().mockResolvedValue(undefined)}
      />,
    )

    fireEvent.click(screen.getByRole('button', {
      name: 'Pay ₹599 Now',
    }))

    expect(await screen.findByText(
      'Your price or coupon terms changed. Review the updated amount before paying.',
    )).toBeInTheDocument()
    expect(mocks.openRazorpay).not.toHaveBeenCalled()
    const updatedPay = screen.getByRole('button', {
      name: 'Pay ₹499 Now',
    })
    expect(updatedPay).toBeEnabled()

    fireEvent.click(updatedPay)
    await waitFor(() => expect(mocks.openRazorpay).toHaveBeenCalledOnce())
  })

  it('requires an edited coupon code to be applied or cleared before Pay', async () => {
    vi.stubGlobal('fetch', vi.fn(standardFetch))

    render(
      <BillingCheckoutDialog
        catalog={catalog}
        planKey="plus"
        accountId={ACCOUNT_ID}
        initialQuote={quote}
        initialSummary={summary}
        refreshSession={vi.fn().mockResolvedValue(undefined)}
        onClose={vi.fn()}
        onCompleted={vi.fn().mockResolvedValue(undefined)}
      />,
    )

    fireEvent.click(screen.getByRole('button', {
      name: 'Have a coupon code?',
    }))
    fireEvent.change(screen.getByRole('textbox', {
      name: 'Coupon code',
    }), { target: { value: 'GURU100' } })

    expect(screen.getByRole('button', {
      name: 'Pay ₹599 Now',
    })).toBeDisabled()
    expect(screen.getByText(
      'Apply or clear the coupon code before paying.',
    )).toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: 'Apply' }))
    await screen.findByText('This code is not available for this checkout.')
    expect(screen.getByRole('button', {
      name: 'Pay ₹599 Now',
    })).toBeEnabled()
  })

  it('does not open Razorpay after the checkout dialog unmounts', async () => {
    let resolveCheckout!: (value: Response) => void
    const pendingCheckout = new Promise<Response>((resolve) => {
      resolveCheckout = resolve
    })
    vi.stubGlobal('fetch', vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      if (String(input) === '/api/billing/subscriptions/checkout') {
        return pendingCheckout
      }
      return standardFetch(input, init)
    }))
    const view = render(
      <BillingCheckoutDialog
        catalog={catalog}
        planKey="plus"
        accountId={ACCOUNT_ID}
        initialQuote={quote}
        initialSummary={summary}
        refreshSession={vi.fn().mockResolvedValue(undefined)}
        onClose={vi.fn()}
        onCompleted={vi.fn().mockResolvedValue(undefined)}
      />,
    )

    fireEvent.click(screen.getByRole('button', {
      name: 'Pay ₹599 Now',
    }))
    view.unmount()
    resolveCheckout(new Response(JSON.stringify(checkout), {
      status: 201,
      headers: { 'Content-Type': 'application/json' },
    }))

    await waitFor(() => {
      expect(readBillingCheckoutRecovery(ACCOUNT_ID)).toMatchObject({
        intentId: INTENT_ID,
        planKey: 'plus',
      })
    })
    expect(mocks.openRazorpay).not.toHaveBeenCalled()
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
        initialQuote={quote}
        initialSummary={summary}
        refreshSession={refreshSession}
        onClose={onClose}
        onCompleted={onCompleted}
      />,
    )

    fireEvent.click(screen.getByRole('button', {
      name: 'Pay ₹599 Now',
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
        initialQuote={quote}
        initialSummary={summary}
        refreshSession={vi.fn().mockResolvedValue(undefined)}
        onClose={onClose}
        onCompleted={onCompleted}
      />,
    )

    fireEvent.click(screen.getByRole('button', {
      name: 'Pay ₹599 Now',
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
        initialQuote={undefined}
        initialSummary={undefined}
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
        initialQuote={quote}
        initialSummary={summary}
        refreshSession={vi.fn().mockResolvedValue(undefined)}
        onClose={vi.fn()}
        onCompleted={vi.fn().mockResolvedValue(undefined)}
      />,
    )

    fireEvent.click(screen.getByRole('button', {
      name: 'Pay ₹599 Now',
    }))

    expect(await screen.findByRole('alert')).toHaveTextContent(
      'Secure checkout could not be prepared.',
    )
    expect(screen.getByRole('button', {
      name: 'Pay ₹599 Now',
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
