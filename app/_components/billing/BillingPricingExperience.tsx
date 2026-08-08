'use client'

import Link from 'next/link'
import { useCallback, useEffect, useRef, useState } from 'react'
import Accordion from '@shared/ui/Accordion'
import Button from '@shared/ui/Button'
import Input from '@shared/ui/Input'
import type { LegacyStoredPlanKey } from '@shared/services/planConfig'
import {
  billingResponseSchemas,
  formatInr,
  parseBillingResponse,
  type CustomerBillingSummary,
  type CustomerBillingQuote,
  type PaidBillingPlanKey,
} from './billingClient'
import {
  clearBillingAuthIntent,
  clearBillingCheckoutRecovery,
  readBillingAuthIntent,
  readBillingCheckoutRecovery,
  saveBillingAuthIntent,
  type BillingCheckoutRecovery,
} from './billingIntentStorage'
import { BillingCheckoutDialog } from './BillingCheckoutDialog'
import { BillingPlanCard } from './BillingPlanCard'
import { FutureSubscriptionCheckoutDialog } from './FutureSubscriptionCheckoutDialog'
import { billingFetch } from './billingRequestTimeout'
import { usePublicBillingCatalog } from './usePublicBillingCatalog'

const PLAN_ORDER = ['free', 'plus', 'pro'] as const

const BILLING_FAQ = [
  {
    title: 'How do the monthly interview limits reset?',
    content:
      'Basic resets each calendar month. Plus and Pro reset with the paid Razorpay billing cycle shown in Billing settings.',
  },
  {
    title: 'How do coupons work?',
    content:
      'Enter an eligible coupon code before secure checkout. Coupons are managed by InterviewPrepGuru, never stack, and do not depend on a Razorpay Offer.',
  },
  {
    title: 'What happens after the discounted month?',
    content:
      'The checkout shows the exact discounted cycle count and renewal price before Razorpay opens. Paid plans auto-renew monthly until cancelled.',
  },
  {
    title: 'How long can an interview be?',
    content:
      'Interview allowances and maximum durations are listed in each plan above.',
  },
]

interface BillingPricingExperienceProps {
  currentPlan: LegacyStoredPlanKey
  authStatus: 'loading' | 'authenticated' | 'unauthenticated'
  accountId: string | null
  refreshSession: () => Promise<unknown>
}

type AcquisitionCheckoutSelection = {
  planKey: PaidBillingPlanKey
  autoStart: boolean
  manualCouponCode?: string
}

type AcquisitionCouponDecision = {
  blocked: boolean
  manualCouponCode?: string
  message?: string
}

export function BillingPricingExperience({
  currentPlan,
  authStatus,
  accountId,
  refreshSession,
}: BillingPricingExperienceProps) {
  const { catalog, error, loading, reload } = usePublicBillingCatalog()
  const [quotes, setQuotes] = useState<
    Partial<Record<PaidBillingPlanKey, CustomerBillingQuote>>
  >({})
  const [quoteLoading, setQuoteLoading] = useState(false)
  const [quoteError, setQuoteError] = useState<string | null>(null)
  const [quotedCouponCode, setQuotedCouponCode] = useState<string | null>(null)
  const [couponCode, setCouponCode] = useState('')
  const [checkoutSelection, setCheckoutSelection] =
    useState<AcquisitionCheckoutSelection | null>(null)
  const [pendingRecovery, setPendingRecovery] =
    useState<BillingCheckoutRecovery | null>(null)
  const [resumedAfterSignIn, setResumedAfterSignIn] =
    useState<PaidBillingPlanKey | null>(null)
  const [futureSelection, setFutureSelection] = useState<{
    operation: 'tier_change' | 'resubscribe'
    currentPlanKey: PaidBillingPlanKey
    targetPlanKey: PaidBillingPlanKey
    effectiveAt: string
  } | null>(null)
  const [billingSummary, setBillingSummary] =
    useState<CustomerBillingSummary | null>(null)
  const [summaryError, setSummaryError] = useState<string | null>(null)
  const [cancellingRenewal, setCancellingRenewal] = useState(false)
  const [cancellationMessage, setCancellationMessage] =
    useState<string | null>(null)
  const [cancellingScheduledChange, setCancellingScheduledChange] =
    useState(false)
  const resumeCheckedRef = useRef<string | null>(null)
  const sessionRefreshKeyRef = useRef<string | null>(null)
  const normalizedCouponCode = couponCode.trim().toUpperCase()

  const loadBillingSummary = useCallback(async (signal?: AbortSignal) => {
    const response = await billingFetch('/api/billing/me', {
      headers: { Accept: 'application/json' },
      signal,
    })
    return parseBillingResponse(
      response,
      billingResponseSchemas.summary,
      'Your subscription details could not be loaded.',
    )
  }, [])

  useEffect(() => {
    if (
      !catalog?.customerBillingUiReady ||
      authStatus !== 'authenticated' ||
      !accountId
    ) {
      setBillingSummary(null)
      return
    }
    const controller = new AbortController()
    setSummaryError(null)
    void loadBillingSummary(controller.signal)
      .then((summary) => {
        if (!controller.signal.aborted) setBillingSummary(summary)
      })
      .catch(() => {
        if (!controller.signal.aborted) {
          setSummaryError('Subscription management is temporarily unavailable.')
        }
      })
    return () => controller.abort()
  }, [
    accountId,
    authStatus,
    catalog?.customerBillingUiReady,
    loadBillingSummary,
  ])

  useEffect(() => {
    if (
      authStatus !== 'authenticated' ||
      !accountId ||
      !billingSummary ||
      currentPlan === 'enterprise'
    ) return

    const authoritativePlan = billingSummary.entitlement.planKey
    if (authoritativePlan === currentPlan) {
      sessionRefreshKeyRef.current = null
      return
    }
    const refreshKey = [
      accountId,
      currentPlan,
      authoritativePlan,
      billingSummary.entitlement.version,
    ].join(':')
    if (sessionRefreshKeyRef.current === refreshKey) return
    sessionRefreshKeyRef.current = refreshKey
    void refreshSession().catch(() => {
      if (sessionRefreshKeyRef.current === refreshKey) {
        sessionRefreshKeyRef.current = null
      }
    })
  }, [
    accountId,
    authStatus,
    billingSummary,
    currentPlan,
    refreshSession,
  ])

  useEffect(() => {
    if (
      !catalog?.customerBillingUiReady ||
      authStatus !== 'authenticated' ||
      !accountId ||
      !billingSummary ||
      billingSummary.entitlement.planKey !== 'free' ||
      billingSummary.saleAvailability !== 'available' ||
      (
        billingSummary.subscription.state !== 'none' &&
        billingSummary.subscription.state !== 'activation_pending'
      )
    ) {
      setQuotes({})
      setQuotedCouponCode(null)
      setQuoteError(null)
      setQuoteLoading(false)
      return
    }
    if (
      normalizedCouponCode.length > 0 &&
      normalizedCouponCode.length < 3
    ) {
      setQuotedCouponCode(null)
      setQuoteError(null)
      setQuoteLoading(false)
      return
    }

    const controller = new AbortController()
    const requestedCode = normalizedCouponCode || null
    setQuoteLoading(true)
    setQuoteError(null)

    const loadQuote = async (
      planKey: PaidBillingPlanKey,
    ): Promise<CustomerBillingQuote> => {
      const response = await billingFetch('/api/billing/quote', {
        method: 'POST',
        headers: {
          Accept: 'application/json',
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          planKey,
          surface: 'pricing',
          ...(requestedCode
            ? { manualCouponCode: requestedCode }
            : {}),
        }),
        signal: controller.signal,
      })
      const quote = await parseBillingResponse(
        response,
        billingResponseSchemas.quote,
        'Your current price could not be loaded.',
      )
      if (quote.planKey !== planKey) {
        throw new Error('Billing quote returned a different plan')
      }
      return quote
    }

    const debounceMs = requestedCode ? 300 : 0
    const timeout = window.setTimeout(() => {
      void Promise.allSettled([
        loadQuote('plus'),
        loadQuote('pro'),
      ])
        .then(([plus, pro]) => {
          if (controller.signal.aborted) return
          const nextQuotes = {
            ...(plus.status === 'fulfilled' ? { plus: plus.value } : {}),
            ...(pro.status === 'fulfilled' ? { pro: pro.value } : {}),
          }
          setQuotes(nextQuotes)
          setQuotedCouponCode(requestedCode)
          if (
            plus.status === 'rejected' ||
            pro.status === 'rejected'
          ) {
            setQuoteError(
              requestedCode
                ? 'Coupon pricing could not be checked for every plan. Retry or clear the code.'
                : 'One or more current paid-plan prices could not be loaded.',
            )
          }
        })
        .finally(() => {
          if (!controller.signal.aborted) setQuoteLoading(false)
        })
    }, debounceMs)

    return () => {
      window.clearTimeout(timeout)
      controller.abort()
    }
  }, [
    accountId,
    authStatus,
    billingSummary,
    catalog?.customerBillingUiReady,
    normalizedCouponCode,
  ])

  useEffect(() => {
    if (
      !catalog?.customerBillingUiReady ||
      authStatus !== 'authenticated' ||
      !accountId ||
      resumeCheckedRef.current === accountId
    ) {
      return
    }
    resumeCheckedRef.current = accountId

    const recovery = readBillingCheckoutRecovery(accountId)
    setPendingRecovery(recovery)

    const params = new URLSearchParams(window.location.search)
    const shouldResume = params.get('resumeBilling') === '1'
    const authIntent = readBillingAuthIntent()
    if (
      shouldResume &&
      authIntent?.surface === 'pricing' &&
      currentPlan === 'free'
    ) {
      setResumedAfterSignIn(authIntent.planKey)
      clearBillingAuthIntent()
    } else if (shouldResume && authIntent) {
      clearBillingAuthIntent()
    }
    if (shouldResume) {
      params.delete('resumeBilling')
      const query = params.toString()
      window.history.replaceState(
        {},
        '',
        query ? `/pricing?${query}` : '/pricing',
      )
    }
  }, [
    accountId,
    authStatus,
    catalog?.customerBillingUiReady,
    currentPlan,
  ])

  useEffect(() => {
    if (
      !accountId ||
      !pendingRecovery ||
      !billingSummary ||
      billingSummary.entitlement.planKey === 'free'
    ) return
    clearBillingCheckoutRecovery(accountId)
    setPendingRecovery(null)
  }, [accountId, billingSummary, pendingRecovery])

  function couponDecisionForPlan(
    planKey: PaidBillingPlanKey,
  ): AcquisitionCouponDecision {
    const quote = quotes[planKey]
    if (!normalizedCouponCode) {
      if (quoteLoading || quotedCouponCode !== null) {
        return { blocked: true, message: 'Refreshing standard pricing…' }
      }
      return quote
        ? { blocked: false }
        : {
            blocked: true,
            message: quoteError ?? 'Current price is still loading.',
          }
    }
    if (
      normalizedCouponCode.length < 3 ||
      quoteLoading ||
      quotedCouponCode !== normalizedCouponCode
    ) {
      return { blocked: true, message: 'Checking coupon pricing…' }
    }
    if (!quote) {
      return {
        blocked: true,
        message: quoteError ?? 'Coupon pricing is temporarily unavailable.',
      }
    }
    if (quote.manualCodeResult === 'not_better_than_automatic') {
      return { blocked: false }
    }
    if (
      quote.manualCodeResult === 'applied' &&
      quote.coupon?.mode === 'code' &&
      quote.coupon.code?.trim().toUpperCase() === normalizedCouponCode
    ) {
      return {
        blocked: false,
        manualCouponCode: normalizedCouponCode,
      }
    }
    const previousCheckoutMayHoldCode =
      quote.manualCodeResult === 'ineligible' &&
      (
        (
          pendingRecovery !== null &&
          pendingRecovery.planKey !== planKey
        ) ||
        (
          billingSummary?.subscription.state === 'activation_pending' &&
          billingSummary.subscription.planKey !== planKey
        )
      )
    if (previousCheckoutMayHoldCode) {
      return {
        blocked: false,
        manualCouponCode: normalizedCouponCode,
        message:
          'Your previous checkout may hold this coupon. It will be rechecked when you pay.',
      }
    }
    return {
      blocked: true,
      message: quote.manualCodeResult === 'system_unavailable'
        ? 'Coupon validation is temporarily unavailable. Retry or clear the code.'
        : 'This coupon is not available for this plan.',
    }
  }

  function selectPlan(planKey: PaidBillingPlanKey) {
    if (authStatus === 'loading') return
    if (authStatus !== 'authenticated') {
      saveBillingAuthIntent(planKey, 'pricing')
      const callbackUrl = '/pricing?resumeBilling=1'
      window.location.assign(
        `/signin?callbackUrl=${encodeURIComponent(callbackUrl)}`,
      )
      return
    }
    if (billingSummary?.subscription.state === 'review') return
    const subscription = billingSummary?.subscription
    if (
      subscription?.state === 'current' &&
      (subscription.planKey === 'plus' || subscription.planKey === 'pro')
    ) {
      if (
        subscription.planKey === planKey ||
        subscription.cancelAtPeriodEnd ||
        (
          billingSummary?.scheduledPlanChange &&
          billingSummary.scheduledPlanChange.toPlanKey !== 'free'
        ) ||
        !subscription.currentPeriodEnd
      ) return
      setFutureSelection({
        operation: 'tier_change',
        currentPlanKey: subscription.planKey,
        targetPlanKey: planKey,
        effectiveAt: subscription.currentPeriodEnd,
      })
      return
    }
    if (
      !accountId ||
      !billingSummary ||
      billingSummary.saleAvailability !== 'available' ||
      billingSummary.entitlement.planKey !== 'free'
    ) return
    const couponDecision = couponDecisionForPlan(planKey)
    if (couponDecision.blocked) return
    setResumedAfterSignIn(null)
    setCheckoutSelection({
      planKey,
      autoStart: true,
      ...(couponDecision.manualCouponCode
        ? { manualCouponCode: couponDecision.manualCouponCode }
        : {}),
    })
  }

  async function cancelRenewal() {
    if (cancellingRenewal) return
    const confirmed = window.confirm(
      'Cancel automatic renewal? Your paid access will continue through the current paid period.',
    )
    if (!confirmed) return
    setCancellingRenewal(true)
    setCancellationMessage(null)
    try {
      const expectedEffectiveAt =
        billingSummary?.subscription.currentPeriodEnd
      if (!expectedEffectiveAt) {
        throw new Error('Current paid period is unavailable')
      }
      const response = await billingFetch('/api/billing/subscription/cancel', {
        method: 'POST',
        headers: {
          Accept: 'application/json',
          'Content-Type': 'application/json',
          'Idempotency-Key': `billing-cancel:${expectedEffectiveAt}`,
        },
        body: JSON.stringify({ confirmPeriodEnd: true }),
      })
      if (!response.ok) {
        throw new Error('Cancellation request failed')
      }
      const result = await response.json() as {
        status?: unknown
        effectiveAt?: unknown
      }
      if (
        result.effectiveAt !== expectedEffectiveAt ||
        (result.status !== 'scheduled' && result.status !== 'reconciling')
      ) {
        throw new Error('Cancellation response is inconsistent')
      }
      setBillingSummary(await loadBillingSummary())
      setCancellationMessage(result.status === 'scheduled'
        ? 'Renewal cancelled. Your paid access remains available through the current paid period.'
        : 'Razorpay confirmation is pending. Use “Cancel renewal” again to safely recheck the same request.')
    } catch {
      setCancellationMessage(
        'Renewal could not be cancelled right now. Please try again.',
      )
    } finally {
      setCancellingRenewal(false)
    }
  }

  function resubscribe() {
    const subscription = billingSummary?.subscription
    if (
      subscription?.state !== 'current' ||
      (subscription.planKey !== 'plus' && subscription.planKey !== 'pro') ||
      !subscription.cancelAtPeriodEnd ||
      !subscription.currentPeriodEnd ||
      (
        billingSummary?.scheduledPlanChange &&
        billingSummary.scheduledPlanChange.toPlanKey !== 'free'
      )
    ) return
    setFutureSelection({
      operation: 'resubscribe',
      currentPlanKey: subscription.planKey,
      targetPlanKey: subscription.planKey,
      effectiveAt: subscription.currentPeriodEnd,
    })
  }

  async function cancelScheduledChange() {
    const scheduled = billingSummary?.scheduledPlanChange?.toPlanKey === 'free'
      ? undefined
      : billingSummary?.scheduledPlanChange
    if (!scheduled || cancellingScheduledChange) return
    const keepsEnding = billingSummary?.subscription.cancelAtPeriodEnd === true
    const confirmed = window.confirm(
      keepsEnding
        ? 'Cancel the scheduled future plan? Your current subscription will still end at the period boundary unless you resume it.'
        : 'Cancel the pending future plan authorization? Your current subscription will continue unchanged.',
    )
    if (!confirmed) return
    setCancellingScheduledChange(true)
    setCancellationMessage(null)
    try {
      const response = await billingFetch(
        '/api/billing/subscription/plan-change/cancel',
        {
          method: 'POST',
          headers: {
            Accept: 'application/json',
            'Content-Type': 'application/json',
            'Idempotency-Key':
              `billing-cancel-change:${scheduled.planChangeRequestId}`,
          },
          body: JSON.stringify({
            planChangeRequestId: scheduled.planChangeRequestId,
          }),
        },
      )
      const result = await parseBillingResponse(
        response,
        billingResponseSchemas.scheduledPlanChangeCancellation,
        'The scheduled change could not be cancelled.',
      )
      if (result.planChangeRequestId !== scheduled.planChangeRequestId) {
        throw new Error('Scheduled change response is inconsistent')
      }
      setBillingSummary(await loadBillingSummary())
      setCancellationMessage(
        result.status === 'cancelled'
          ? keepsEnding
            ? 'Future plan cancelled. Your current subscription is still set to end; use Resume renewal if you want it to continue.'
            : 'Pending plan change cancelled. Your current subscription continues unchanged.'
          : 'Razorpay cancellation is reconciling. Retry the same action safely if it remains pending.',
      )
    } catch {
      setCancellationMessage(
        'The scheduled plan change could not be cancelled right now. Please try again.',
      )
    } finally {
      setCancellingScheduledChange(false)
    }
  }

  const refreshCompletedBilling = useCallback(async () => {
    const nextSummary = await loadBillingSummary()
    setBillingSummary(nextSummary)
    setSummaryError(null)
  }, [loadBillingSummary])

  const authoritativeCurrentPlan = currentPlan === 'enterprise'
    ? currentPlan
    : billingSummary?.entitlement.planKey ?? currentPlan
  const currentSubscription = billingSummary?.subscription
  const subscriptionReviewLocked = currentSubscription?.state === 'review'
  const scheduledFuturePlanChange =
    billingSummary?.scheduledPlanChange?.toPlanKey === 'free'
      ? undefined
      : billingSummary?.scheduledPlanChange
  const paidPlanChangeAvailable =
    currentSubscription?.state === 'current' &&
    (currentSubscription.planKey === 'plus' ||
      currentSubscription.planKey === 'pro') &&
    currentSubscription.cancelAtPeriodEnd === false &&
    currentSubscription.currentPeriodEnd !== undefined &&
    scheduledFuturePlanChange === undefined
  const paidPlanChangeBlockedLabel = scheduledFuturePlanChange
    ? 'Change already pending'
    : currentSubscription?.cancelAtPeriodEnd
      ? 'Resume renewal below'
      : currentPlan === 'enterprise'
        ? 'Contact us to change plan'
        : 'Manage subscription below'
  const acquisitionControlsVisible =
    authoritativeCurrentPlan === 'free' && !subscriptionReviewLocked

  function acquisitionCtaForPlan(planKey: PaidBillingPlanKey): {
    label: string
    disabled: boolean
    busy: boolean
  } {
    if (authStatus === 'loading') {
      return { label: 'Loading account…', disabled: true, busy: true }
    }
    if (authStatus !== 'authenticated') {
      return {
        label: `Sign in to buy ${planKey === 'plus' ? 'Plus' : 'Pro'}`,
        disabled: false,
        busy: false,
      }
    }
    if (!accountId) {
      return { label: 'Account unavailable', disabled: true, busy: false }
    }
    if (checkoutSelection) {
      return {
        label: checkoutSelection.planKey === planKey
          ? 'Preparing payment…'
          : 'Payment opening…',
        disabled: true,
        busy: checkoutSelection.planKey === planKey,
      }
    }
    if (!billingSummary) {
      return { label: 'Loading account…', disabled: true, busy: true }
    }
    if (billingSummary.saleAvailability !== 'available') {
      return {
        label: 'Purchases unavailable',
        disabled: true,
        busy: false,
      }
    }
    const decision = couponDecisionForPlan(planKey)
    if (decision.blocked) {
      const waitingForQuote = quoteLoading ||
        (!quotes[planKey] && quoteError === null)
      return {
        label: waitingForQuote ? 'Checking price…' : 'Coupon unavailable',
        disabled: true,
        busy: waitingForQuote,
      }
    }
    const quote = quotes[planKey]
    return quote
      ? {
          label: `Pay ${formatInr(quote.payablePaise)} Now`,
          disabled: false,
          busy: false,
        }
      : { label: 'Price unavailable', disabled: true, busy: false }
  }

  let couponStatusMessage: string | null = null
  if (normalizedCouponCode) {
    if (normalizedCouponCode.length < 3) {
      couponStatusMessage =
        'Enter at least 3 characters, or clear the coupon code.'
    } else if (
      quoteLoading ||
      quotedCouponCode !== normalizedCouponCode
    ) {
      couponStatusMessage = 'Checking this coupon for Plus and Pro…'
    } else {
      const appliedPlans = PLAN_ORDER.filter((planKey) =>
        planKey !== 'free' &&
        quotes[planKey]?.manualCodeResult === 'applied',
      ) as PaidBillingPlanKey[]
      const recheckPlans = (['plus', 'pro'] as const).filter((planKey) =>
        couponDecisionForPlan(planKey).manualCouponCode ===
          normalizedCouponCode &&
        quotes[planKey]?.manualCodeResult === 'ineligible',
      )
      const automaticBetter = (['plus', 'pro'] as const).every((planKey) =>
        quotes[planKey]?.manualCodeResult === 'not_better_than_automatic',
      )
      if (appliedPlans.length > 0) {
        couponStatusMessage = `${normalizedCouponCode} applied to ${appliedPlans
          .map((planKey) => planKey === 'plus' ? 'Plus' : 'Pro')
          .join(' and ')}. The Pay button shows the updated amount.`
      } else if (recheckPlans.length > 0) {
        couponStatusMessage =
          'Your previous checkout may hold this coupon. We will recheck it once when you pay; a better final price opens Razorpay directly.'
      } else if (automaticBetter) {
        couponStatusMessage =
          'A better automatic coupon is already applied to these plans.'
      } else {
        couponStatusMessage = quoteError ??
          'This coupon is not available for the selected paid plan.'
      }
    }
  } else if (quoteError) {
    couponStatusMessage = quoteError
  }

  if (loading) {
    return (
      <main className="min-h-screen px-4 py-16 sm:px-6 lg:px-8">
        <div
          className="mx-auto flex max-w-5xl items-center justify-center gap-3 py-32 text-sm text-[#536471]"
          role="status"
        >
          <span className="h-5 w-5 animate-spin rounded-full border-2 border-blue-600 border-t-transparent" />
          Loading current pricing…
        </div>
      </main>
    )
  }

  if (error || !catalog) {
    return (
      <main className="min-h-screen px-4 py-16 sm:px-6 lg:px-8">
        <section className="mx-auto max-w-lg rounded-2xl border border-[#e1e8ed] bg-white p-8 text-center">
          <h1 className="text-2xl font-semibold text-[#0f1419]">
            Pricing is temporarily unavailable
          </h1>
          <p className="mt-2 text-sm text-[#536471]">
            No payment was started. Try loading the current catalog again.
          </p>
          <Button type="button" className="mt-5" onClick={reload}>
            Try again
          </Button>
        </section>
      </main>
    )
  }

  if (!catalog.customerBillingUiReady) {
    return (
      <main className="min-h-screen px-4 py-16 sm:px-6 lg:px-8">
        <section className="mx-auto max-w-lg rounded-2xl border border-[#e1e8ed] bg-white p-8 text-center">
          <h1 className="text-2xl font-semibold text-[#0f1419]">
            Updated pricing is being prepared
          </h1>
          <p className="mt-2 text-sm text-[#536471]">
            Checkout remains unavailable while the billing rollout is paused.
          </p>
          <Link
            href="/"
            className="mt-5 inline-flex text-sm font-medium text-blue-600 hover:text-blue-700"
          >
            Continue practicing
          </Link>
        </section>
      </main>
    )
  }

  return (
    <main className="min-h-screen px-4 py-16 sm:px-6 lg:px-8">
      <div className="mx-auto max-w-5xl">
        <header className="mb-14 text-center">
          <h1 className="text-display text-[#0f1419]">
            Practice free. Upgrade when the extra reps matter.
          </h1>
        </header>

        {subscriptionReviewLocked ? (
          <section
            aria-label="Billing review"
            className="mb-8 rounded-2xl border border-amber-200 bg-amber-50 px-5 py-4 text-amber-950"
            role="status"
          >
            <h2 className="text-sm font-semibold">
              Subscription review in progress
            </h2>
            <p className="mt-1 text-sm leading-6">
              We are reconciling this account&apos;s billing state. Paid plan
              checkout and plan changes are temporarily locked, so no
              additional payment will be started.
            </p>
          </section>
        ) : null}

        {acquisitionControlsVisible && pendingRecovery ? (
          <section
            aria-label="Unfinished payment"
            className="mb-6 flex flex-col gap-3 rounded-2xl border border-blue-200 bg-blue-50 px-5 py-4 sm:flex-row sm:items-center sm:justify-between"
          >
            <div>
              <h2 className="text-sm font-semibold text-blue-950">
                Unfinished {pendingRecovery.planKey === 'plus'
                  ? 'Plus'
                  : 'Pro'} payment
              </h2>
              <p className="mt-1 text-sm leading-6 text-blue-900">
                Resume the existing Razorpay checkout, or choose another plan
                below. Starting another plan safely replaces the unpaid one.
              </p>
            </div>
            <Button
              type="button"
              disabled={checkoutSelection !== null}
              onClick={() => setCheckoutSelection({
                planKey: pendingRecovery.planKey,
                autoStart: true,
                ...(pendingRecovery.manualCouponCode
                  ? { manualCouponCode: pendingRecovery.manualCouponCode }
                  : {}),
              })}
            >
              Resume payment
            </Button>
          </section>
        ) : null}

        {acquisitionControlsVisible && resumedAfterSignIn ? (
          <p
            className="mb-6 rounded-xl border border-emerald-200 bg-emerald-50 px-4 py-3 text-sm text-emerald-900"
            role="status"
          >
            You are signed in. Review the current{' '}
            {resumedAfterSignIn === 'plus' ? 'Plus' : 'Pro'} price below and
            select Pay when you are ready.
          </p>
        ) : null}

        {acquisitionControlsVisible ? (
          <section
            aria-label="Paid plan coupon and terms"
            className="mb-8 rounded-2xl border border-[#e1e8ed] bg-white p-5"
          >
            {authStatus === 'authenticated' && accountId ? (
              <div className="max-w-md">
                <Input
                  id="pricing-coupon-code"
                  label="Coupon code (optional)"
                  autoComplete="off"
                  maxLength={40}
                  value={couponCode}
                  onChange={(event) => {
                    setCouponCode(event.target.value.toUpperCase())
                    setResumedAfterSignIn(null)
                  }}
                  disabled={checkoutSelection !== null}
                  hint="Checked automatically as you type. No Razorpay Offer is required."
                />
                {couponStatusMessage ? (
                  <p
                    className="mt-2 text-xs leading-5 text-[#536471]"
                    role="status"
                    aria-live="polite"
                  >
                    {couponStatusMessage}
                  </p>
                ) : null}
              </div>
            ) : (
              <p className="text-sm text-[#536471]">
                Sign in from a paid plan below to check a coupon for your
                account.
              </p>
            )}
            <p className="mt-4 text-xs leading-5 text-[#71767b]">
              By selecting Pay, you agree to the{' '}
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
              . Your plan activates only after server-confirmed payment.
            </p>
          </section>
        ) : null}

        <section
          aria-label="Interview preparation plans"
          className="grid gap-component md:grid-cols-3"
        >
          {PLAN_ORDER.map((planKey) => {
            const acquisitionCta = planKey === 'free'
              ? null
              : acquisitionCtaForPlan(planKey)
            return (
              <BillingPlanCard
                key={planKey}
                plan={catalog.plans[planKey]}
                currentPlan={authoritativeCurrentPlan}
                quote={planKey === 'free' ? undefined : quotes[planKey]}
                quoteLoading={planKey !== 'free' && quoteLoading}
                paidPlanChangeAvailable={paidPlanChangeAvailable}
                paidPlanChangeBlockedLabel={paidPlanChangeBlockedLabel}
                paidSelectionBlockedLabel={subscriptionReviewLocked
                  ? 'Billing review in progress'
                  : undefined}
                acquisitionCtaLabel={acquisitionCta?.label}
                acquisitionCtaDisabled={acquisitionCta?.disabled}
                acquisitionCtaBusy={acquisitionCta?.busy}
                onSelect={selectPlan}
              />
            )
          })}
        </section>

        {authStatus === 'authenticated' &&
        billingSummary?.subscription.state === 'current' ? (
          <section
            id="subscription-management"
            aria-label="Subscription management"
            className="mt-8 rounded-2xl border border-[#e1e8ed] bg-white px-5 py-5"
          >
            <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
              <div>
                <h2 className="text-sm font-semibold text-[#0f1419]">
                  {billingSummary.subscription.planKey === 'pro'
                    ? 'Pro subscription'
                    : 'Plus subscription'}
                </h2>
                <p className="mt-1 text-sm text-[#536471]">
                  {billingSummary.subscription.cancelAtPeriodEnd
                    ? 'Renewal is cancelled. Paid access continues through the current period.'
                    : 'Renews automatically each month until you cancel.'}
                </p>
                {billingSummary.subscription.currentPeriodEnd ? (
                  <p className="mt-1 text-xs text-[#71767b]">
                    Current paid period ends{' '}
                    {new Intl.DateTimeFormat('en-IN', {
                      dateStyle: 'medium',
                    }).format(new Date(
                      billingSummary.subscription.currentPeriodEnd,
                    ))}
                  </p>
                ) : null}
                {scheduledFuturePlanChange ? (
                  <div className="mt-3 rounded-lg border border-blue-100 bg-blue-50 px-3 py-2 text-sm text-blue-900">
                    <strong>
                      {scheduledFuturePlanChange.fromPlanKey ===
                      scheduledFuturePlanChange.toPlanKey
                        ? `${scheduledFuturePlanChange.toPlanKey === 'pro' ? 'Pro' : 'Plus'} renewal mandate pending`
                        : `${scheduledFuturePlanChange.toPlanKey === 'pro' ? 'Pro' : 'Plus'} change pending`}
                    </strong>
                    <p className="mt-1 text-xs leading-5 text-blue-800">
                      Effective {new Intl.DateTimeFormat('en-IN', {
                        dateStyle: 'medium',
                      }).format(new Date(
                        scheduledFuturePlanChange.effectiveAt,
                      ))}. Status: {scheduledFuturePlanChange.status.replaceAll('_', ' ')}.
                    </p>
                  </div>
                ) : null}
              </div>
              {scheduledFuturePlanChange ? (
                <Button
                  type="button"
                  variant="secondary"
                  disabled={cancellingScheduledChange}
                  onClick={cancelScheduledChange}
                >
                  {cancellingScheduledChange
                    ? 'Cancelling…'
                    : 'Cancel scheduled change'}
                </Button>
              ) : billingSummary.subscription.cancelAtPeriodEnd ? (
                <Button
                  type="button"
                  variant="secondary"
                  onClick={resubscribe}
                >
                  Resume renewal
                </Button>
              ) : (
                billingSummary.subscription.status === 'active' ||
                (
                  billingSummary.subscription.status === 'authenticated' &&
                  billingSummary.subscription.currentCoupon !== undefined &&
                  billingSummary.subscription.discountedCyclesRemaining === 0
                )
              ) ? (
                <Button
                  type="button"
                  variant="secondary"
                  disabled={cancellingRenewal}
                  onClick={cancelRenewal}
                >
                  {cancellingRenewal ? 'Cancelling…' : 'Cancel renewal'}
                </Button>
              ) : null}
            </div>
            {cancellationMessage ? (
              <p className="mt-3 text-sm text-[#536471]" role="status">
                {cancellationMessage}
              </p>
            ) : null}
          </section>
        ) : summaryError && authStatus === 'authenticated' ? (
          <p className="mt-5 text-center text-sm text-red-600" role="status">
            {summaryError}
          </p>
        ) : null}

        <section className="mx-auto mt-20 max-w-2xl">
          <h2 className="mb-8 text-center text-display text-[#0f1419]">
            Frequently asked questions
          </h2>
          <Accordion items={BILLING_FAQ} />
        </section>

        <div className="mt-16 text-center">
          <Link
            href="/"
            className="text-body font-medium text-blue-600 transition hover:text-blue-700"
          >
            &larr; Continue practicing
          </Link>
        </div>
      </div>

      {checkoutSelection && accountId && (
        <BillingCheckoutDialog
          key={`${accountId}:${checkoutSelection.planKey}:${checkoutSelection.manualCouponCode ?? 'automatic'}`}
          catalog={catalog}
          planKey={checkoutSelection.planKey}
          accountId={accountId}
          initialQuote={quotes[checkoutSelection.planKey]}
          initialSummary={billingSummary ?? undefined}
          autoStart={checkoutSelection.autoStart}
          {...(checkoutSelection.manualCouponCode
            ? {
                initialManualCouponCode:
                  checkoutSelection.manualCouponCode,
              }
            : {})}
          refreshSession={refreshSession}
          onClose={() => {
            setCheckoutSelection(null)
            setPendingRecovery(readBillingCheckoutRecovery(accountId))
          }}
          onCompleted={refreshCompletedBilling}
        />
      )}
      {futureSelection && (
        <FutureSubscriptionCheckoutDialog
          key={`${futureSelection.operation}:${futureSelection.targetPlanKey}`}
          operation={futureSelection.operation}
          currentPlanKey={futureSelection.currentPlanKey}
          targetPlanKey={futureSelection.targetPlanKey}
          effectiveAt={futureSelection.effectiveAt}
          onClose={() => {
            setFutureSelection(null)
            void refreshCompletedBilling().catch(() => undefined)
          }}
          onCompleted={refreshCompletedBilling}
        />
      )}
    </main>
  )
}
