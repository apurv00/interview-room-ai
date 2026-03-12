'use client'

import { useState } from 'react'
import { useSession } from 'next-auth/react'
import Link from 'next/link'
import { PLANS, type PlanConfig } from '@/lib/services/stripe'
import { FAQ } from '@/lib/pricingFaq'
import Badge from '@/components/ui/Badge'
import Button from '@/components/ui/Button'
import Input from '@/components/ui/Input'
import Accordion from '@/components/ui/Accordion'

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

  return (
    <div
      className={`
        relative flex flex-col surface-card-bordered p-7
        ${isHighlighted
          ? 'border-[rgba(99,102,241,0.15)]'
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
      <h3 className="text-subheading text-[#f0f2f5]">{plan.label}</h3>

      {/* Price */}
      <div className="mt-4 flex items-baseline gap-1">
        {plan.priceMonthly === null ? (
          <span className="text-display text-[#f0f2f5]">Custom</span>
        ) : plan.priceMonthly === 0 ? (
          <span className="text-display text-[#f0f2f5]">$0</span>
        ) : (
          <>
            <span className="text-display text-[#f0f2f5]">${plan.priceMonthly}</span>
            <span className="text-body text-[#6b7280]">/month</span>
          </>
        )}
      </div>

      {/* Interview limit */}
      <p className="mt-2 text-body text-[#6b7280]">
        {plan.monthlyInterviewLimit >= 999999
          ? 'Unlimited interviews'
          : `${plan.monthlyInterviewLimit} interviews per month`}
      </p>

      {/* Features */}
      <ul className="mt-6 flex flex-col gap-element flex-1">
        {plan.features.map((feature) => (
          <li key={feature} className="flex items-start gap-2 text-body text-[#b0b8c4]">
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
            <Button variant="primary" isFullWidth disabled>
              Coming Soon
            </Button>
            <div className="flex gap-2">
              <Input
                placeholder="your@email.com"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
              />
              <Button variant="primary" size="sm">
                Notify Me
              </Button>
            </div>
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
        <h1 className="text-display text-center text-[#f0f2f5]">Simple pricing</h1>
        <p className="text-body text-[#6b7280] max-w-xl mx-auto">
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
        <h2 className="text-display text-[#f0f2f5] text-center mb-8">
          Frequently Asked Questions
        </h2>
        <Accordion items={accordionItems} />
      </div>

      {/* CTA link */}
      <div className="text-center mt-16 animate-fade-in">
        <Link href="/" className="text-[#818cf8] hover:text-[#a5b4fc] text-body font-medium transition">
          &larr; Start practicing now
        </Link>
      </div>
    </main>
  )
}
