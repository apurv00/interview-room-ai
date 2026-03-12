'use client'

import { useSession } from 'next-auth/react'
import Link from 'next/link'
import { PLANS, UNLIMITED, type PlanConfig } from '@/lib/services/stripe'

const PLAN_ORDER = ['free', 'pro', 'enterprise'] as const

function CheckIcon() {
  return (
    <svg className="w-4 h-4 text-emerald-400 flex-shrink-0 mt-0.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
      <path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7" />
    </svg>
  )
}

function PlanCard({ plan, isCurrent }: { plan: PlanConfig; isCurrent: boolean }) {
  const isHighlighted = plan.highlighted

  return (
    <div
      className={`
        relative flex flex-col rounded-2xl border p-6 transition-all duration-200
        ${isHighlighted
          ? 'border-indigo-500 bg-indigo-500/5 shadow-lg shadow-indigo-500/10 scale-[1.02]'
          : 'border-slate-700 bg-slate-900'
        }
      `}
    >
      {isHighlighted && (
        <div className="absolute -top-3 left-1/2 -translate-x-1/2 px-3 py-1 bg-indigo-600 text-white text-xs font-semibold rounded-full">
          Most Popular
        </div>
      )}

      {/* Plan name */}
      <h3 className="text-lg font-semibold text-white">{plan.label}</h3>

      {/* Price */}
      <div className="mt-4 flex items-baseline gap-1">
        {plan.priceMonthly === null ? (
          <span className="text-3xl font-bold text-white">Custom</span>
        ) : plan.priceMonthly === 0 ? (
          <span className="text-3xl font-bold text-white">$0</span>
        ) : (
          <>
            <span className="text-3xl font-bold text-white">${plan.priceMonthly}</span>
            <span className="text-slate-400 text-sm">/month</span>
          </>
        )}
      </div>

      {/* Interview limit */}
      <p className="mt-2 text-sm text-slate-400">
        {plan.monthlyInterviewLimit >= UNLIMITED
          ? 'Unlimited interviews'
          : `${plan.monthlyInterviewLimit} interviews per month`}
      </p>

      {/* Features */}
      <ul className="mt-6 space-y-3 flex-1">
        {plan.features.map((feature) => (
          <li key={feature} className="flex items-start gap-2 text-sm text-slate-300">
            <CheckIcon />
            {feature}
          </li>
        ))}
      </ul>

      {/* CTA */}
      <div className="mt-8">
        {isCurrent ? (
          <div className="w-full py-3 rounded-xl text-center text-sm font-medium bg-slate-800 text-slate-400 border border-slate-700">
            Current Plan
          </div>
        ) : plan.name === 'free' ? (
          <Link
            href="/signup"
            className="block w-full py-3 rounded-xl text-center text-sm font-medium bg-slate-800 text-slate-200 border border-slate-700 hover:bg-slate-700 transition"
          >
            Get Started Free
          </Link>
        ) : plan.name === 'pro' ? (
          <button
            disabled
            className="w-full py-3 rounded-xl text-sm font-medium bg-indigo-600/50 text-indigo-200 border border-indigo-500/30 cursor-not-allowed"
          >
            Coming Soon
          </button>
        ) : (
          <a
            href="mailto:contact@interviewprep.guru"
            className="block w-full py-3 rounded-xl text-center text-sm font-medium bg-slate-800 text-slate-200 border border-slate-700 hover:bg-slate-700 transition"
          >
            Contact Sales
          </a>
        )}
      </div>
    </div>
  )
}

import { FAQ } from '@/lib/pricingFaq'

export default function PricingPage() {
  const { data: session } = useSession()
  const currentPlan = (session?.user?.plan as string) || 'free'

  return (
    <main className="min-h-screen px-4 py-16 max-w-5xl mx-auto">
      {/* Header */}
      <div className="text-center space-y-3 mb-14 animate-slide-up">
        <h1 className="text-4xl font-bold text-white">Simple, transparent pricing</h1>
        <p className="text-slate-400 text-lg max-w-xl mx-auto">
          Practice with AI-powered interviews. Start free, upgrade when you are ready.
        </p>
      </div>

      {/* Plan cards */}
      <div className="grid md:grid-cols-3 gap-6 mb-20 animate-slide-up stagger-1">
        {PLAN_ORDER.map((key) => (
          <PlanCard
            key={key}
            plan={PLANS[key]}
            isCurrent={currentPlan === key}
          />
        ))}
      </div>

      {/* FAQ */}
      <div className="max-w-2xl mx-auto animate-slide-up stagger-2">
        <h2 className="text-2xl font-bold text-white text-center mb-8">
          Frequently Asked Questions
        </h2>
        <div className="space-y-4">
          {FAQ.map(({ q, a }) => (
            <details
              key={q}
              className="group bg-slate-900 border border-slate-700 rounded-xl overflow-hidden"
            >
              <summary className="flex items-center justify-between px-5 py-4 cursor-pointer text-sm font-medium text-slate-200 hover:text-white transition">
                {q}
                <svg
                  className="w-4 h-4 text-slate-500 transition-transform group-open:rotate-180"
                  fill="none"
                  viewBox="0 0 24 24"
                  stroke="currentColor"
                  strokeWidth={2}
                >
                  <path strokeLinecap="round" strokeLinejoin="round" d="M19 9l-7 7-7-7" />
                </svg>
              </summary>
              <div className="px-5 pb-4 text-sm text-slate-400 leading-relaxed">
                {a}
              </div>
            </details>
          ))}
        </div>
      </div>

      {/* CTA link */}
      <div className="text-center mt-16 animate-slide-up stagger-3">
        <Link href="/" className="text-indigo-400 hover:text-indigo-300 text-sm font-medium transition">
          ← Start practicing now
        </Link>
      </div>
    </main>
  )
}
