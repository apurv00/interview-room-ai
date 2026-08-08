import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const ACCOUNT_A = '64b64c0f2f4e8b6a8c7d9e10'
const ACCOUNT_B = '64b64c0f2f4e8b6a8c7d9e11'

const mocks = vi.hoisted(() => ({
  mountCount: 0,
  update: vi.fn(),
  session: {
    value: {
      data: null as null | {
        user: { id: string; plan: 'free' | 'plus' | 'pro' | 'enterprise' }
      },
      status: 'loading' as 'loading' | 'authenticated' | 'unauthenticated',
      update: vi.fn(),
    },
  },
}))

vi.mock('next-auth/react', () => ({
  useSession: () => mocks.session.value,
}))

vi.mock(
  '@/app/_components/billing/BillingPricingExperience',
  async () => {
    const { useState } = await import('react')
    return {
      BillingPricingExperience: ({
        accountId,
      }: {
        accountId: string | null
      }) => {
        const [mountId] = useState(() => {
          mocks.mountCount += 1
          return mocks.mountCount
        })
        return (
          <div
            data-testid="billing-pricing-experience"
            data-account-id={accountId ?? 'none'}
            data-mount-id={mountId}
          />
        )
      },
    }
  },
)

import PricingPageClient from '../PricingPageClient'

function authenticatedSession(accountId: string) {
  return {
    data: {
      user: {
        id: accountId,
        plan: 'free' as const,
      },
    },
    status: 'authenticated' as const,
    update: mocks.update,
  }
}

beforeEach(() => {
  mocks.mountCount = 0
  mocks.update.mockReset().mockResolvedValue(undefined)
  mocks.session.value = authenticatedSession(ACCOUNT_A)
})

afterEach(() => {
  cleanup()
})

describe('PricingPageClient billing identity boundary', () => {
  it('remounts the billing experience when the authenticated account changes', () => {
    const view = render(
      <PricingPageClient paidRolloutCopyEnabled />,
    )

    expect(screen.getByTestId('billing-pricing-experience')).toHaveAttribute(
      'data-account-id',
      ACCOUNT_A,
    )
    expect(screen.getByTestId('billing-pricing-experience')).toHaveAttribute(
      'data-mount-id',
      '1',
    )

    mocks.session.value = authenticatedSession(ACCOUNT_B)
    view.rerender(<PricingPageClient paidRolloutCopyEnabled />)

    expect(screen.getByTestId('billing-pricing-experience')).toHaveAttribute(
      'data-account-id',
      ACCOUNT_B,
    )
    expect(screen.getByTestId('billing-pricing-experience')).toHaveAttribute(
      'data-mount-id',
      '2',
    )
  })
})
