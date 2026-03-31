'use client'

import { useState } from 'react'
import { useSession } from 'next-auth/react'
import Link from 'next/link'
import { PLANS, type PlanConfig } from '@shared/services/stripe'
import { FAQ } from '@shared/pricingFaq'
import Badge from '@shared/ui/Badge'
import Button from '@shared/ui/Button'
import Input from '@shared/ui/Input'
import Accordion from '@shared/ui/Accordion'

const PLAN_ORDER = ['free', 'pro', 'enterprise'] as const

function CheckIcon() {
  return (
    <svg className="w-4 h-4 text-[#34d399] flex-shrink-0 mt-0.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
      <path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7" />
    </svg>
  )
}

function PlanCard({ plan, isCurrent }: { plan: PlanConfig; isCurrent: boolean }) {
  const isHighlighted = plan.highlighted
  const [email, setEmail] = useState('')
  const [notifySubmitted, setNotifySubmitted] = useState(false)

  return (
    <div
      className={`
        relative flex flex-col bg-white border border-[#e1e8ed] rounded-2xl p-7
        ${isHighlighted
          ? 'border-[rgba(99,102,241,0.4)]'
          : ''
        }
      `}
    >
      {isHighlighted && (
        <div className="absolute -top-2.5 left-1/2 -translate-x-1/2">
          <Badge variant="primary">Popular</Badge>
        </div>
      )}

      {/* Plan name */}
      <h3 className="text-subheading text-[#0f1419]">{plan.label}</h3>

      {/* Price */}
      <div className="mt-4 flex items-baseline gap-1">
        {plan.priceMonthly === null ? (
          <span className="text-display text-[#0f1419]">Custom</span>
        ) : plan.priceMonthly === 0 ? (
          <span className="text-display text-[#0f1419]">$0</span>
        ) : (
          <>
            <span className="text-display text-[#0f1419]">${plan.priceMonthly}</span>
            <span className="text-body text-[#71767b]">/month</span>
          </>
        )}
      </div>

      {/* Interview limit */}
      <p className="mt-2 text-body text-[#71767b]">
        {plan.monthlyInterviewLimit >= 999999
          ? 'Unlimited interviews'
          : `${plan.monthlyInterviewLimit} interviews per month`}
      </p>

      {/* Features */}
      <ul className="mt-6 flex flex-col gap-element flex-1">
        {plan.features.map((feature) => (
          <li key={feature} className="flex items-start gap-2 text-body text-[#536471]">
            <CheckIcon />
            {feature}
          </li>
        ))}
      </ul>

      {/* CTA */}
      <div className="mt-8">
        {isCurrent ? (
          <Button variant="secondary" isFullWidth disabled>
            Current Plan
          </Button>
        ) : plan.name === 'free' ? (
          <Link href="/signup">
            <Button variant="secondary" isFullWidth>
              Get Started Free
            </Button>
          </Link>
        ) : plan.name === 'pro' ? (
          <div className="flex flex-col gap-element">
            {notifySubmitted ? (
              <div className="flex items-center justify-center gap-2 py-3 px-4 rounded-xl border-2 border-emerald-500/30 bg-emerald-500/5">
                <svg className="w-4 h-4 text-emerald-600 shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                  <path strokeLinecap="round" strokeLinejoin="round" d="M9 12l2 2 4-4m6 2a9 9 0 11-18 0 9 9 0 0118 0z" />
                </svg>
                <span className="text-sm text-emerald-600 font-medium">You&apos;re on the list!</span>
              </div>
            ) : (
              <>
                <p className="text-xs text-[#536471] font-medium text-center">Get notified when Pro launches</p>
                <div className="flex gap-2">
                  <Input
                    placeholder="your@email.com"
                    value={email}
                    onChange={(e) => setEmail(e.target.value)}
                  />
                  <Button variant="primary" size="sm" disabled={!email.includes('@')} onClick={() => setNotifySubmitted(true)}>
                    Notify Me
                  </Button>
                </div>
              </>
            )}
          </div>
        ) : (
          <a href="mailto:contact@interviewprep.guru">
            <Button variant="secondary" isFullWidth>
              Contact Sales
            </Button>
          </a>
        )}
      </div>
    </div>
  )
}

export default function PricingPage() {
  const { data: session } = useSession()
  const currentPlan = (session?.user?.plan as string) || 'free'

  const accordionItems = FAQ.map(({ q, a }) => ({
    title: q,
    content: a,
  }))

  return (
    <main className="min-h-screen px-4 py-16 max-w-[1000px] mx-auto">
      {/* Header */}
      <div className="text-center space-y-3 mb-14 animate-fade-in">
        <h1 className="text-display text-center text-[#0f1419]">Simple pricing</h1>
        <p className="text-body text-[#71767b] max-w-xl mx-auto">
          Start free. Upgrade when you&apos;re ready.
        </p>
      </div>

      {/* Plan cards */}
      <div className="grid md:grid-cols-3 gap-component mb-20 animate-fade-in">
        {PLAN_ORDER.map((key) => (
          <PlanCard
            key={key}
            plan={PLANS[key]}
            isCurrent={currentPlan === key}
          />
        ))}
      </div>

      {/* FAQ */}
      <div className="max-w-2xl mx-auto animate-fade-in">
        <h2 className="text-display text-[#0f1419] text-center mb-8">
          Frequently Asked Questions
        </h2>
        <Accordion items={accordionItems} />
      </div>

      {/* CTA link */}
      <div className="text-center mt-16 animate-fade-in">
        <Link href="/" className="text-[#6366f1] hover:text-[#4f46e5] text-body font-medium transition">
          &larr; Start practicing now
        </Link>
      </div>
    </main>
  )
}
