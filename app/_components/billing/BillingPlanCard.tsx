'use client'

import Link from 'next/link'
import Badge from '@shared/ui/Badge'
import Button from '@shared/ui/Button'
import type { LegacyStoredPlanKey } from '@shared/services/planConfig'
import {
  formatInr,
  type CustomerBillingQuote,
  type PublicBillingCatalog,
} from './billingClient'

type BillingPlan = PublicBillingCatalog['plans']['free']
  | PublicBillingCatalog['plans']['plus']
  | PublicBillingCatalog['plans']['pro']

interface BillingPlanCardProps {
  plan: BillingPlan
  currentPlan: LegacyStoredPlanKey
  quote?: CustomerBillingQuote
  quoteLoading?: boolean
  onSelect: (planKey: 'plus' | 'pro') => void
}

function planFeatures(plan: BillingPlan): string[] {
  const interviewLabel = plan.interview.includedPerPeriod === 1
    ? `1 ${plan.interview.maxDurationMinutes}-minute interview per month`
    : `${plan.interview.includedPerPeriod} interviews per billing month, up to ${plan.interview.maxDurationMinutes} minutes`
  const resumeLabel = plan.key === 'free'
    ? '1 editable clean basic resume'
    : `${plan.resume.premiumSavedResumeLimitPerPeriod} premium resume versions per billing month`

  if (plan.key === 'free') {
    return [
      interviewLabel,
      resumeLabel,
      'Core feedback and learning drills',
      'Additional 30-minute interviews available for ₹69 each',
    ]
  }
  if (plan.key === 'plus') {
    return [
      interviewLabel,
      'Full analysis, replay, and JD/resume personalization',
      resumeLabel,
      '1 editable clean basic resume',
    ]
  }
  return [
    interviewLabel,
    'Advanced progress and interview comparison',
    'Full resume toolkit',
    resumeLabel,
    'Priority processing',
  ]
}

export function BillingPlanCard({
  plan,
  currentPlan,
  quote,
  quoteLoading = false,
  onSelect,
}: BillingPlanCardProps) {
  const current = currentPlan === plan.key ||
    (currentPlan === 'free' && plan.key === 'free')
  const existingPaidPlan =
    currentPlan === 'plus' ||
    currentPlan === 'pro' ||
    currentPlan === 'enterprise'
  const paidPlanKey = plan.key === 'free' ? null : plan.key
  const hasOffer = Boolean(quote && quote.discountPaise > 0)
  const highlighted = plan.key === 'plus'

  return (
    <article
      className={`relative flex flex-col rounded-2xl border bg-white p-7 ${
        highlighted
          ? 'border-blue-400 shadow-[0_12px_40px_rgba(37,99,235,0.10)]'
          : 'border-[#e1e8ed]'
      }`}
    >
      {highlighted && (
        <div className="absolute -top-2.5 left-1/2 -translate-x-1/2">
          <Badge variant="primary">Most popular</Badge>
        </div>
      )}

      <h2 className="text-subheading text-[#0f1419]">
        {plan.displayName}
      </h2>

      <div className="mt-4 min-h-[72px]">
        {plan.key === 'free' ? (
          <p className="text-display text-[#0f1419]">₹0</p>
        ) : hasOffer && quote ? (
          <>
            <div className="flex flex-wrap items-baseline gap-2">
              <span className="text-display text-[#0f1419]">
                {formatInr(quote.payablePaise)}
              </span>
              <span className="text-body text-[#71767b]">first month</span>
            </div>
            <p className="mt-1 text-sm text-[#536471]">
              <span className="line-through">
                {formatInr(quote.listPricePaise)}
              </span>
              {' · '}
              {quote.coupon?.displayText ?? `${formatInr(quote.discountPaise)} off`}
            </p>
          </>
        ) : (
          <>
            <div className="flex items-baseline gap-1">
              <span className="text-display text-[#0f1419]">
                {formatInr(plan.listPricePaise)}
              </span>
              <span className="text-body text-[#71767b]">/month</span>
            </div>
            <p className="mt-1 text-xs text-[#71767b]">
              {quoteLoading
                ? 'Checking your best available offer…'
                : 'Your best available offer is checked after sign-in.'}
            </p>
          </>
        )}
      </div>

      {plan.key !== 'free' && (
        <p className="mt-2 text-xs leading-5 text-[#536471]">
          Renews at {formatInr(plan.listPricePaise)}/month. Cancel anytime.
          GST included.
        </p>
      )}

      <ul className="mt-6 flex flex-1 flex-col gap-3">
        {planFeatures(plan).map((feature) => (
          <li
            key={feature}
            className="flex items-start gap-2 text-body text-[#536471]"
          >
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
            <span>{feature}</span>
          </li>
        ))}
      </ul>

      <div className="mt-8">
        {current ? (
          <Button variant="secondary" isFullWidth disabled>
            Current plan
          </Button>
        ) : plan.key === 'free' ? (
          <Link
            href="/"
            className="flex h-9 w-full items-center justify-center rounded-md border border-input bg-background px-4 text-sm font-medium shadow-xs transition-colors hover:bg-accent hover:text-accent-foreground"
          >
            Start free
          </Link>
        ) : existingPaidPlan ? (
          <Link
            href="/settings#billing"
            className="flex h-9 w-full items-center justify-center rounded-md border border-input bg-background px-4 text-sm font-medium shadow-xs transition-colors hover:bg-accent hover:text-accent-foreground"
          >
            Manage plan change
          </Link>
        ) : paidPlanKey ? (
          <Button
            type="button"
            isFullWidth
            onClick={() => onSelect(paidPlanKey)}
          >
            Choose {plan.displayName}
          </Button>
        ) : null}
      </div>
    </article>
  )
}
