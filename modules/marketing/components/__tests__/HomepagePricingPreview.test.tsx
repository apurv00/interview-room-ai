import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { renderToStaticMarkup } from 'react-dom/server'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { CONSUMER_CATALOG_V1 } from '@shared/services/planConfig'
import { billingResponseSchemas } from '@/app/_components/billing/billingClient'
import { HomepagePricingPreview } from '../HomepagePricingPreview'

const catalog = billingResponseSchemas.catalog.parse({
  ...CONSUMER_CATALOG_V1,
  catalogVersion: 'homepage-pricing-sentinel',
  effectiveAt: '2026-08-21T00:00:00.000Z',
  customerBillingUiReady: true,
  checkoutRequiresAuthentication: true,
  plans: {
    ...CONSUMER_CATALOG_V1.plans,
    plus: {
      ...CONSUMER_CATALOG_V1.plans.plus,
      listPricePaise: 71_234,
      interview: {
        ...CONSUMER_CATALOG_V1.plans.plus.interview,
        includedPerPeriod: 7,
      },
    },
    pro: {
      ...CONSUMER_CATALOG_V1.plans.pro,
      listPricePaise: 123_456,
      interview: {
        ...CONSUMER_CATALOG_V1.plans.pro.interview,
        includedPerPeriod: 19,
      },
    },
  },
})

afterEach(cleanup)

describe('homepage pricing preview', () => {
  it('is the only pricing implementation composed into the homepage', () => {
    const homepageSource = readFileSync(
      resolve(
        process.cwd(),
        'modules/marketing/components/MarketingHomepage.tsx',
      ),
      'utf8',
    )

    expect(homepageSource).toContain('<HomepagePricingPreview')
    expect(homepageSource).toContain(
      'initialCatalog={initialBillingCatalog}',
    )
    expect(homepageSource).not.toMatch(
      /@shared\/services\/stripe|\bPLANS\b|\$19|Coming Soon/,
    )
  })

  it('renders every plan and allowance from the authoritative catalog', () => {
    const onStartFree = vi.fn()
    render(
      <HomepagePricingPreview
        initialCatalog={catalog}
        onStartFree={onStartFree}
      />,
    )

    expect(screen.getByRole('heading', { name: 'Basic' })).toBeInTheDocument()
    expect(screen.getByRole('heading', { name: 'Plus' })).toBeInTheDocument()
    expect(screen.getByRole('heading', { name: 'Pro' })).toBeInTheDocument()
    expect(screen.getByText('₹0')).toBeInTheDocument()
    expect(screen.getByText('₹712.34')).toBeInTheDocument()
    expect(screen.getByText('₹1,234.56')).toBeInTheDocument()
    expect(screen.getAllByText('/month')).toHaveLength(2)
    expect(screen.getByText(
      '1 10-minute interview per calendar month',
    )).toBeInTheDocument()
    expect(screen.getByText(
      '7 30-minute interviews per billing month',
    )).toBeInTheDocument()
    expect(screen.getByText(
      '19 30-minute interviews per billing month',
    )).toBeInTheDocument()
    expect(screen.queryByText(/\$19|Coming Soon|Get Notified/i))
      .not.toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', {
      name: 'Get started with Basic',
    }))
    expect(onStartFree).toHaveBeenCalledTimes(1)
    for (const link of screen.getAllByRole('link', { name: /details/i })) {
      expect(link).toHaveAttribute('href', '/pricing')
    }
  })

  it('includes authoritative plan content in the server-rendered HTML', () => {
    const html = renderToStaticMarkup(
      <HomepagePricingPreview
        initialCatalog={catalog}
        onStartFree={() => undefined}
      />,
    )

    expect(html).toContain('Basic')
    expect(html).toContain('Plus')
    expect(html).toContain('Pro')
    expect(html).toContain('₹712.34')
    expect(html).toContain('₹1,234.56')
    expect(html).toContain('Get started with Basic')
    expect(html).not.toContain('Loading current pricing')
  })

  it('fails closed to the Pricing page when the server catalog is unavailable', () => {
    render(
      <HomepagePricingPreview
        initialCatalog={null}
        onStartFree={vi.fn()}
      />,
    )

    expect(screen.getByRole('alert')).toHaveTextContent(
      'Current pricing is temporarily unavailable here.',
    )
    expect(screen.getByRole('link', { name: 'Open the Pricing page' }))
      .toHaveAttribute('href', '/pricing')
    expect(screen.queryByText(/₹|\$/)).not.toBeInTheDocument()
  })

  it('does not expose catalog prices before customer billing is ready', () => {
    render(
      <HomepagePricingPreview
        initialCatalog={{
          ...catalog,
          customerBillingUiReady: false,
        }}
        onStartFree={vi.fn()}
      />,
    )

    expect(screen.getByRole('alert')).toHaveTextContent(
      'Current pricing is temporarily unavailable here.',
    )
    expect(screen.queryByText(/₹|\$/)).not.toBeInTheDocument()
  })
})
