import Link from 'next/link'
import { Check } from 'lucide-react'
import { Button } from '@/shared/ui/shadcn/button'
import { Badge } from '@/shared/ui/shadcn/badge'

const plans = [
  {
    name: 'Free',
    price: '$0',
    period: '/month',
    description: 'Get started with mock interviews',
    features: ['Unlimited interviews', 'AI feedback & scoring', '12+ career domains', 'Basic progress tracking'],
    cta: 'Get Started',
    ctaVariant: 'outline' as const,
    href: '/signup',
    highlighted: false,
  },
  {
    name: 'Pro',
    price: '$11',
    period: '/month',
    description: 'Unlimited practice for serious prep',
    features: ['Unlimited interviews', 'Advanced AI coaching', 'Resume builder & tailor', 'Priority support', 'Custom practice plans'],
    cta: 'Get Early Access',
    ctaVariant: 'default' as const,
    href: '/pricing',
    highlighted: true,
    badge: 'Coming Soon',
  },
  {
    name: 'Enterprise',
    price: 'Custom',
    period: '',
    description: 'For teams and organizations',
    features: ['Everything in Pro', 'Candidate screening', 'Team analytics', 'Custom interview templates', 'SSO & admin controls'],
    cta: 'Contact Us',
    ctaVariant: 'outline' as const,
    href: '/pricing',
    highlighted: false,
  },
]

export default function Pricing() {
  return (
    <section className="section-white px-4 sm:px-6 py-16">
      <div className="max-w-[1000px] mx-auto">
        <div className="text-center mb-12">
          <h2 className="text-2xl sm:text-3xl font-bold text-[#0f1419] tracking-tight">
            Simple Pricing
          </h2>
          <p className="mt-3 text-[#536471]">
            Start free. Upgrade when you&apos;re ready.
          </p>
        </div>

        <div className="grid md:grid-cols-3 gap-4 stagger-children">
          {plans.map((plan) => (
            <div
              key={plan.name}
              className={`relative bg-white rounded-2xl border p-7 transition-all duration-200 ${
                plan.highlighted
                  ? 'border-[#2563eb] shadow-[0_0_0_1px_rgba(37,99,235,0.15),var(--shadow-card-hover)] scale-[1.02]'
                  : 'border-[#e1e8ed] shadow-card hover:shadow-card-hover'
              }`}
            >
              {/* Popular badge */}
              {plan.highlighted && (
                <div className="absolute -top-3 left-1/2 -translate-x-1/2">
                  <Badge variant="primary" className="shadow-sm">Popular</Badge>
                </div>
              )}

              <p className="text-base font-semibold text-[#0f1419]">{plan.name}</p>
              <div className="mt-3 flex items-baseline gap-1">
                <span className="text-4xl font-extrabold text-[#0f1419] tracking-tight">{plan.price}</span>
                {plan.period && <span className="text-sm text-[#8b98a5]">{plan.period}</span>}
              </div>
              <p className="mt-2 text-sm text-[#71767b]">{plan.description}</p>

              {/* Features */}
              <ul className="mt-6 space-y-3">
                {plan.features.map((feature) => (
                  <li key={feature} className="flex items-start gap-2.5 text-sm text-[#536471]">
                    <Check className="size-4 text-[#059669] mt-0.5 shrink-0" strokeWidth={2.5} />
                    {feature}
                  </li>
                ))}
              </ul>

              <div className="mt-6 space-y-2">
                {plan.badge && (
                  <Badge variant="caution" className="w-fit">{plan.badge}</Badge>
                )}
                <Link href={plan.href} className="block">
                  <Button variant={plan.ctaVariant} className="w-full">
                    {plan.cta}
                  </Button>
                </Link>
              </div>
            </div>
          ))}
        </div>

        <div className="text-center mt-8">
          <Link
            href="/pricing"
            className="text-sm font-semibold text-[#2563eb] hover:text-[#1d4ed8] transition-colors"
          >
            Compare plans in detail &rarr;
          </Link>
        </div>
      </div>
    </section>
  )
}
