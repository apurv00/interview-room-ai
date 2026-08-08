'use client'

import Link from 'next/link'
import { useCallback, useEffect, useRef, useState } from 'react'
import Accordion from '@shared/ui/Accordion'
import Button from '@shared/ui/Button'
import type { LegacyStoredPlanKey } from '@shared/services/planConfig'
import {
  billingResponseSchemas,
  parseBillingResponse,
  type CustomerBillingSummary,
  type CustomerBillingQuote,
  type PaidBillingPlanKey,
} from './billingClient'
import {
  clearBillingAuthIntent,
  readBillingAuthIntent,
  readBillingCheckoutRecovery,
  saveBillingAuthIntent,
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
  const [selectedPlan, setSelectedPlan] =
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
  const resumeCheckedRef = useRef(false)
  const sessionRefreshKeyRef = useRef<string | null>(null)

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
      authStatus !== 'authenticated'
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
  }, [authStatus, catalog?.customerBillingUiReady, loadBillingSummary])

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
      currentPlan === 'plus' ||
      currentPlan === 'pro' ||
      currentPlan === 'enterprise'
    ) {
      return
    }
    const controller = new AbortController()
    setQuoteLoading(true)

    const loadQuote = async (
      planKey: PaidBillingPlanKey,
    ): Promise<CustomerBillingQuote> => {
      const response = await billingFetch('/api/billing/quote', {
        method: 'POST',
        headers: {
          Accept: 'application/json',
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ planKey, surface: 'pricing' }),
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

    void Promise.allSettled([
      loadQuote('plus'),
      loadQuote('pro'),
    ])
      .then(([plus, pro]) => {
        if (controller.signal.aborted) return
        setQuotes({
          ...(plus.status === 'fulfilled' ? { plus: plus.value } : {}),
          ...(pro.status === 'fulfilled' ? { pro: pro.value } : {}),
        })
      })
      .finally(() => {
        if (!controller.signal.aborted) setQuoteLoading(false)
      })

    return () => controller.abort()
  }, [authStatus, catalog, currentPlan])

  useEffect(() => {
    if (
      !catalog?.customerBillingUiReady ||
      authStatus !== 'authenticated' ||
      !accountId ||
      resumeCheckedRef.current
    ) {
      return
    }
    resumeCheckedRef.current = true

    const recovery = readBillingCheckoutRecovery(accountId)
    if (recovery) {
      setSelectedPlan(recovery.planKey)
      return
    }

    const params = new URLSearchParams(window.location.search)
    const shouldResume = params.get('resumeBilling') === '1'
    const authIntent = readBillingAuthIntent()
    if (
      shouldResume &&
      authIntent?.surface === 'pricing' &&
      currentPlan === 'free'
    ) {
      setSelectedPlan(authIntent.planKey)
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
  }, [accountId, authStatus, catalog, currentPlan])

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
    setSelectedPlan(planKey)
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

        <section
          aria-label="Interview preparation plans"
          className="grid gap-component md:grid-cols-3"
        >
          {PLAN_ORDER.map((planKey) => (
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
              onSelect={selectPlan}
            />
          ))}
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

      {selectedPlan && accountId && (
        <BillingCheckoutDialog
          key={`${accountId}:${selectedPlan}`}
          catalog={catalog}
          planKey={selectedPlan}
          accountId={accountId}
          initialQuote={quotes[selectedPlan]}
          initialSummary={billingSummary ?? undefined}
          refreshSession={refreshSession}
          onClose={() => setSelectedPlan(null)}
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
