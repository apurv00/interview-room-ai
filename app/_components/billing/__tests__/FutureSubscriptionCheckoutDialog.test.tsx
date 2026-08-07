import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  loadRazorpayCheckout: vi.fn(),
}))

vi.mock('../razorpayBrowser', () => ({
  loadRazorpayCheckout: mocks.loadRazorpayCheckout,
}))

import { FutureSubscriptionCheckoutDialog } from '../FutureSubscriptionCheckoutDialog'

const EFFECTIVE_AT = '2026-09-01T00:00:00.000Z'
const INTENT_ID = '507f1f77bcf86cd799439006'
const CHANGE_ID = '507f1f77bcf86cd799439005'

const checkout = {
  intentId: INTENT_ID,
  providerMode: 'test',
  intentStatus: 'remote_created',
  reused: false,
  checkout: {
    keyId: 'rzp_test_futurekey',
    subscriptionId: 'sub_future123',
  },
  quote: {
    catalogVersion: 'consumer-inr-2026-07-v1',
    planKey: 'pro',
    currency: 'INR',
    gstInclusive: true,
    gstRatePercent: 18,
    listPricePaise: 99_900,
    discountPaise: 0,
    payablePaise: 99_900,
    nextChargePaise: 99_900,
    renewalPricePaise: 99_900,
    mandateAuthorization: {
      amountPaise: 500,
      currency: 'INR',
      captured: false,
      entitlementEffect: 'none',
      disposition: 'razorpay_auto_refund',
    },
    firstPaidCycle: {
      amountPaise: 99_900,
      scheduledAt: EFFECTIVE_AT,
    },
    renewalSchedule: {
      cadence: 'monthly',
      status: 'pending_authorization',
      scheduledAt: EFFECTIVE_AT,
    },
    disclosure: {
      summary: 'Future Pro subscription.',
      why: 'No eligible coupon is applied.',
      gst: 'GST included.',
      cancellation: 'Auto-renews until cancelled.',
    },
    entitlementSummary: {
      kind: 'subscription',
      displayName: 'Pro',
      billingPeriod: 'monthly',
      interview: {
        includedPerPeriod: 25,
        periodOwner: 'razorpay_billing_cycle',
        maxDurationMinutes: 30,
        supportedDurationsMinutes: [10, 20, 30],
        analysisAndReplayIncluded: true,
      },
      resume: {
        basicSavedResumeLimit: 1,
        premiumSavedResumeLimitPerPeriod: 15,
      },
    },
  },
}

function response(body: unknown, status = 200) {
  return Promise.resolve(new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  }))
}

beforeEach(() => {
  vi.clearAllMocks()
  vi.stubGlobal('fetch', vi.fn((input: RequestInfo | URL) => {
    const url = String(input)
    if (url === '/api/billing/subscription/plan-change') {
      return response({
        planChangeRequestId: CHANGE_ID,
        effectiveAt: EFFECTIVE_AT,
        checkout,
        reused: false,
      }, 202)
    }
    if (url === '/api/billing/verify/subscription/future') {
      return response({
        intentId: INTENT_ID,
        planChangeRequestId: CHANGE_ID,
        status: 'scheduled',
        reused: false,
      })
    }
    throw new Error(`Unexpected request: ${url}`)
  }))
  mocks.loadRazorpayCheckout.mockResolvedValue(
    function FakeRazorpay(
      this: { on: () => void; open: () => void },
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
          razorpay_payment_id: 'pay_future123',
          razorpay_signature: 'a'.repeat(64),
        })
      }
    },
  )
})

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

describe('FutureSubscriptionCheckoutDialog', () => {
  it('discloses ₹5 separately and schedules a coupon-free future tier', async () => {
    const onCompleted = vi.fn().mockResolvedValue(undefined)
    render(
      <FutureSubscriptionCheckoutDialog
        operation="tier_change"
        currentPlanKey="plus"
        targetPlanKey="pro"
        effectiveAt={EFFECTIVE_AT}
        onClose={vi.fn()}
        onCompleted={onCompleted}
      />,
    )

    expect(screen.getByText('₹5')).toBeInTheDocument()
    expect(screen.getByText(/grants no paid access/i)).toBeInTheDocument()
    expect(screen.getByText(/No coupon applies/i)).toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', {
      name: 'Review secure mandate',
    }))
    const authorize = await screen.findByRole('button', {
      name: 'Authorize refundable ₹5',
    })
    const scheduleCall = vi.mocked(fetch).mock.calls.find(
      ([input]) => String(input) ===
        '/api/billing/subscription/plan-change',
    )
    expect(JSON.parse(String(scheduleCall?.[1]?.body))).toEqual({
      action: 'schedule',
      targetPlanKey: 'pro',
    })

    fireEvent.click(authorize)
    await waitFor(() => expect(onCompleted).toHaveBeenCalledOnce())
    expect(await screen.findByText(/Pro is scheduled for/i)).toBeInTheDocument()
  })
})
