import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { CONSUMER_CATALOG_V1 } from '@shared/services/planConfig'

const mocks = vi.hoisted(() => ({
  loadRazorpayCheckout: vi.fn(),
  razorpayOptions: null as Record<string, unknown> | null,
}))

vi.mock('../razorpayBrowser', () => ({
  loadRazorpayCheckout: mocks.loadRazorpayCheckout,
}))

import { InterviewUnlockCheckoutDialog } from '../InterviewUnlockCheckoutDialog'

const ACCOUNT_ID = '64b64c0f2f4e8b6a8c7d9e10'
const INTENT_ID = '74b64c0f2f4e8b6a8c7d9e10'

function response(body: unknown, status = 200) {
  return Promise.resolve(new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  }))
}

const catalog = {
  ...CONSUMER_CATALOG_V1,
  effectiveAt: '2026-08-01T00:00:00.000Z',
  customerBillingUiReady: true,
  checkoutRequiresAuthentication: true,
}

const profile = {
  configured: true,
  version: 1,
  placeOfSupply: { stateCode: '20', countryCode: 'IN' },
  updatedAt: '2026-08-07T10:00:00.000Z',
}

const checkout = {
  intentId: INTENT_ID,
  providerMode: 'test',
  intentStatus: 'remote_created',
  reused: false,
  checkout: {
    keyId: 'rzp_test_checkoutkey',
    orderId: 'order_interview123',
  },
  quote: {
    quoteId: '123e4567-e89b-42d3-a456-426614174000',
    expiresAt: '2026-08-07T10:15:00.000Z',
    catalogVersion: CONSUMER_CATALOG_V1.catalogVersion,
    sku: 'single_interview',
    currency: 'INR',
    gstInclusive: true,
    gstRatePercent: 18,
    listPricePaise: 6_900,
    discountPaise: 0,
    payablePaise: 6_900,
    disclosure: {
      summary: 'One additional interview',
      why: 'One-time purchase.',
      gst: 'GST included.',
    },
    entitlementSummary: {
      interviews: 1,
      maxDurationMinutes: 30,
    },
  },
}

beforeEach(() => {
  mocks.razorpayOptions = null
  mocks.loadRazorpayCheckout.mockReset().mockResolvedValue(
    function FakeRazorpay(
      this: { on: () => void; open: () => void },
      options: Record<string, unknown> & {
        handler: (payload: {
          razorpay_payment_id: string
          razorpay_signature: string
        }) => Promise<void>
      },
    ) {
      mocks.razorpayOptions = options
      this.on = () => {}
      this.open = () => {
        void options.handler({
          razorpay_payment_id: 'pay_interview123',
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

describe('InterviewUnlockCheckoutDialog', () => {
  it('saves a first-time billing profile with the versioned mutation contract', async () => {
    const fetchMock = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input)
      if (url === '/api/billing/catalog') return response(catalog)
      if (url === '/api/billing/profile' && init?.method !== 'PUT') {
        return response({ configured: false, version: 0 })
      }
      if (url === '/api/billing/profile' && init?.method === 'PUT') {
        const body = JSON.parse(String(init.body)) as Record<string, unknown>
        expect(body).toMatchObject({
          expectedVersion: 0,
          placeOfSupply: { stateCode: '20', countryCode: 'IN' },
        })
        expect(body.mutationId).toMatch(/^billing-profile:/)
        return response(profile)
      }
      if (url === '/api/billing/orders/interview') {
        return response(checkout, 201)
      }
      throw new Error(`Unexpected request: ${url}`)
    })
    vi.stubGlobal('fetch', fetchMock)

    render(
      <InterviewUnlockCheckoutDialog
        accountId={ACCOUNT_ID}
        onClose={vi.fn()}
        onCompleted={vi.fn()}
      />,
    )

    fireEvent.change(await screen.findByRole('combobox', {
      name: 'Billing state / Union Territory',
    }), { target: { value: '20' } })
    fireEvent.click(screen.getByRole('button', { name: 'Pay ₹69' }))

    await screen.findByRole('button', {
      name: 'Pay securely with Razorpay',
    })
    expect(fetchMock).toHaveBeenCalledWith(
      '/api/billing/profile',
      expect.objectContaining({ method: 'PUT' }),
    )
  })

  it('creates an order checkout without a Razorpay Offer and unlocks only after verification', async () => {
    const fetchMock = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input)
      if (url === '/api/billing/catalog') return response(catalog)
      if (url === '/api/billing/profile' && init?.method !== 'PUT') {
        return response(profile)
      }
      if (url === '/api/billing/orders/interview') {
        expect(init?.body).toBe('{}')
        expect(new Headers(init?.headers).get('Idempotency-Key'))
          .toContain(`billing-interview:${ACCOUNT_ID}:`)
        return response(checkout, 201)
      }
      if (url === '/api/billing/verify/order') {
        return response({
          intentId: INTENT_ID,
          paymentStatus: 'captured',
          status: 'completed',
        })
      }
      throw new Error(`Unexpected request: ${url}`)
    })
    vi.stubGlobal('fetch', fetchMock)
    const onCompleted = vi.fn()

    render(
      <InterviewUnlockCheckoutDialog
        accountId={ACCOUNT_ID}
        onClose={vi.fn()}
        onCompleted={onCompleted}
      />,
    )

    fireEvent.click(await screen.findByRole('button', { name: 'Pay ₹69' }))
    fireEvent.click(await screen.findByRole('button', {
      name: 'Pay securely with Razorpay',
    }))

    await waitFor(() => expect(onCompleted).toHaveBeenCalledOnce())
    expect(mocks.razorpayOptions).toMatchObject({
      key: 'rzp_test_checkoutkey',
      order_id: 'order_interview123',
    })
    expect(mocks.razorpayOptions).not.toHaveProperty('subscription_id')
    expect(mocks.razorpayOptions).not.toHaveProperty('offer_id')
    expect(fetchMock).toHaveBeenCalledWith(
      '/api/billing/verify/order',
      expect.objectContaining({ method: 'POST' }),
    )
  })
})
