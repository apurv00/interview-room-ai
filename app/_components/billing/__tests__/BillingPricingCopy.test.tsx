import { cleanup, render, screen, within } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { CONSUMER_CATALOG_V1 } from '@shared/services/planConfig'
import { billingResponseSchemas } from '../billingClient'

const catalog = billingResponseSchemas.catalog.parse({
  ...CONSUMER_CATALOG_V1,
  effectiveAt: '2026-08-01T00:00:00.000Z',
  customerBillingUiReady: true,
  checkoutRequiresAuthentication: true,
})

vi.mock('../usePublicBillingCatalog', () => ({
  usePublicBillingCatalog: () => ({
    catalog,
    error: null,
    loading: false,
    reload: vi.fn(),
  }),
}))
vi.mock('../BillingCheckoutDialog', () => ({
  BillingCheckoutDialog: () => null,
}))
vi.mock('../FutureSubscriptionCheckoutDialog', () => ({
  FutureSubscriptionCheckoutDialog: () => null,
}))

import { BillingPlanCard } from '../BillingPlanCard'
import { BillingPricingExperience } from '../BillingPricingExperience'

afterEach(cleanup)

describe('customer-facing pricing copy', () => {
  it('shows catalog-derived resume allowances and the common Jobs benefit', () => {
    render(
      <>
        {(['free', 'plus', 'pro'] as const).map((planKey) => (
          <BillingPlanCard
            key={planKey}
            plan={catalog.plans[planKey]}
            currentPlan="enterprise"
            onSelect={vi.fn()}
          />
        ))}
      </>,
    )

    expect(screen.getByText('1 Basic resume saved')).toBeInTheDocument()
    expect(screen.getByText(
      '1 Basic resume + 5 premium resume versions per billing cycle',
    )).toBeInTheDocument()
    expect(screen.getByText(
      '1 Basic resume + 15 premium resume versions per billing cycle',
    )).toBeInTheDocument()
    expect(screen.getAllByText(
      'Jobs discovery, resume matching, and application tracking',
    )).toHaveLength(3)
    expect(screen.queryByText(/GST included/i)).not.toBeInTheDocument()
  })

  it('keeps the pricing headline without the removed eyebrow or subtitle', () => {
    render(
      <BillingPricingExperience
        currentPlan="free"
        authStatus="unauthenticated"
        accountId={null}
        refreshSession={vi.fn().mockResolvedValue(undefined)}
      />,
    )

    const heading = screen.getByRole('heading', {
      name: 'Practice free. Upgrade when the extra reps matter.',
    })
    expect(heading).toBeInTheDocument()
    const header = heading.closest('header')
    expect(header).not.toBeNull()
    expect(within(header!).queryByText('GST-inclusive pricing'))
      .not.toBeInTheDocument()
    expect(within(header!).queryByText(
      /Basic includes one 10-minute interview/i,
    ))
      .not.toBeInTheDocument()
  })
})
