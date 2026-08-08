'use client'

import Link from 'next/link'
import {
  useCallback,
  useEffect,
  useRef,
  useState,
} from 'react'
import Button from '@shared/ui/Button'
import Input from '@shared/ui/Input'
import Badge from '@shared/ui/Badge'
import {
  billingResponseSchemas,
  BillingClientError,
  formatInr,
  parseBillingResponse,
  quoteChangedAtCheckout,
  recordCheckoutObservation,
  type BillingIntentStatus,
  type CustomerBillingQuote,
  type CustomerBillingSummary,
  type PaidBillingPlanKey,
  type PublicBillingCatalog,
  type SubscriptionCheckout,
} from './billingClient'
import {
  clearBillingAuthIntent,
  clearBillingCheckoutRecovery,
  createBillingIdempotencyKey,
  readBillingCheckoutRecovery,
  saveBillingCheckoutRecovery,
  type BillingCheckoutRecovery,
} from './billingIntentStorage'
import { billingFetch } from './billingRequestTimeout'
import {
  loadRazorpayCheckout,
  type RazorpaySuccessPayload,
} from './razorpayBrowser'

const VERIFY_RETRY_FLOOR_MS = 7_000
const RECOVERY_POLL_WINDOW_MS = 60_000

type CheckoutStage =
  | 'loading'
  | 'review'
  | 'preparing'
  | 'final_review'
  | 'opening'
  | 'verifying'
  | 'activating'
  | 'pending'
  | 'completed'
  | 'manual_review'
  | 'failed'

interface BillingCheckoutDialogProps {
  catalog: PublicBillingCatalog
  planKey: PaidBillingPlanKey
  accountId: string
  refreshSession: () => Promise<unknown>
  onClose: () => void
  onCompleted: () => Promise<void>
}

function delay(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) {
      reject(new DOMException('Aborted', 'AbortError'))
      return
    }
    const handleAbort = () => {
      window.clearTimeout(timeout)
      reject(new DOMException('Aborted', 'AbortError'))
    }
    const timeout = window.setTimeout(() => {
      signal.removeEventListener('abort', handleAbort)
      resolve()
    }, ms)
    signal.addEventListener('abort', handleAbort, { once: true })
  })
}

function statusCopy(status: BillingIntentStatus['status']): string {
  switch (status) {
    case 'preparing':
      return 'Your secure checkout is still being prepared.'
    case 'awaiting_payment':
      return 'Your existing checkout is waiting for payment.'
    case 'processing':
      return 'Payment was received and your plan is being activated.'
    case 'completed':
      return 'Your plan is active.'
    case 'expired':
      return 'This checkout expired before payment completed.'
    case 'failed':
      return 'This checkout could not be completed.'
    case 'cancelled':
      return 'This checkout was cancelled.'
    case 'manual_review':
      return 'Your payment needs a manual review. You will not be asked to pay again.'
  }
}

function userFacingError(error: unknown, fallback: string): string {
  return error instanceof BillingClientError ? error.message : fallback
}

function assertNewCheckoutAllowed(
  summary: CustomerBillingSummary,
): void {
  if (summary.saleAvailability !== 'available') {
    throw new BillingClientError(
      409,
      summary.saleAvailability === 'account_restricted'
        ? 'Purchases are unavailable while account deletion is pending.'
        : 'Purchases are temporarily unavailable.',
    )
  }
  if (
    summary.subscription.state !== 'none' &&
    summary.subscription.state !== 'activation_pending'
  ) {
    throw new BillingClientError(
      409,
      'An existing subscription is already linked to this account.',
    )
  }
  if (summary.entitlement.planKey !== 'free') {
    throw new BillingClientError(
      409,
      'Your current paid entitlement is managed on the pricing page.',
    )
  }
}

export function BillingCheckoutDialog({
  catalog,
  planKey,
  accountId,
  refreshSession,
  onClose,
  onCompleted,
}: BillingCheckoutDialogProps) {
  const plan = catalog.plans[planKey]
  const [stage, setStage] = useState<CheckoutStage>('loading')
  const [quote, setQuote] = useState<CustomerBillingQuote | null>(null)
  const [checkout, setCheckout] = useState<SubscriptionCheckout | null>(null)
  const [summary, setSummary] = useState<CustomerBillingSummary | null>(null)
  const [manualCode, setManualCode] = useState('')
  const [couponOpen, setCouponOpen] = useState(false)
  const [couponMessage, setCouponMessage] = useState<string | null>(null)
  const [couponApplying, setCouponApplying] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [statusMessage, setStatusMessage] = useState<string | null>(null)
  const [idempotencyKey, setIdempotencyKey] = useState(
    createBillingIdempotencyKey,
  )
  const dialogRef = useRef<HTMLDivElement>(null)
  const closeRef = useRef<HTMLButtonElement>(null)
  const restoreFocusRef = useRef<HTMLElement | null>(null)
  const recoveryAbortRef = useRef<AbortController | null>(null)

  const requestQuote = useCallback(async (
    code?: string,
    signal?: AbortSignal,
  ): Promise<CustomerBillingQuote> => {
    const response = await billingFetch('/api/billing/quote', {
      method: 'POST',
      headers: {
        Accept: 'application/json',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        planKey,
        surface: 'checkout',
        ...(code ? { manualCouponCode: code } : {}),
      }),
      signal,
    })
    const nextQuote = await parseBillingResponse(
      response,
      billingResponseSchemas.quote,
      'Your current price could not be loaded.',
    )
    if (nextQuote.planKey !== planKey) {
      throw new BillingClientError(
        502,
        'Billing returned a different plan. Please try again.',
      )
    }
    return nextQuote
  }, [planKey])

  const loadSummary = useCallback(async (
    signal?: AbortSignal,
  ): Promise<CustomerBillingSummary> => {
    const response = await billingFetch('/api/billing/me', {
      headers: { Accept: 'application/json' },
      signal,
    })
    const nextSummary = await parseBillingResponse(
      response,
      billingResponseSchemas.summary,
      'Your billing account could not be loaded.',
    )
    if (!nextSummary.customerBillingUiReady) {
      throw new BillingClientError(
        409,
        'Purchases are temporarily unavailable.',
      )
    }
    return nextSummary
  }, [])

  const readIntentStatus = useCallback(async (
    intentId: string,
    signal: AbortSignal,
  ): Promise<BillingIntentStatus> => {
    const response = await billingFetch(
      `/api/billing/status/${encodeURIComponent(intentId)}`,
      {
        headers: { Accept: 'application/json' },
        signal,
      },
    )
    return parseBillingResponse(
      response,
      billingResponseSchemas.status,
      'Payment status is temporarily unavailable.',
    )
  }, [])

  const completeCheckout = useCallback(async (
    message: string,
  ): Promise<void> => {
    clearBillingCheckoutRecovery(accountId)
    clearBillingAuthIntent()
    setStatusMessage(message)
    setStage('completed')
    const refreshes = Promise.allSettled([
      refreshSession(),
      onCompleted(),
    ])
    onClose()
    await refreshes
  }, [accountId, onClose, onCompleted, refreshSession])

  const applyTerminalStatus = useCallback(async (
    status: BillingIntentStatus,
  ): Promise<boolean> => {
    setStatusMessage(statusCopy(status.status))
    if (!status.terminal) {
      if (status.status === 'processing') setStage('activating')
      return false
    }

    if (status.status === 'completed') {
      await completeCheckout(statusCopy(status.status))
      return true
    }
    if (status.status === 'manual_review') {
      clearBillingCheckoutRecovery(accountId)
      setStage('manual_review')
      return true
    }
    clearBillingCheckoutRecovery(accountId)
    setStage('failed')
    return true
  }, [accountId, completeCheckout])

  const pollIntent = useCallback(async (
    intentId: string,
    controller: AbortController,
  ): Promise<void> => {
    const deadline = Date.now() + RECOVERY_POLL_WINDOW_MS
    setError(null)

    while (!controller.signal.aborted && Date.now() < deadline) {
      try {
        const status = await readIntentStatus(intentId, controller.signal)
        setStatusMessage(statusCopy(status.status))
        if (await applyTerminalStatus(status)) return
        await delay(
          Math.max(1_000, Math.min(status.pollAfterMs ?? 2_000, 30_000)),
          controller.signal,
        )
      } catch (cause) {
        if (controller.signal.aborted) return
        if (
          cause instanceof BillingClientError &&
          cause.status === 429 &&
          cause.retryAfterSeconds
        ) {
          await delay(
            Math.max(1_000, cause.retryAfterSeconds * 1_000),
            controller.signal,
          )
          continue
        }
        setError(userFacingError(
          cause,
          'Payment status is temporarily unavailable.',
        ))
        setStage('pending')
        return
      }
    }

    if (!controller.signal.aborted) {
      setStage('pending')
      setStatusMessage(
        'Your payment is still pending. Do not start another checkout; you can safely return here or reopen the pricing page later.',
      )
    }
  }, [applyTerminalStatus, readIntentStatus])

  const replayRecoveredCheckout = useCallback(async (
    recovery: BillingCheckoutRecovery,
    signal: AbortSignal,
  ): Promise<void> => {
    const response = await billingFetch('/api/billing/subscriptions/checkout', {
      method: 'POST',
      headers: {
        Accept: 'application/json',
        'Content-Type': 'application/json',
        'Idempotency-Key': recovery.idempotencyKey,
      },
      body: JSON.stringify({
        planKey: recovery.planKey,
        ...(recovery.manualCouponCode
          ? { manualCouponCode: recovery.manualCouponCode }
          : {}),
      }),
      signal,
    })
    const recovered = await parseBillingResponse(
      response,
      billingResponseSchemas.checkout,
      'Your existing checkout could not be reopened.',
    )
    if (
      recovered.intentId !== recovery.intentId ||
      recovered.quote.planKey !== planKey
    ) {
      throw new BillingClientError(
        409,
        'The saved checkout does not match this plan.',
      )
    }
    setIdempotencyKey(recovery.idempotencyKey)
    setManualCode(recovery.manualCouponCode ?? '')
    setCheckout(recovered)
    setStatusMessage(
      'Your existing secure checkout was recovered. Review the final amount before reopening Razorpay.',
    )
    setStage('final_review')
  }, [planKey])

  const resumeRecovery = useCallback(async (
    recovery: BillingCheckoutRecovery,
    controller: AbortController,
  ): Promise<void> => {
    try {
      const status = await readIntentStatus(
        recovery.intentId,
        controller.signal,
      )
      setStatusMessage(statusCopy(status.status))
      if (await applyTerminalStatus(status)) return
      if (
        status.status === 'preparing' ||
        status.status === 'awaiting_payment'
      ) {
        await replayRecoveredCheckout(recovery, controller.signal)
        return
      }
      await pollIntent(recovery.intentId, controller)
    } catch (cause) {
      if (controller.signal.aborted) return
      if (cause instanceof BillingClientError && cause.status === 404) {
        clearBillingCheckoutRecovery(accountId)
        setError(
          'The saved checkout is no longer available for this account.',
        )
        setStage('failed')
        return
      }
      setError(userFacingError(
        cause,
        'Your saved checkout could not be recovered.',
      ))
      setStage('pending')
    }
  }, [
    applyTerminalStatus,
    accountId,
    pollIntent,
    readIntentStatus,
    replayRecoveredCheckout,
  ])

  useEffect(() => {
    restoreFocusRef.current = document.activeElement instanceof HTMLElement
      ? document.activeElement
      : null
    const previousOverflow = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    window.setTimeout(() => closeRef.current?.focus(), 0)
    return () => {
      document.body.style.overflow = previousOverflow
      recoveryAbortRef.current?.abort()
      restoreFocusRef.current?.focus()
    }
  }, [])

  useEffect(() => {
    const controller = new AbortController()
    recoveryAbortRef.current = controller
    const recovery = readBillingCheckoutRecovery(accountId)

    if (recovery?.planKey === planKey) {
      setIdempotencyKey(recovery.idempotencyKey)
      setManualCode(recovery.manualCouponCode ?? '')
      void requestQuote(
        recovery.manualCouponCode,
        controller.signal,
      )
        .then((nextQuote) => {
          if (!controller.signal.aborted) setQuote(nextQuote)
        })
        .catch(() => {
          // Recovery status and the immutable checkout quote remain usable
          // even when a fresh informational quote is unavailable.
        })
      void resumeRecovery(recovery, controller)
      return () => controller.abort()
    }

    void Promise.all([
      requestQuote(undefined, controller.signal),
      loadSummary(controller.signal),
    ])
      .then(([nextQuote, nextSummary]) => {
        if (controller.signal.aborted) return
        setQuote(nextQuote)
        setSummary(nextSummary)
        assertNewCheckoutAllowed(nextSummary)
        setStage('review')
      })
      .catch((cause: unknown) => {
        if (controller.signal.aborted) return
        setError(userFacingError(
          cause,
          'Checkout details could not be loaded.',
        ))
        setStage('failed')
      })

    return () => controller.abort()
  }, [
    accountId,
    loadSummary,
    planKey,
    requestQuote,
    resumeRecovery,
  ])

  function handleDialogKeyDown(
    event: React.KeyboardEvent<HTMLDivElement>,
  ) {
    if (event.key === 'Escape' && !['preparing', 'opening', 'verifying'].includes(stage)) {
      event.preventDefault()
      onClose()
      return
    }
    if (event.key !== 'Tab') return
    const focusable = dialogRef.current?.querySelectorAll<HTMLElement>(
      'button:not([disabled]), a[href], input:not([disabled]), select:not([disabled]), [tabindex]:not([tabindex="-1"])',
    )
    if (!focusable?.length) return
    const first = focusable[0]
    const last = focusable[focusable.length - 1]
    if (event.shiftKey && document.activeElement === first) {
      event.preventDefault()
      last.focus()
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault()
      first.focus()
    }
  }

  async function applyCoupon() {
    if (!quote || couponApplying) return
    const code = manualCode.trim()
    if (code.length < 3) {
      setCouponMessage('Enter a valid coupon code.')
      return
    }
    setCouponApplying(true)
    setCouponMessage(null)
    setError(null)
    try {
      const nextQuote = await requestQuote(code)
      setQuote(nextQuote)
      setCheckout(null)
      setIdempotencyKey(createBillingIdempotencyKey())
      if (
        nextQuote.manualCodeResult === 'applied' &&
        nextQuote.coupon
      ) {
        setCouponMessage(`${nextQuote.coupon.displayText} applied.`)
      } else {
        setCouponMessage(
          nextQuote.manualCodeResult === 'not_better_than_automatic'
            ? 'Your automatic coupon is already better, so we kept it.'
            : nextQuote.manualCodeResult === 'system_unavailable'
              ? 'Coupon validation is temporarily unavailable.'
              : 'This code is not available for this checkout.',
        )
      }
    } catch (cause) {
      setCouponMessage(userFacingError(
        cause,
        'Coupon validation is temporarily unavailable.',
      ))
    } finally {
      setCouponApplying(false)
    }
  }

  async function prepareCheckout() {
    if (!quote || !summary || stage === 'preparing') return
    setStage('preparing')
    setError(null)
    setStatusMessage('Confirming your final price and reserving any coupon…')

    try {
      const latestSummary = await loadSummary()
      assertNewCheckoutAllowed(latestSummary)
      setSummary(latestSummary)
      const response = await billingFetch('/api/billing/subscriptions/checkout', {
        method: 'POST',
        headers: {
          Accept: 'application/json',
          'Content-Type': 'application/json',
          'Idempotency-Key': idempotencyKey,
        },
        body: JSON.stringify({
          planKey,
          ...(manualCode.trim()
            ? { manualCouponCode: manualCode.trim() }
            : {}),
        }),
      })
      const prepared = await parseBillingResponse(
        response,
        billingResponseSchemas.checkout,
        'Secure checkout could not be prepared.',
      )
      if (prepared.quote.planKey !== planKey) {
        throw new BillingClientError(
          502,
          'Billing returned a different plan. Please try again.',
        )
      }
      const changed = quoteChangedAtCheckout(quote, prepared)
      setCheckout(prepared)
      saveBillingCheckoutRecovery({
        accountId,
        intentId: prepared.intentId,
        planKey,
        catalogVersion: prepared.quote.catalogVersion,
        idempotencyKey,
        ...(manualCode.trim()
          ? { manualCouponCode: manualCode.trim() }
          : {}),
      })
      setStatusMessage(
        changed
          ? 'The final checkout price changed. Review the updated amount before opening Razorpay.'
          : 'Your final checkout is ready. Review it before opening Razorpay.',
      )
      setStage('final_review')
    } catch (cause) {
      setError(userFacingError(
        cause,
        'Secure checkout could not be prepared.',
      ))
      setStatusMessage(null)
      setStage('review')
    }
  }

  async function verifyPaymentOnce(
    payload: RazorpaySuccessPayload,
    signal: AbortSignal,
  ) {
    const response = await billingFetch('/api/billing/verify/subscription', {
      method: 'POST',
      headers: {
        Accept: 'application/json',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        intentId: checkout!.intentId,
        razorpayPaymentId: payload.razorpay_payment_id,
        razorpaySignature: payload.razorpay_signature,
      }),
      signal,
    })
    return parseBillingResponse(
      response,
      billingResponseSchemas.verification,
      'Payment verification is temporarily unavailable.',
    )
  }

  async function verifyPayment(payload: RazorpaySuccessPayload) {
    if (!checkout) return
    recoveryAbortRef.current?.abort()
    const controller = new AbortController()
    recoveryAbortRef.current = controller
    const deadline = Date.now() + RECOVERY_POLL_WINDOW_MS
    setStage('verifying')
    setError(null)
    setStatusMessage('Verifying captured payment with Razorpay…')

    while (!controller.signal.aborted && Date.now() < deadline) {
      try {
        const verification = await verifyPaymentOnce(
          payload,
          controller.signal,
        )
        if (verification.status === 'completed') {
          await completeCheckout('Payment verified. Your plan is active.')
          return
        }
        if (verification.status === 'manual_review') {
          clearBillingCheckoutRecovery(accountId)
          setStatusMessage(
            'Payment was captured and needs manual review. Do not pay again.',
          )
          setStage('manual_review')
          return
        }
        if (verification.status === 'processing') {
          setStatusMessage(
            'Payment was captured. Your plan is being activated.',
          )
          await pollIntent(checkout.intentId, controller)
          return
        }
        setStatusMessage(
          'Razorpay is still confirming capture. Do not pay again.',
        )
        await delay(
          Math.max(
            VERIFY_RETRY_FLOOR_MS,
            verification.pollAfterMs,
          ),
          controller.signal,
        )
      } catch (cause) {
        if (controller.signal.aborted) return
        if (
          cause instanceof BillingClientError &&
          cause.status === 429 &&
          cause.retryAfterSeconds
        ) {
          await delay(
            Math.max(
              VERIFY_RETRY_FLOOR_MS,
              cause.retryAfterSeconds * 1_000,
            ),
            controller.signal,
          )
          continue
        }
        setError(userFacingError(
          cause,
          'Payment verification is temporarily unavailable. Do not pay again.',
        ))
        setStage('pending')
        await pollIntent(checkout.intentId, controller)
        return
      }
    }

    if (!controller.signal.aborted) {
      setStage('pending')
      setStatusMessage(
        'Payment confirmation is taking longer than expected. Do not pay again; Billing settings will show the final result.',
      )
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
        subscription_id: checkout.checkout.subscriptionId,
        name: 'interviewprep.guru',
        description:
          `${checkout.quote.entitlementSummary.displayName} monthly plan`,
        handler: verifyPayment,
        modal: {
          escape: true,
          confirm_close: true,
          ondismiss: () => {
            if (checkout.analyticsObservation) {
              void recordCheckoutObservation({
                authority: checkout.analyticsObservation,
                eventName: 'checkout_dismissed',
              })
            }
            const controller = new AbortController()
            recoveryAbortRef.current?.abort()
            recoveryAbortRef.current = controller
            setStatusMessage(
              'Checkout closed. Checking whether a payment completed in the background…',
            )
            void pollIntent(checkout.intentId, controller)
          },
        },
        theme: { color: '#2563eb' },
        retry: { enabled: true },
      })
      instance.on('payment.failed', () => {
        const controller = new AbortController()
        recoveryAbortRef.current?.abort()
        recoveryAbortRef.current = controller
        setStatusMessage(
          'Razorpay reported a payment problem. Checking the server before another attempt…',
        )
        void pollIntent(checkout.intentId, controller)
      })
      instance.open()
      if (checkout.analyticsObservation) {
        void recordCheckoutObservation({
          authority: checkout.analyticsObservation,
          eventName: 'checkout_opened',
        })
      }
      setStage('pending')
      setStatusMessage(
        'Complete the Razorpay mandate. You can return safely after a UPI app switch.',
      )
    } catch {
      setError(
        'Razorpay Checkout could not be opened. Your saved checkout is safe; try reopening it without creating another payment.',
      )
      setStatusMessage(null)
      setStage('final_review')
    }
  }

  const displayedQuote = checkout?.quote ?? quote
  const finalEntitlement = checkout?.quote.entitlementSummary
  const busy = ['preparing', 'opening', 'verifying'].includes(stage)

  return (
    <div
      className="fixed inset-0 z-[110] flex items-center justify-center px-4 py-6"
      role="presentation"
    >
      <button
        type="button"
        aria-label="Close checkout"
        onClick={() => !busy && onClose()}
        className="absolute inset-0 bg-black/55 backdrop-blur-sm"
      />
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby="billing-checkout-title"
        aria-describedby="billing-checkout-description"
        onKeyDown={handleDialogKeyDown}
        className="relative max-h-[calc(100vh-3rem)] w-full max-w-xl overflow-y-auto rounded-2xl border border-[#e1e8ed] bg-white p-6 shadow-2xl sm:p-7"
      >
        <button
          ref={closeRef}
          type="button"
          aria-label="Close checkout"
          onClick={onClose}
          disabled={busy}
          className="absolute right-3 top-3 rounded-lg p-2 text-[#71767b] transition hover:bg-[#f7f9f9] hover:text-[#0f1419] disabled:opacity-40"
        >
          <span aria-hidden="true">×</span>
        </button>

        <div className="pr-8">
          <div className="flex items-center gap-2">
            <h2
              id="billing-checkout-title"
              className="text-xl font-semibold text-[#0f1419]"
            >
              {finalEntitlement?.displayName ?? plan.displayName} checkout
            </h2>
            {checkout?.providerMode === 'test' && (
              <Badge variant="caution">Test mode</Badge>
            )}
          </div>
          <p
            id="billing-checkout-description"
            className="mt-1 text-sm text-[#536471]"
          >
            Review the server-confirmed price and monthly renewal before
            authorizing a Razorpay mandate.
          </p>
        </div>

        {stage === 'loading' ? (
          <div
            className="mt-8 flex items-center justify-center gap-3 py-12 text-sm text-[#536471]"
            role="status"
          >
            <span className="h-5 w-5 animate-spin rounded-full border-2 border-blue-600 border-t-transparent" />
            Loading secure checkout…
          </div>
        ) : (
          <div className="mt-6 space-y-5">
            {displayedQuote && (
              <section className="rounded-xl border border-[#e1e8ed] bg-[#f8fafc] p-4">
                <div className="flex items-center justify-between text-sm">
                  <span className="text-[#536471]">Monthly list price</span>
                  <span className="font-medium text-[#0f1419]">
                    {formatInr(displayedQuote.listPricePaise)}
                  </span>
                </div>
                <div className="mt-2 flex items-center justify-between text-sm">
                  <span className="text-[#536471]">Coupon discount</span>
                  <span className="font-medium text-emerald-700">
                    {displayedQuote.discountPaise > 0
                      ? `−${formatInr(displayedQuote.discountPaise)}`
                      : 'Not applied'}
                  </span>
                </div>
                <div className="mt-3 flex items-end justify-between border-t border-[#e1e8ed] pt-3">
                  <div>
                    <p className="text-xs uppercase tracking-wide text-[#71767b]">
                      Payable now
                    </p>
                    <p className="mt-0.5 text-2xl font-semibold text-[#0f1419]">
                      {formatInr(displayedQuote.payablePaise)}
                    </p>
                  </div>
                  <p className="text-right text-xs leading-5 text-[#536471]">
                    {displayedQuote.discountedBillingCycles
                      ? `${displayedQuote.discountedBillingCycles} discounted billing ${displayedQuote.discountedBillingCycles === 1 ? 'cycle' : 'cycles'}`
                      : 'Standard monthly price'}
                  </p>
                </div>
                <div className="mt-3 rounded-lg bg-white px-3 py-2 text-xs leading-5 text-[#536471]">
                  {displayedQuote.discountPaise > 0 &&
                  displayedQuote.discountedBillingCycles ? (
                    <>
                      Renews at{' '}
                      <strong className="text-[#0f1419]">
                        {formatInr(
                          displayedQuote.renewalPricePaise ??
                            plan.listPricePaise,
                        )}/month
                      </strong>{' '}
                      after {displayedQuote.discountedBillingCycles}{' '}
                      discounted billing{' '}
                      {displayedQuote.discountedBillingCycles === 1
                        ? 'cycle'
                        : 'cycles'}.
                    </>
                  ) : (
                    <>
                      Renews monthly at{' '}
                      <strong className="text-[#0f1419]">
                        {formatInr(
                          displayedQuote.renewalPricePaise ??
                            plan.listPricePaise,
                        )}/month
                      </strong>{' '}
                      after activation.
                    </>
                  )}{' '}
                  Auto-renews until cancelled.
                  {checkout?.quote.renewalSchedule.status ===
                    'pending_authorization' && (
                    <span className="mt-1 block">
                      The exact renewal date will be set after Razorpay
                      authorization and the first successful payment.
                    </span>
                  )}
                </div>
              </section>
            )}

            {displayedQuote?.coupon && (
              <section className="rounded-xl border border-emerald-200 bg-emerald-50 p-4">
                <div className="flex items-center justify-between gap-3">
                  <h3 className="text-sm font-semibold text-emerald-900">
                    Coupon: {displayedQuote.coupon.displayText}
                  </h3>
                  <Badge variant="success">
                    {displayedQuote.coupon.mode === 'code'
                      ? `Code ${displayedQuote.coupon.code}`
                      : displayedQuote.coupon.mode === 'targeted'
                        ? 'Targeted coupon'
                        : 'Automatic coupon'}
                  </Badge>
                </div>
                <p className="mt-1 text-xs leading-5 text-emerald-800">
                  {displayedQuote.disclosure.why}
                </p>
                <p className="mt-1 text-xs leading-5 text-emerald-800">
                  {displayedQuote.coupon.termsText}
                </p>
              </section>
            )}

            {stage === 'review' && (
              <>
                <section>
                  <button
                    type="button"
                    onClick={() => setCouponOpen((open) => !open)}
                    className="text-sm font-medium text-blue-600 hover:text-blue-700"
                    aria-expanded={couponOpen}
                  >
                    {couponOpen ? 'Hide coupon code' : 'Have a coupon code?'}
                  </button>
                  {couponOpen && (
                    <div className="mt-3 flex items-end gap-2">
                      <div className="min-w-0 flex-1">
                        <Input
                          id="manual-coupon-code"
                          label="Coupon code"
                          autoComplete="off"
                          maxLength={40}
                          value={manualCode}
                          onChange={(event) => {
                            setManualCode(event.target.value.toUpperCase())
                            setCouponMessage(null)
                          }}
                          disabled={couponApplying}
                        />
                      </div>
                      <Button
                        type="button"
                        variant="secondary"
                        onClick={applyCoupon}
                        disabled={couponApplying || manualCode.trim().length < 3}
                      >
                        {couponApplying ? 'Checking…' : 'Apply'}
                      </Button>
                    </div>
                  )}
                  {couponMessage && (
                    <p
                      className="mt-2 text-xs text-[#536471]"
                      role="status"
                    >
                      {couponMessage}
                    </p>
                  )}
                </section>
              </>
            )}

            {statusMessage && (
              <p
                className="rounded-lg border border-blue-200 bg-blue-50 px-3 py-2 text-sm leading-5 text-blue-900"
                role="status"
                aria-live="polite"
              >
                {statusMessage}
              </p>
            )}
            {error && (
              <p
                className="rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-sm leading-5 text-red-700"
                role="alert"
              >
                {error}
              </p>
            )}

            {[
              'review',
              'preparing',
              'final_review',
              'opening',
            ].includes(stage) && (
              <p className="text-xs leading-5 text-[#71767b]">
                By continuing, you agree to the{' '}
                <Link href="/terms" className="text-blue-600 hover:underline">
                  Terms
                </Link>{' '}and acknowledge the{' '}
                <Link
                  href="/cancellation-refunds"
                  className="text-blue-600 hover:underline"
                >
                  cancellation and refund terms
                </Link>
                . Review our{' '}
                <Link href="/privacy" className="text-blue-600 hover:underline">
                  Privacy Policy
                </Link>
                . No client callback alone activates a plan.
              </p>
            )}

            <div className="flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
              {stage === 'manual_review' ? (
                <Button type="button" variant="secondary" onClick={onClose}>
                  Close
                </Button>
              ) : stage === 'review' ? (
                <>
                  <Button type="button" variant="secondary" onClick={onClose}>
                    Cancel
                  </Button>
                  <Button
                    type="button"
                    onClick={prepareCheckout}
                    disabled={!quote || !summary}
                  >
                    Review secure checkout
                  </Button>
                </>
              ) : stage === 'final_review' ? (
                <>
                  <Button type="button" variant="secondary" onClick={onClose}>
                    Finish later
                  </Button>
                  <Button
                    type="button"
                    onClick={openRazorpay}
                  >
                    Pay {checkout ? formatInr(checkout.quote.payablePaise) : ''}
                    {' '}with Razorpay
                  </Button>
                </>
              ) : stage === 'failed' ? (
                <>
                  <Button type="button" variant="secondary" onClick={onClose}>
                    Close
                  </Button>
                  {!readBillingCheckoutRecovery(accountId) && (
                    <Button
                      type="button"
                      onClick={() => {
                        setError(null)
                        setStatusMessage(null)
                        setStage('review')
                      }}
                    >
                      Return to review
                    </Button>
                  )}
                </>
              ) : stage === 'pending' ? (
                <Button type="button" variant="secondary" onClick={onClose}>
                  Finish later
                </Button>
              ) : null}
            </div>
          </div>
        )}
      </div>
    </div>
  )
}
