'use client'

import { useEffect, useRef, useState } from 'react'
import { z } from 'zod'
import Button from '@shared/ui/Button'
import {
  billingResponseSchemas,
  BillingClientError,
  formatInr,
  parseBillingResponse,
} from './billingClient'
import { createBillingIdempotencyKey } from './billingIntentStorage'
import { billingFetch } from './billingRequestTimeout'
import {
  loadRazorpayCheckout,
  type RazorpaySuccessPayload,
} from './razorpayBrowser'

const POLL_WINDOW_MS = 60_000
const VERIFY_RETRY_MS = 7_000

const INDIA_BILLING_STATES = [
  ['01', 'Jammu and Kashmir'], ['02', 'Himachal Pradesh'],
  ['03', 'Punjab'], ['04', 'Chandigarh'], ['05', 'Uttarakhand'],
  ['06', 'Haryana'], ['07', 'Delhi'], ['08', 'Rajasthan'],
  ['09', 'Uttar Pradesh'], ['10', 'Bihar'], ['11', 'Sikkim'],
  ['12', 'Arunachal Pradesh'], ['13', 'Nagaland'], ['14', 'Manipur'],
  ['15', 'Mizoram'], ['16', 'Tripura'], ['17', 'Meghalaya'],
  ['18', 'Assam'], ['19', 'West Bengal'], ['20', 'Jharkhand'],
  ['21', 'Odisha'], ['22', 'Chhattisgarh'], ['23', 'Madhya Pradesh'],
  ['24', 'Gujarat'], ['26', 'Dadra and Nagar Haveli and Daman and Diu'],
  ['27', 'Maharashtra'], ['29', 'Karnataka'], ['30', 'Goa'],
  ['31', 'Lakshadweep'], ['32', 'Kerala'], ['33', 'Tamil Nadu'],
  ['34', 'Puducherry'], ['35', 'Andaman and Nicobar Islands'],
  ['36', 'Telangana'], ['37', 'Andhra Pradesh'], ['38', 'Ladakh'],
] as const

const OneTimeInterviewCheckoutSchema = z.object({
  intentId: z.string().regex(/^[a-f\d]{24}$/i),
  providerMode: z.enum(['test', 'live']),
  intentStatus: z.literal('remote_created'),
  reused: z.boolean(),
  checkout: z.object({
    keyId: z.string().regex(/^rzp_(?:test|live)_[A-Za-z0-9]+$/),
    orderId: z.string().regex(/^order_[A-Za-z0-9]+$/),
  }).strip(),
  quote: z.object({
    quoteId: z.string().uuid(),
    expiresAt: z.string().datetime(),
    catalogVersion: z.string().min(1),
    sku: z.literal('single_interview'),
    currency: z.literal('INR'),
    gstInclusive: z.literal(true),
    gstRatePercent: z.literal(18),
    listPricePaise: z.number().int().nonnegative(),
    discountPaise: z.literal(0),
    payablePaise: z.number().int().positive(),
    disclosure: z.object({
      summary: z.string(),
      why: z.string(),
      gst: z.literal('GST included.'),
    }).strip(),
    entitlementSummary: z.record(z.string(), z.unknown()),
  }).strip(),
}).strip().superRefine((checkout, context) => {
  if (
    checkout.quote.listPricePaise !== checkout.quote.payablePaise ||
    (checkout.providerMode === 'test') !==
      checkout.checkout.keyId.startsWith('rzp_test_')
  ) {
    context.addIssue({
      code: 'custom',
      message: 'Interview checkout authority is inconsistent',
    })
  }
})

type OneTimeInterviewCheckout = z.infer<
  typeof OneTimeInterviewCheckoutSchema
>

type Stage =
  | 'loading'
  | 'review'
  | 'preparing'
  | 'final_review'
  | 'opening'
  | 'verifying'
  | 'pending'
  | 'manual_review'
  | 'failed'

interface InterviewUnlockCheckoutDialogProps {
  accountId: string
  onClose: () => void
  onCompleted: () => void
}

function messageOf(error: unknown, fallback: string) {
  return error instanceof BillingClientError ? error.message : fallback
}

function idempotencyKey(accountId: string) {
  const random = globalThis.crypto?.randomUUID?.() ??
    `${Date.now()}-${Math.random().toString(36).slice(2)}`
  return `billing-interview:${accountId}:${random}`
}

function wait(ms: number, signal: AbortSignal) {
  return new Promise<void>((resolve, reject) => {
    if (signal.aborted) {
      reject(new DOMException('Aborted', 'AbortError'))
      return
    }
    const timer = window.setTimeout(resolve, ms)
    signal.addEventListener('abort', () => {
      window.clearTimeout(timer)
      reject(new DOMException('Aborted', 'AbortError'))
    }, { once: true })
  })
}

export function InterviewUnlockCheckoutDialog({
  accountId,
  onClose,
  onCompleted,
}: InterviewUnlockCheckoutDialogProps) {
  const [stage, setStage] = useState<Stage>('loading')
  const [listPricePaise, setListPricePaise] = useState(6_900)
  const [stateCode, setStateCode] = useState('')
  const [profileConfigured, setProfileConfigured] = useState(false)
  const [profileVersion, setProfileVersion] = useState(0)
  const [checkout, setCheckout] =
    useState<OneTimeInterviewCheckout | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [statusMessage, setStatusMessage] = useState<string | null>(null)
  const [checkoutKey] = useState(() => idempotencyKey(accountId))
  const abortRef = useRef<AbortController | null>(null)

  const busy = ['preparing', 'opening', 'verifying'].includes(stage)

  useEffect(() => {
    const controller = new AbortController()
    abortRef.current = controller
    const previousOverflow = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    void Promise.all([
      billingFetch('/api/billing/catalog', {
        headers: { Accept: 'application/json' },
        signal: controller.signal,
      }).then((response) => parseBillingResponse(
        response,
        billingResponseSchemas.catalog,
        'Interview pricing could not be loaded.',
      )),
      billingFetch('/api/billing/profile', {
        headers: { Accept: 'application/json' },
        signal: controller.signal,
      }).then((response) => parseBillingResponse(
        response,
        billingResponseSchemas.profile,
        'Your billing state could not be loaded.',
      )),
    ])
      .then(([catalog, profile]) => {
        if (controller.signal.aborted) return
        const product = catalog.oneTimeProducts.single_interview
        if (
          !catalog.customerBillingUiReady ||
          product.listPricePaise <= 0 ||
          product.couponEligible !== false ||
          product.entitlement.maxDurationMinutes !== 30
        ) {
          throw new BillingClientError(
            409,
            'Additional interview checkout is temporarily unavailable.',
          )
        }
        setListPricePaise(product.listPricePaise)
        setProfileConfigured(profile.configured)
        setProfileVersion(profile.configured ? profile.version : 0)
        setStateCode(
          profile.configured ? profile.placeOfSupply.stateCode : '',
        )
        setStage('review')
      })
      .catch((cause: unknown) => {
        if (controller.signal.aborted) return
        setError(messageOf(
          cause,
          'Additional interview checkout is temporarily unavailable.',
        ))
        setStage('failed')
      })
    return () => {
      controller.abort()
      document.body.style.overflow = previousOverflow
    }
  }, [])

  async function persistProfile() {
    if (!stateCode) {
      throw new BillingClientError(
        400,
        'Select your billing state or Union Territory.',
      )
    }
    if (profileConfigured) return
    const response = await billingFetch('/api/billing/profile', {
      method: 'PUT',
      headers: {
        Accept: 'application/json',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        expectedVersion: profileVersion,
        mutationId: createBillingIdempotencyKey().replace(
          'billing-subscription',
          'billing-profile',
        ),
        placeOfSupply: {
          stateCode,
          countryCode: 'IN',
        },
      }),
    })
    const profile = await parseBillingResponse(
      response,
      billingResponseSchemas.profile,
      'Your billing state could not be saved.',
    )
    if (!profile.configured || profile.placeOfSupply.stateCode !== stateCode) {
      throw new BillingClientError(
        409,
        'Your saved billing state did not match the selection.',
      )
    }
    setProfileConfigured(true)
    setProfileVersion(profile.version)
  }

  async function prepareCheckout() {
    if (stage === 'preparing') return
    setStage('preparing')
    setError(null)
    setStatusMessage('Preparing your secure one-time checkout…')
    try {
      await persistProfile()
      const response = await billingFetch('/api/billing/orders/interview', {
        method: 'POST',
        headers: {
          Accept: 'application/json',
          'Content-Type': 'application/json',
          'Idempotency-Key': checkoutKey,
        },
        body: '{}',
      })
      const prepared = await parseBillingResponse(
        response,
        OneTimeInterviewCheckoutSchema,
        'Additional interview checkout could not be prepared.',
      )
      setCheckout(prepared)
      setListPricePaise(prepared.quote.payablePaise)
      setStatusMessage(
        'Review the final one-time amount before opening Razorpay.',
      )
      setStage('final_review')
    } catch (cause) {
      setError(messageOf(
        cause,
        'Additional interview checkout could not be prepared.',
      ))
      setStatusMessage(null)
      setStage('review')
    }
  }

  async function readStatus(signal: AbortSignal) {
    const response = await billingFetch(
      `/api/billing/status/${encodeURIComponent(checkout!.intentId)}`,
      { headers: { Accept: 'application/json' }, signal },
    )
    return parseBillingResponse(
      response,
      billingResponseSchemas.status,
      'Payment status is temporarily unavailable.',
    )
  }

  async function pollUntilTerminal(controller: AbortController) {
    const deadline = Date.now() + POLL_WINDOW_MS
    setStage('pending')
    while (!controller.signal.aborted && Date.now() < deadline) {
      const status = await readStatus(controller.signal)
      if (status.status === 'completed') {
        setStatusMessage('Payment verified. Your interview is ready.')
        onCompleted()
        return
      }
      if (status.status === 'manual_review') {
        setStatusMessage(
          'Payment was captured and needs manual review. Do not pay again.',
        )
        setStage('manual_review')
        return
      }
      if (status.terminal) {
        setError('This checkout did not complete. No interview was unlocked.')
        setStage('failed')
        return
      }
      if (
        status.status === 'awaiting_payment' ||
        status.status === 'preparing'
      ) {
        setStatusMessage(
          'Checkout closed without a captured payment. You can reopen the same order.',
        )
        setStage('final_review')
        return
      }
      await wait(status.pollAfterMs ?? 2_000, controller.signal)
    }
    if (!controller.signal.aborted) {
      setStatusMessage(
        'Payment confirmation is taking longer than expected. Do not pay again.',
      )
      setStage('pending')
    }
  }

  async function verifyPayment(payload: RazorpaySuccessPayload) {
    if (!checkout) return
    abortRef.current?.abort()
    const controller = new AbortController()
    abortRef.current = controller
    const deadline = Date.now() + POLL_WINDOW_MS
    setStage('verifying')
    setError(null)
    setStatusMessage('Verifying captured payment with Razorpay…')
    while (!controller.signal.aborted && Date.now() < deadline) {
      try {
        const response = await billingFetch('/api/billing/verify/order', {
          method: 'POST',
          headers: {
            Accept: 'application/json',
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            intentId: checkout.intentId,
            razorpayPaymentId: payload.razorpay_payment_id,
            razorpaySignature: payload.razorpay_signature,
          }),
          signal: controller.signal,
        })
        const verification = await parseBillingResponse(
          response,
          billingResponseSchemas.verification,
          'Payment verification is temporarily unavailable.',
        )
        if (verification.status === 'completed') {
          setStatusMessage('Payment verified. Your interview is ready.')
          onCompleted()
          return
        }
        if (verification.status === 'manual_review') {
          setStatusMessage(
            'Payment was captured and needs manual review. Do not pay again.',
          )
          setStage('manual_review')
          return
        }
        if (verification.status === 'processing') {
          await pollUntilTerminal(controller)
          return
        }
        await wait(
          Math.max(VERIFY_RETRY_MS, verification.pollAfterMs),
          controller.signal,
        )
      } catch (cause) {
        if (controller.signal.aborted) return
        setError(messageOf(
          cause,
          'Payment verification is temporarily unavailable. Do not pay again.',
        ))
        await pollUntilTerminal(controller).catch(() => undefined)
        return
      }
    }
  }

  async function openRazorpay() {
    if (!checkout || stage === 'opening') return
    setStage('opening')
    setError(null)
    setStatusMessage('Opening Razorpay secure checkout…')
    try {
      const Razorpay = await loadRazorpayCheckout()
      const instance = new Razorpay({
        key: checkout.checkout.keyId,
        order_id: checkout.checkout.orderId,
        name: 'interviewprep.guru',
        description: 'One additional interview (up to 30 minutes)',
        handler: verifyPayment,
        modal: {
          escape: true,
          confirm_close: true,
          ondismiss: () => {
            const controller = new AbortController()
            abortRef.current?.abort()
            abortRef.current = controller
            setStatusMessage(
              'Checkout closed. Confirming that no payment completed…',
            )
            void wait(1_000, controller.signal)
              .then(() => pollUntilTerminal(controller))
              .catch(() => undefined)
          },
        },
        theme: { color: '#2563eb' },
        retry: { enabled: true },
      })
      instance.on('payment.failed', () => {
        const controller = new AbortController()
        abortRef.current?.abort()
        abortRef.current = controller
        setStatusMessage(
          'Razorpay reported a payment problem. Checking before another attempt…',
        )
        void pollUntilTerminal(controller).catch(() => undefined)
      })
      instance.open()
      setStage('pending')
      setStatusMessage('Complete the one-time payment in Razorpay.')
    } catch {
      setError(
        'Razorpay Checkout could not be opened. Reopen the same order to try again.',
      )
      setStage('final_review')
    }
  }

  return (
    <div
      className="fixed inset-0 z-[120] flex items-center justify-center px-4 py-6"
      role="presentation"
    >
      <button
        type="button"
        aria-label="Close additional interview checkout"
        className="absolute inset-0 bg-black/55 backdrop-blur-sm"
        disabled={busy}
        onClick={() => !busy && onClose()}
      />
      <section
        role="dialog"
        aria-modal="true"
        aria-labelledby="interview-unlock-title"
        className="relative max-h-[calc(100vh-3rem)] w-full max-w-lg overflow-y-auto rounded-2xl border border-[#e1e8ed] bg-white p-6 shadow-2xl sm:p-7"
      >
        <button
          type="button"
          aria-label="Close checkout"
          disabled={busy}
          onClick={onClose}
          className="absolute right-3 top-3 rounded-lg p-2 text-[#71767b] hover:bg-[#f7f9f9] disabled:opacity-40"
        >
          ×
        </button>
        <h2
          id="interview-unlock-title"
          className="pr-8 text-xl font-semibold text-[#0f1419]"
        >
          Continue with one more interview
        </h2>
        <p className="mt-2 text-sm text-[#536471]">
          Your included Basic interview is unavailable. Buy one interview for
          a one-time payment—no subscription and no automatic renewal.
        </p>

        <div className="mt-5 rounded-xl border border-[#e1e8ed] bg-[#f8fafc] p-4">
          <div className="flex items-center justify-between">
            <span className="text-sm text-[#536471]">One interview</span>
            <strong className="text-lg text-[#0f1419]">
              {formatInr(checkout?.quote.payablePaise ?? listPricePaise)}
            </strong>
          </div>
          <p className="mt-2 text-xs text-[#71767b]">
            GST included · Any interview type · Up to 30 minutes · Valid for 30 days
          </p>
        </div>

        {stage !== 'loading' && !profileConfigured ? (
          <label className="mt-5 block text-sm font-medium text-[#0f1419]">
            Billing state / Union Territory
            <select
              value={stateCode}
              onChange={(event) => setStateCode(event.target.value)}
              className="mt-2 w-full rounded-xl border border-[#cfd9de] bg-white px-3 py-2.5 text-sm"
            >
              <option value="">Select state</option>
              {INDIA_BILLING_STATES.map(([code, name]) => (
                <option key={code} value={code}>{code} — {name}</option>
              ))}
            </select>
          </label>
        ) : null}

        {statusMessage ? (
          <p className="mt-4 text-sm text-[#536471]" role="status">
            {statusMessage}
          </p>
        ) : null}
        {error ? (
          <p
            className="mt-4 rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700"
            role="alert"
          >
            {error}
          </p>
        ) : null}

        <div className="mt-6 flex justify-end gap-3">
          <Button
            type="button"
            variant="secondary"
            disabled={busy}
            onClick={onClose}
          >
            Cancel
          </Button>
          {stage === 'review' || stage === 'failed' ? (
            <Button
              type="button"
              disabled={!stateCode}
              onClick={prepareCheckout}
            >
              Pay {formatInr(listPricePaise)}
            </Button>
          ) : stage === 'final_review' ? (
            <Button type="button" onClick={openRazorpay}>
              Pay securely with Razorpay
            </Button>
          ) : null}
        </div>
      </section>
    </div>
  )
}
