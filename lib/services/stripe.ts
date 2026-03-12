// ─── Plan Configuration ──────────────────────────────────────────────────────
// Stripe integration will be added in a future phase.
// This module defines plan tiers and limits used across the app.

export interface PlanConfig {
  name: string
  label: string
  monthlyInterviewLimit: number
  rateLimitPerMin: number
  priceMonthly: number | null
  features: string[]
  highlighted?: boolean
}

/** Sentinel value representing an unlimited interview quota. */
export const UNLIMITED = 999999

export const PLANS: Record<string, PlanConfig> = {
  free: {
    name: 'free',
    label: 'Free',
    monthlyInterviewLimit: UNLIMITED,
    rateLimitPerMin: 15,
    priceMonthly: 0,
    features: [
      'Unlimited interviews',
      'Basic feedback summary',
      'Score tracking',
      'Community support',
    ],
  },
  pro: {
    name: 'pro',
    label: 'Pro',
    monthlyInterviewLimit: 30,
    rateLimitPerMin: 30,
    priceMonthly: 19,
    highlighted: true,
    features: [
      '30 interviews per month',
      'Detailed per-question feedback',
      'Recording playback',
      'Score trends & analytics',
      'Priority support',
    ],
  },
  enterprise: {
    name: 'enterprise',
    label: 'Enterprise',
    monthlyInterviewLimit: UNLIMITED,
    rateLimitPerMin: 60,
    priceMonthly: null,
    features: [
      'Unlimited interviews',
      'Everything in Pro',
      'Custom question templates',
      'Team management dashboard',
      'API access',
      'Dedicated account manager',
    ],
  },
}

export function getPlanLimits(plan: string): PlanConfig {
  return PLANS[plan] || PLANS.free
}
