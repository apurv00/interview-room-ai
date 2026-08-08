import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { CONSUMER_CATALOG_V1 } from '@shared/services/planConfig'
import { billingResponseSchemas } from '../billingClient'
import { BillingPlanCard } from '../BillingPlanCard'

const catalog = billingResponseSchemas.catalog.parse({
  ...CONSUMER_CATALOG_V1,
  effectiveAt: '2026-08-01T00:00:00.000Z',
  customerBillingUiReady: true,
  checkoutRequiresAuthentication: true,
})

afterEach(cleanup)

describe('BillingPlanCard acquisition CTA', () => {
  it('keeps the default acquisition label and selection behavior', () => {
    const onSelect = vi.fn()
    render(
      <BillingPlanCard
        plan={catalog.plans.plus}
        currentPlan="free"
        onSelect={onSelect}
      />,
    )

    fireEvent.click(screen.getByRole('button', { name: 'Choose Plus' }))
    expect(onSelect).toHaveBeenCalledWith('plus')
  })

  it('renders an exact custom acquisition label', () => {
    const onSelect = vi.fn()
    render(
      <BillingPlanCard
        plan={catalog.plans.plus}
        currentPlan="free"
        acquisitionCtaLabel="Pay ₹499 Now"
        onSelect={onSelect}
      />,
    )

    fireEvent.click(screen.getByRole('button', { name: 'Pay ₹499 Now' }))
    expect(onSelect).toHaveBeenCalledWith('plus')
  })

  it('exposes and disables a busy acquisition CTA', () => {
    const onSelect = vi.fn()
    render(
      <BillingPlanCard
        plan={catalog.plans.plus}
        currentPlan="free"
        acquisitionCtaLabel="Checking price…"
        acquisitionCtaBusy
        onSelect={onSelect}
      />,
    )

    const button = screen.getByRole('button', { name: 'Checking price…' })
    expect(button).toBeDisabled()
    expect(button).toHaveAttribute('aria-busy', 'true')
    fireEvent.click(button)
    expect(onSelect).not.toHaveBeenCalled()
  })

  it('supports an explicitly disabled acquisition CTA', () => {
    const onSelect = vi.fn()
    render(
      <BillingPlanCard
        plan={catalog.plans.plus}
        currentPlan="free"
        acquisitionCtaLabel="Sign in to buy Plus"
        acquisitionCtaDisabled
        onSelect={onSelect}
      />,
    )

    const button = screen.getByRole('button', {
      name: 'Sign in to buy Plus',
    })
    expect(button).toBeDisabled()
    expect(button).not.toHaveAttribute('aria-busy')
    fireEvent.click(button)
    expect(onSelect).not.toHaveBeenCalled()
  })

  it('does not apply acquisition CTA overrides to paid-plan switching', () => {
    const onSelect = vi.fn()
    render(
      <BillingPlanCard
        plan={catalog.plans.pro}
        currentPlan="plus"
        acquisitionCtaLabel="Checking price…"
        acquisitionCtaDisabled
        acquisitionCtaBusy
        paidPlanChangeAvailable
        onSelect={onSelect}
      />,
    )

    const button = screen.getByRole('button', { name: 'Switch to Pro' })
    expect(button).toBeEnabled()
    expect(button).not.toHaveAttribute('aria-busy')
    fireEvent.click(button)
    expect(onSelect).toHaveBeenCalledWith('pro')
  })
})
