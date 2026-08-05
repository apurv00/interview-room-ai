'use client'

import Link from 'next/link'
import { useEffect, useRef, useState } from 'react'
import Accordion from '@shared/ui/Accordion'
import Button from '@shared/ui/Button'
import type { LegacyStoredPlanKey } from '@shared/services/planConfig'
import {
  billingResponseSchemas,
  parseBillingResponse,
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
      'The best eligible automatic coupon is applied for you. If you have a targeted code, use “Have a coupon code?” before secure checkout. Coupons never stack.',
  },
  {
    title: 'What happens after the discounted month?',
    content:
      'The checkout shows the exact discounted cycle count and renewal price before Razorpay opens. Paid plans auto-renew monthly until cancelled.',
  },
  {
    title: 'How long can an interview be?',
    content:
      'Basic includes one 10-minute interview each month. Plus, Pro, and ₹69 additional interviews support durations up to 30 minutes.',
  },
]

interface BillingPricingExperienceProps {
  currentPlan: LegacyStoredPlanKey
  authStatus: 'loading' | 'authenticated' | 'unauthenticated'
}

export function BillingPricingExperience({
  currentPlan,
  authStatus,
}: BillingPricingExperienceProps) {
  const { catalog, error, loading, reload } = usePublicBillingCatalog()
  const [quotes, setQuotes] = useState<
    Partial<Record<PaidBillingPlanKey, CustomerBillingQuote>>
  >({})
  const [quoteLoading, setQuoteLoading] = useState(false)
  const [selectedPlan, setSelectedPlan] =
    useState<PaidBillingPlanKey | null>(null)
  const resumeCheckedRef = useRef(false)

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
      const response = await fetch('/api/billing/quote', {
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
      resumeCheckedRef.current
    ) {
      return
    }
    resumeCheckedRef.current = true

    const recovery = readBillingCheckoutRecovery()
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
  }, [authStatus, catalog, currentPlan])

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
    setSelectedPlan(planKey)
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
        <header className="mb-14 space-y-3 text-center">
          <p className="text-xs font-semibold uppercase tracking-[0.18em] text-blue-600">
            GST-inclusive pricing
          </p>
          <h1 className="text-display text-[#0f1419]">
            Practice free. Upgrade when the extra reps matter.
          </h1>
          <p className="mx-auto max-w-2xl text-body text-[#71767b]">
            One Basic interview and one clean editable resume are free. Every
            interview is capped at 30 minutes; paid plans add more interviews,
            deeper analysis, and resume tools.
          </p>
        </header>

        <section
          aria-label="Interview preparation plans"
          className="grid gap-component md:grid-cols-3"
        >
          {PLAN_ORDER.map((planKey) => (
            <BillingPlanCard
              key={planKey}
              plan={catalog.plans[planKey]}
              currentPlan={currentPlan}
              quote={planKey === 'free' ? undefined : quotes[planKey]}
              quoteLoading={planKey !== 'free' && quoteLoading}
              onSelect={selectPlan}
            />
          ))}
        </section>

        <section className="mt-8 grid gap-4 md:grid-cols-2">
          <article className="rounded-2xl border border-blue-200 bg-blue-50 px-5 py-4">
            <h2 className="text-sm font-semibold text-blue-950">
              Need just one more interview?
            </h2>
            <p className="mt-1 text-sm text-blue-900">
              An additional interview costs{' '}
              <strong>
                ₹{catalog.oneTimeProducts.single_interview.listPricePaise / 100}
              </strong>
              , supports up to 30 minutes, and does not use coupons.
            </p>
            <span className="mt-3 inline-flex text-xs font-medium text-blue-700">
              Purchase from the interview paywall after setup
            </span>
          </article>

          <article className="rounded-2xl border border-violet-200 bg-violet-50 px-5 py-4">
            <h2 className="text-sm font-semibold text-violet-950">
              Need one premium resume identity?
            </h2>
            <p className="mt-1 text-sm text-violet-900">
              A premium resume unlock costs{' '}
              <strong>
                ₹{catalog.oneTimeProducts.premium_resume.listPricePaise / 100}
              </strong>
              , starts its seven-day revision window after the first
              successful render, and does not use coupons.
            </p>
            <Link
              href="/resume"
              className="mt-3 inline-flex text-xs font-medium text-violet-700 hover:text-violet-800"
            >
              Choose a saved resume to unlock
            </Link>
          </article>
        </section>

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

      {selectedPlan && (
        <BillingCheckoutDialog
          key={selectedPlan}
          catalog={catalog}
          planKey={selectedPlan}
          onClose={() => setSelectedPlan(null)}
        />
      )}
    </main>
  )
}
