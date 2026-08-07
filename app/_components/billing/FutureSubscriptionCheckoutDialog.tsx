'use client'

import Link from 'next/link'
import { useEffect, useRef, useState } from 'react'
import Button from '@shared/ui/Button'
import {
  BillingClientError,
  billingResponseSchemas,
  formatInr,
  parseBillingResponse,
  type FuturePlanChangeSubmission,
  type PaidBillingPlanKey,
} from './billingClient'
import { createBillingIdempotencyKey } from './billingIntentStorage'
import { billingFetch } from './billingRequestTimeout'
import {
  loadRazorpayCheckout,
  type RazorpaySuccessPayload,
} from './razorpayBrowser'

type FutureOperation = 'tier_change' | 'resubscribe'
type FutureStage =
  | 'review'
  | 'preparing'
  | 'final_review'
  | 'opening'
  | 'verifying'
  | 'pending'
  | 'completed'
  | 'manual_review'

interface FutureSubscriptionCheckoutDialogProps {
  operation: FutureOperation
  currentPlanKey: PaidBillingPlanKey
  targetPlanKey: PaidBillingPlanKey
  effectiveAt: string
  onClose: () => void
  onCompleted: () => Promise<void>
}

const VERIFY_WINDOW_MS = 30_000

function planName(planKey: PaidBillingPlanKey): 'Plus' | 'Pro' {
  return planKey === 'pro' ? 'Pro' : 'Plus'
}

function formatDate(value: string): string {
  return new Intl.DateTimeFormat('en-IN', {
    dateStyle: 'medium',
    timeStyle: 'short',
  }).format(new Date(value))
}

function delay(milliseconds: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) {
      reject(signal.reason)
      return
    }
    const handleAbort = () => {
      window.clearTimeout(timeout)
      signal.removeEventListener('abort', handleAbort)
      reject(signal.reason)
    }
    const timeout = window.setTimeout(() => {
      signal.removeEventListener('abort', handleAbort)
      resolve()
    }, milliseconds)
    signal.addEventListener('abort', handleAbort, { once: true })
  })
}

function userFacingError(error: unknown, fallback: string): string {
  return error instanceof BillingClientError ? error.message : fallback
}

export function FutureSubscriptionCheckoutDialog({
  operation,
  currentPlanKey,
  targetPlanKey,
  effectiveAt,
  onClose,
  onCompleted,
}: FutureSubscriptionCheckoutDialogProps) {
  const [stage, setStage] = useState<FutureStage>('review')
  const [prepared, setPrepared] =
    useState<FuturePlanChangeSubmission | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [statusMessage, setStatusMessage] = useState<string | null>(null)
  const [idempotencyKey] = useState(createBillingIdempotencyKey)
  const closeRef = useRef<HTMLButtonElement>(null)
  const verificationAbortRef = useRef<AbortController | null>(null)
  const busy = ['preparing', 'opening', 'verifying'].includes(stage)

  useEffect(() => {
    closeRef.current?.focus()
    return () => verificationAbortRef.current?.abort()
  }, [])

  async function prepareFutureCheckout() {
    if (stage === 'preparing') return
    setStage('preparing')
    setError(null)
    setStatusMessage('Creating the future mandate securely…')
    try {
      const endpoint = operation === 'tier_change'
        ? '/api/billing/subscription/plan-change'
        : '/api/billing/subscription/resubscribe'
      const body = operation === 'tier_change'
        ? { action: 'schedule', targetPlanKey }
        : {}
      const response = await billingFetch(endpoint, {
        method: 'POST',
        headers: {
          Accept: 'application/json',
          'Content-Type': 'application/json',
          'Idempotency-Key': idempotencyKey,
        },
        body: JSON.stringify(body),
      })
      const result = await parseBillingResponse(
        response,
        billingResponseSchemas.futurePlanChange,
        'The plan change could not be prepared.',
      )
      if (
        result.effectiveAt !== effectiveAt ||
        result.checkout.quote.planKey !== targetPlanKey ||
        result.checkout.quote.firstPaidCycle.scheduledAt !== effectiveAt ||
        result.checkout.quote.discountPaise !== 0
      ) {
        throw new BillingClientError(
          502,
          'The returned plan change does not match your selection.',
        )
      }
      setPrepared(result)
      setStatusMessage(
        'Review the refundable ₹5 mandate and future billing date before continuing.',
      )
      setStage('final_review')
    } catch (cause) {
      setError(userFacingError(
        cause,
        'The plan change could not be prepared. Please try again.',
      ))
      setStatusMessage(null)
      setStage('review')
    }
  }

  async function verifyAuthorizationOnce(
    payload: RazorpaySuccessPayload,
    signal: AbortSignal,
  ) {
    const response = await billingFetch(
      '/api/billing/verify/subscription/future',
      {
        method: 'POST',
        headers: {
          Accept: 'application/json',
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          intentId: prepared!.checkout.intentId,
          razorpayPaymentId: payload.razorpay_payment_id,
          razorpaySignature: payload.razorpay_signature,
        }),
        signal,
      },
    )
    return parseBillingResponse(
      response,
      billingResponseSchemas.futureAuthorization,
      'Mandate authorization could not be verified.',
    )
  }

  async function verifyAuthorization(payload: RazorpaySuccessPayload) {
    if (!prepared) return
    verificationAbortRef.current?.abort()
    const controller = new AbortController()
    verificationAbortRef.current = controller
    const deadline = Date.now() + VERIFY_WINDOW_MS
    setStage('verifying')
    setError(null)
    setStatusMessage('Confirming the mandate with Razorpay…')

    while (!controller.signal.aborted && Date.now() < deadline) {
      try {
        const result = await verifyAuthorizationOnce(
          payload,
          controller.signal,
        )
        if (result.planChangeRequestId !== prepared.planChangeRequestId) {
          throw new BillingClientError(
            502,
            'Mandate verification returned a different plan change.',
          )
        }
        if (result.status === 'scheduled') {
          setStage('completed')
          setStatusMessage(
            `${planName(targetPlanKey)} is scheduled for ${formatDate(effectiveAt)}.`,
          )
          await onCompleted()
          return
        }
        if (result.status === 'manual_review') {
          setStage('manual_review')
          setStatusMessage(
            'The mandate needs review. Do not create another plan change.',
          )
          await onCompleted()
          return
        }
        setStatusMessage(
          'Razorpay accepted the mandate. Final scheduling is still being confirmed.',
        )
        await delay(result.pollAfterMs ?? 2_000, controller.signal)
      } catch (cause) {
        if (controller.signal.aborted) return
        if (
          cause instanceof BillingClientError &&
          (cause.status === 429 || cause.status === 503) &&
          Date.now() < deadline
        ) {
          await delay(
            Math.max(2_000, (cause.retryAfterSeconds ?? 2) * 1_000),
            controller.signal,
          )
          continue
        }
        setError(userFacingError(
          cause,
          'Mandate verification is taking longer than expected.',
        ))
        setStage('pending')
        await onCompleted()
        return
      }
    }

    if (!controller.signal.aborted) {
      setStage('pending')
      setStatusMessage(
        'The mandate is still reconciling. Subscription management will show the final state; do not authorize again.',
      )
      await onCompleted()
    }
  }

  async function openRazorpay() {
    if (!prepared || stage === 'opening') return
    setStage('opening')
    setError(null)
    setStatusMessage('Opening Razorpay secure mandate authorization…')
    try {
      const Razorpay = await loadRazorpayCheckout()
      const instance = new Razorpay({
        key: prepared.checkout.checkout.keyId,
        subscription_id: prepared.checkout.checkout.subscriptionId,
        name: 'interviewprep.guru',
        description:
          `${planName(targetPlanKey)} future monthly mandate`,
        handler: verifyAuthorization,
        modal: {
          escape: true,
          confirm_close: true,
          ondismiss: () => {
            setStage('final_review')
            setStatusMessage(
              'Mandate authorization was closed. Retry it here or cancel the pending change in Subscription management.',
            )
          },
        },
        theme: { color: '#2563eb' },
        retry: { enabled: true },
      })
      instance.on('payment.failed', () => {
        setStage('final_review')
        setError(
          'Razorpay could not authorize the mandate. No future plan charge was completed.',
        )
      })
      instance.open()
      setStage('final_review')
      setStatusMessage(
        'Complete the refundable ₹5 mandate in Razorpay. It grants no immediate plan access.',
      )
    } catch {
      setStage('final_review')
      setStatusMessage(null)
      setError(
        'Razorpay Checkout could not be opened. Retry this saved authorization without creating another change.',
      )
    }
  }

  const targetName = planName(targetPlanKey)
  const currentName = planName(currentPlanKey)
  const quote = prepared?.checkout.quote

  return (
    <div
      className="fixed inset-0 z-[110] flex items-center justify-center px-4 py-6"
      role="presentation"
    >
      <button
        type="button"
        aria-label="Close future plan checkout"
        onClick={() => !busy && onClose()}
        className="absolute inset-0 bg-black/55 backdrop-blur-sm"
      />
      <section
        role="dialog"
        aria-modal="true"
        aria-labelledby="future-checkout-title"
        aria-describedby="future-checkout-description"
        className="relative max-h-[calc(100vh-3rem)] w-full max-w-xl overflow-y-auto rounded-2xl border border-[#e1e8ed] bg-white p-6 shadow-2xl sm:p-7"
      >
        <button
          ref={closeRef}
          type="button"
          aria-label="Close future plan checkout"
          onClick={onClose}
          disabled={busy}
          className="absolute right-3 top-3 rounded-lg p-2 text-[#71767b] transition hover:bg-[#f7f9f9] disabled:opacity-40"
        >
          <span aria-hidden="true">×</span>
        </button>

        <div className="pr-8">
          <h2 id="future-checkout-title" className="text-2xl font-semibold text-[#0f1419]">
            {operation === 'tier_change'
              ? `Switch to ${targetName}`
              : `Resume ${targetName}`}
          </h2>
          <p id="future-checkout-description" className="mt-2 text-sm leading-6 text-[#536471]">
            Your {currentName} access does not change today. The future plan
            starts at the current billing-period boundary.
          </p>
        </div>

        <div className="mt-6 rounded-xl border border-[#d8e2ec] bg-[#f7f9fb] p-5">
          <div className="flex items-center justify-between gap-4 text-sm">
            <span className="text-[#536471]">Refundable mandate authorization now</span>
            <strong className="text-[#0f1419]">₹5</strong>
          </div>
          <p className="mt-2 text-xs leading-5 text-[#536471]">
            Razorpay automatically refunds this authorization. It is not a plan
            payment and grants no paid access.
          </p>
          <div className="mt-4 border-t border-[#d8e2ec] pt-4">
            <div className="flex items-center justify-between gap-4 text-sm">
              <span className="text-[#536471]">First {targetName} charge</span>
              <strong className="text-[#0f1419]">
                {quote ? formatInr(quote.firstPaidCycle.amountPaise) : '—'}
              </strong>
            </div>
            <p className="mt-1 text-xs text-[#71767b]">
              Scheduled for {formatDate(effectiveAt)}. No coupon applies to a
              future plan change.
            </p>
          </div>
        </div>

        {error ? (
          <p className="mt-4 rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700" role="alert">
            {error}
          </p>
        ) : null}
        {statusMessage ? (
          <p className="mt-4 text-sm text-[#536471]" role="status">
            {statusMessage}
          </p>
        ) : null}

        <p className="mt-5 text-xs leading-5 text-[#71767b]">
          By continuing, you agree to the <Link href="/terms" className="text-blue-600">Terms</Link>
          {' '}and acknowledge the cancellation terms. Review our{' '}
          <Link href="/privacy" className="text-blue-600">Privacy Policy</Link>.
        </p>

        <div className="mt-6 flex flex-wrap justify-end gap-3">
          <Button type="button" variant="secondary" onClick={onClose} disabled={busy}>
            {stage === 'completed' ? 'Close' : 'Cancel'}
          </Button>
          {stage === 'review' ? (
            <Button type="button" onClick={prepareFutureCheckout}>
              Review secure mandate
            </Button>
          ) : stage === 'preparing' ? (
            <Button type="button" disabled>Preparing…</Button>
          ) : stage === 'final_review' ? (
            <Button type="button" onClick={openRazorpay}>
              Authorize refundable ₹5
            </Button>
          ) : stage === 'opening' || stage === 'verifying' ? (
            <Button type="button" disabled>
              {stage === 'opening' ? 'Opening…' : 'Verifying…'}
            </Button>
          ) : null}
        </div>
      </section>
    </div>
  )
}
