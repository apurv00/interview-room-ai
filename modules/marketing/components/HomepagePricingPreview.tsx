'use client'

import Link from 'next/link'
import { CheckCircle2 } from 'lucide-react'
import {
  formatInr,
  type PublicBillingCatalog,
} from '@/app/_components/billing/billingClient'
import { usePublicBillingCatalog } from '@/app/_components/billing/usePublicBillingCatalog'

const PLAN_ORDER = ['free', 'plus', 'pro'] as const

type HomepagePlan = PublicBillingCatalog['plans'][
  (typeof PLAN_ORDER)[number]
]

function interviewAllowance(plan: HomepagePlan): string {
  const count = plan.interview.includedPerPeriod
  const interviewLabel = count === 1 ? 'interview' : 'interviews'
  const periodLabel = plan.interview.periodOwner === 'calendar_month'
    ? 'calendar month'
    : 'billing month'
  return `${count} ${plan.interview.maxDurationMinutes}-minute ${interviewLabel} per ${periodLabel}`
}

function resumeAllowance(plan: HomepagePlan): string {
  const premium = plan.resume.premiumSavedResumeLimitPerPeriod
  if (premium === 0) return '1 Basic resume saved'
  return `1 Basic resume + ${premium} premium resume versions per billing cycle`
}

function planFeatures(plan: HomepagePlan): readonly string[] {
  return [
    interviewAllowance(plan),
    'Complete analysis and available replay',
    resumeAllowance(plan),
    'Jobs discovery, resume matching, and application tracking',
  ]
}

function PricingUnavailable({ loading }: { loading: boolean }) {
  return (
    <div
      className="mx-auto max-w-xl rounded-2xl border border-slate-200 bg-slate-50 px-6 py-8 text-center"
      role={loading ? 'status' : 'alert'}
    >
      <p className="text-sm text-slate-600">
        {loading
          ? 'Loading current pricing…'
          : 'Current pricing is temporarily unavailable here.'}
      </p>
      {!loading ? (
        <Link
          href="/pricing"
          className="mt-3 inline-flex text-sm font-semibold text-blue-600 transition-colors hover:text-blue-700"
        >
          Open the Pricing page
        </Link>
      ) : null}
    </div>
  )
}

export interface HomepagePricingPreviewProps {
  readonly onStartFree: () => void
}

export function HomepagePricingPreview({
  onStartFree,
}: HomepagePricingPreviewProps) {
  const { catalog, error, loading } = usePublicBillingCatalog({
    cachePolicy: 'homepage-memory',
  })
  const pricingAvailable = Boolean(
    catalog?.customerBillingUiReady && !error,
  )

  return (
    <section
      aria-labelledby="homepage-pricing-heading"
      className="bg-white py-20"
    >
      <div className="mx-auto max-w-6xl px-4 sm:px-6 lg:px-8">
        <div className="mb-14 text-center">
          <h2
            id="homepage-pricing-heading"
            className="mb-3 text-3xl font-extrabold text-slate-900 md:text-4xl"
          >
            Practice free. Upgrade when the extra reps matter.
          </h2>
          <p className="text-base text-slate-500">
            Current INR list pricing. Eligible offers appear on the Pricing
            page.
          </p>
        </div>

        {!pricingAvailable || !catalog ? (
          <PricingUnavailable loading={loading && !error} />
        ) : (
          <>
            <div className="mx-auto grid max-w-6xl gap-5 md:grid-cols-3">
              {PLAN_ORDER.map((planKey) => {
                const plan = catalog.plans[planKey]
                const highlighted = planKey === 'plus'
                return (
                  <article
                    key={plan.key}
                    className={`relative flex flex-col rounded-2xl p-7 transition-all ${
                      highlighted
                        ? 'bg-slate-800 text-white'
                        : 'border border-slate-200 bg-white hover:shadow-lg hover:shadow-slate-100/50'
                    }`}
                  >
                    {highlighted ? (
                      <div className="absolute right-5 top-0 -translate-y-1/2 rounded-full bg-blue-600 px-3 py-1 text-[10px] font-semibold uppercase tracking-wider text-white">
                        Most popular
                      </div>
                    ) : null}
                    <h3
                      className={`mb-1 text-xl font-bold ${
                        highlighted ? 'text-white' : 'text-slate-800'
                      }`}
                    >
                      {plan.displayName}
                    </h3>
                    <div
                      className={`mb-6 flex min-h-16 items-baseline gap-1 border-b pb-6 ${
                        highlighted ? 'border-slate-700' : 'border-slate-100'
                      }`}
                    >
                      <span
                        className={`text-4xl font-extrabold ${
                          highlighted ? 'text-white' : 'text-slate-800'
                        }`}
                      >
                        {formatInr(plan.listPricePaise)}
                      </span>
                      {plan.billingPeriod === 'monthly' ? (
                        <span className={
                          highlighted ? 'text-slate-400' : 'text-slate-500'
                        }>
                          /month
                        </span>
                      ) : (
                        <span className="text-slate-500">No card required</span>
                      )}
                    </div>
                    <ul className="mb-8 flex flex-1 flex-col gap-3">
                      {planFeatures(plan).map((feature) => (
                        <li
                          key={feature}
                          className={`flex items-start gap-2.5 text-sm ${
                            highlighted ? 'text-slate-300' : 'text-slate-600'
                          }`}
                        >
                          <CheckCircle2
                            aria-hidden="true"
                            className={`mt-0.5 h-4 w-4 shrink-0 ${
                              highlighted ? 'text-blue-400' : 'text-blue-500'
                            }`}
                          />
                          <span>{feature}</span>
                        </li>
                      ))}
                    </ul>
                    {planKey === 'free' ? (
                      <button
                        type="button"
                        onClick={onStartFree}
                        className="block w-full rounded-xl bg-slate-100 py-3 text-center text-sm font-semibold text-slate-700 transition-colors hover:bg-slate-200"
                      >
                        Get started with Basic
                      </button>
                    ) : (
                      <Link
                        href="/pricing"
                        className={`block w-full rounded-xl py-3 text-center text-sm font-semibold transition-colors ${
                          highlighted
                            ? 'bg-white/10 text-white hover:bg-white/20'
                            : 'bg-slate-100 text-slate-700 hover:bg-slate-200'
                        }`}
                      >
                        See {plan.displayName} details
                      </Link>
                    )}
                  </article>
                )
              })}
            </div>
            <p className="mt-5 text-center text-xs text-slate-500">
              {catalog.gstInclusive ? 'GST included. ' : ''}
              Paid plans renew monthly until cancelled.
            </p>
          </>
        )}
      </div>
    </section>
  )
}
