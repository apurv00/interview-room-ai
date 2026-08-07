'use client'

import { useCallback, useState } from 'react'
import Link from 'next/link'
import { useSession } from 'next-auth/react'
import Accordion from '@shared/ui/Accordion'
import Badge from '@shared/ui/Badge'
import Button from '@shared/ui/Button'
import Input from '@shared/ui/Input'
import StartCta from '@shared/ui/StartCta'
import { track } from '@shared/analytics/track'
import {
  CONSUMER_CATALOG_V1,
  LAUNCH_COUPON_POLICY,
  PR6_CUSTOMER_BILLING_UI_READY,
  type PersonalPlanKey,
} from '@shared/services/planConfig'
import { FAQ } from '@shared/pricingFaq'
import { BillingPricingExperience } from '@/app/_components/billing/BillingPricingExperience'

const PLAN_ORDER = ['free', 'plus', 'pro'] as const

function formatInr(paise: number): string {
  return new Intl.NumberFormat('en-IN', {
    style: 'currency',
    currency: 'INR',
    maximumFractionDigits: 0,
  }).format(paise / 100)
}

function CheckIcon() {
  return (
    <svg
      aria-hidden="true"
      className="mt-0.5 h-4 w-4 shrink-0 text-emerald-500"
      fill="none"
      viewBox="0 0 24 24"
      stroke="currentColor"
      strokeWidth={2}
    >
      <path
        strokeLinecap="round"
        strokeLinejoin="round"
        d="M5 13l4 4L19 7"
      />
    </svg>
  )
}

function planFeatures(planKey: PersonalPlanKey): readonly string[] {
  const plan = CONSUMER_CATALOG_V1.plans[planKey]
  if (planKey === 'free') {
    return [
      '1 interview per calendar month',
      '10-minute interview duration',
      'Complete report and available replay',
    ]
  }

  return [
    `${plan.interview.includedPerPeriod} interviews per billing month`,
    'Any supported interview type, up to 30 minutes each',
    'Complete reports, analysis, and available replay',
  ]
}

function PlanCard({
  planKey,
  isCurrent,
}: {
  planKey: PersonalPlanKey
  isCurrent: boolean
}) {
  const plan = CONSUMER_CATALOG_V1.plans[planKey]
  const coupon =
    planKey === 'free'
      ? null
      : LAUNCH_COUPON_POLICY.plans[planKey]
  const highlighted = planKey === 'plus'

  return (
    <article
      className={`relative flex flex-col rounded-2xl border bg-white p-7 ${
        highlighted
          ? 'border-blue-400 shadow-[0_12px_40px_rgba(37,99,235,0.10)]'
          : 'border-[#e1e8ed]'
      }`}
    >
      {highlighted ? (
        <div className="absolute -top-2.5 left-1/2 -translate-x-1/2">
          <Badge variant="primary">Most popular</Badge>
        </div>
      ) : null}

      <h2 className="text-subheading text-[#0f1419]">
        {plan.displayName}
      </h2>

      <div className="mt-4 min-h-[92px]">
        {coupon ? (
          <>
            <div className="flex flex-wrap items-baseline gap-2">
              <span className="text-display text-[#0f1419]">
                {formatInr(coupon.defaultFirstCyclePayablePaise)}
              </span>
              <span className="text-body text-[#71767b]">first month</span>
            </div>
            <p className="mt-1 text-sm text-[#536471]">
              <span className="line-through">
                {formatInr(plan.listPricePaise)}
              </span>
              {' · '}
              {formatInr(coupon.defaultAutomaticDiscountPaise)} launch offer
            </p>
            <p className="mt-1 text-xs leading-5 text-[#71767b]">
              Then {formatInr(plan.listPricePaise)}/month. Auto-renews until
              cancelled. GST included.
            </p>
          </>
        ) : (
          <>
            <p className="text-display text-[#0f1419]">₹0</p>
            <p className="mt-1 text-xs leading-5 text-[#71767b]">
              No card required.
            </p>
          </>
        )}
      </div>

      <ul className="mt-6 flex flex-1 flex-col gap-3">
        {planFeatures(planKey).map((feature) => (
          <li
            key={feature}
            className="flex items-start gap-2 text-body text-[#536471]"
          >
            <CheckIcon />
            <span>{feature}</span>
          </li>
        ))}
      </ul>

      <div className="mt-8">
        {isCurrent ? (
          <Button variant="secondary" isFullWidth disabled>
            Current plan
          </Button>
        ) : planKey === 'free' ? (
          <StartCta>
            <Button variant="secondary" isFullWidth>
              Start with Basic
            </Button>
          </StartCta>
        ) : (
          <Button variant="secondary" isFullWidth disabled>
            Paid checkout opening soon
          </Button>
        )}
      </div>
    </article>
  )
}

function PricingWaitlistForm() {
  const [email, setEmail] = useState('')
  const [submitted, setSubmitted] = useState(false)
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState<string | null>(null)

  async function submitWaitlist() {
    if (submitting) return
    setSubmitting(true)
    setError(null)
    try {
      const response = await fetch('/api/waitlist', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          email,
          source: 'pricing-paid-pilot',
        }),
      })
      if (!response.ok) {
        const body = await response.json().catch(() => ({}))
        setError(body?.error || 'Could not save your email. Try again.')
        return
      }
      setSubmitted(true)
      track('waitlist_joined', { source: 'pricing-paid-pilot' })
    } catch {
      setError('Network error. Try again.')
    } finally {
      setSubmitting(false)
    }
  }

  if (submitted) {
    return (
      <p
        className="rounded-xl border border-emerald-200 bg-emerald-50 px-4 py-3 text-sm font-medium text-emerald-800"
        role="status"
      >
        You&apos;re on the paid-pilot list.
      </p>
    )
  }

  return (
    <div className="mx-auto max-w-md">
      <label
        htmlFor="pricing-waitlist-email"
        className="mb-2 block text-left text-xs font-medium text-[#536471]"
      >
        Email address
      </label>
      <div className="flex flex-col gap-2 sm:flex-row">
        <Input
          id="pricing-waitlist-email"
          type="email"
          autoComplete="email"
          placeholder="you@example.com"
          value={email}
          onChange={(event) => setEmail(event.target.value)}
          disabled={submitting}
        />
        <Button
          type="button"
          disabled={!email.includes('@') || submitting}
          onClick={submitWaitlist}
        >
          {submitting ? 'Saving…' : 'Join waitlist'}
        </Button>
      </div>
      {error ? (
        <p className="mt-2 text-xs text-red-600" role="alert">
          {error}
        </p>
      ) : null}
    </div>
  )
}

export interface PricingPageClientProps {
  readonly paidRolloutCopyEnabled?: boolean
}

export default function PricingPageClient({
  paidRolloutCopyEnabled = false,
}: PricingPageClientProps) {
  const { data: session, status, update } = useSession()
  const refreshBillingSession = useCallback(async () => {
    await update()
  }, [update])
  const currentPlan = (session?.user?.plan || 'free') as
    | 'free'
    | 'plus'
    | 'pro'
    | 'enterprise'

  if (
    PR6_CUSTOMER_BILLING_UI_READY &&
    paidRolloutCopyEnabled
  ) {
    return (
      <BillingPricingExperience
        currentPlan={currentPlan}
        authStatus={status}
        accountId={session?.user?.id ?? null}
        refreshSession={refreshBillingSession}
      />
    )
  }

  const accordionItems = FAQ.map(({ q, a }) => ({
    title: q,
    content: a,
  }))

  return (
    <main className="min-h-screen px-4 py-16 sm:px-6 lg:px-8">
      <div className="mx-auto max-w-5xl">
        <header className="mb-12 space-y-3 text-center">
          <p className="text-xs font-semibold uppercase tracking-[0.18em] text-blue-600">
            INR · GST-inclusive pricing
          </p>
          <h1 className="text-display text-[#0f1419]">
            Practice free. Add more reps when they matter.
          </h1>
          <p className="mx-auto max-w-2xl text-body text-[#71767b]">
            Basic includes one 10-minute interview each month. Plus and Pro
            add more interviews and deeper analysis; no interview exceeds 30
            minutes.
          </p>
        </header>

        <section
          aria-label="Billing rollout status"
          className="mb-8 rounded-2xl border border-amber-200 bg-amber-50 px-5 py-4 text-sm text-amber-950"
        >
          Prices and planned launch offers are published for transparency.
          Paid checkout remains paused while payment, refund, entitlement, and
          legal-readiness checks are completed. No payment can be started from
          this page.
        </section>

        <section
          aria-label="Interview preparation plans"
          className="grid gap-component md:grid-cols-3"
        >
          {PLAN_ORDER.map((planKey) => (
            <PlanCard
              key={planKey}
              planKey={planKey}
              isCurrent={currentPlan === planKey}
            />
          ))}
        </section>

        <section className="mt-14 rounded-2xl border border-[#e1e8ed] bg-white p-7 text-center">
          <h2 className="text-xl font-semibold text-[#0f1419]">
            Interested in the first paid pilot?
          </h2>
          <p className="mx-auto mb-5 mt-2 max-w-xl text-sm text-[#536471]">
            Join the waitlist for availability updates. Joining does not
            authorize a payment or reserve a particular coupon.
          </p>
          <PricingWaitlistForm />
        </section>

        <section className="mx-auto mt-20 max-w-2xl">
          <h2 className="mb-8 text-center text-display text-[#0f1419]">
            Frequently asked questions
          </h2>
          <Accordion items={accordionItems} />
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
    </main>
  )
}
