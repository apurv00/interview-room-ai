import { render, screen } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  readHomepagePricingCatalogSnapshot: vi.fn(),
}))

vi.mock('@/modules/marketing/server/homepagePricingCatalog', () => ({
  readHomepagePricingCatalogSnapshot:
    mocks.readHomepagePricingCatalogSnapshot,
}))

vi.mock('@learn', () => ({
  PathwayStatusBanner: () => <div data-testid="pathway-banner" />,
}))

vi.mock('@/modules/marketing/components/MarketingHomepage', () => ({
  default: ({
    initialBillingCatalog,
  }: {
    initialBillingCatalog: { catalogVersion: string } | null
  }) => (
    <output data-testid="homepage-catalog">
      {initialBillingCatalog?.catalogVersion ?? 'unavailable'}
    </output>
  ),
}))

import HomePage, { dynamic } from '../page'

beforeEach(() => {
  vi.clearAllMocks()
})

describe('homepage server pricing composition', () => {
  it('passes the server-read catalog into the initial homepage render', async () => {
    mocks.readHomepagePricingCatalogSnapshot.mockResolvedValue({
      catalogVersion: 'server-authoritative-v1',
    })

    render(await HomePage())

    expect(screen.getByTestId('homepage-catalog')).toHaveTextContent(
      'server-authoritative-v1',
    )
    expect(mocks.readHomepagePricingCatalogSnapshot).toHaveBeenCalledTimes(1)
    expect(dynamic).toBe('force-dynamic')
  })

  it('fails closed without blocking the rest of the homepage', async () => {
    mocks.readHomepagePricingCatalogSnapshot.mockResolvedValue(null)

    render(await HomePage())

    expect(screen.getByTestId('pathway-banner')).toBeInTheDocument()
    expect(screen.getByTestId('homepage-catalog')).toHaveTextContent(
      'unavailable',
    )
  })
})
