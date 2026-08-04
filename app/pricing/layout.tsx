import type { Metadata } from 'next'
import JsonLd from '@shared/seo/JsonLd'
import { siteConfig } from '@shared/siteConfig'
import { FAQ } from '@shared/pricingFaq'
import { CONSUMER_CATALOG_V1 } from '@shared/services/planConfig'

export const metadata: Metadata = {
  title: 'Pricing',
  description: `INR pricing for ${siteConfig.name}: Basic ₹0, Plus ₹599/month, Pro ₹999/month, ₹69 additional interviews, and ₹29 premium resume unlocks.`,
  alternates: { canonical: '/pricing' },
}

export default function PricingLayout({ children }: { children: React.ReactNode }) {
  const offers = [
    ...Object.values(CONSUMER_CATALOG_V1.plans).map((plan) => ({
      '@type': 'Offer',
      name: plan.displayName,
      priceCurrency: 'INR',
      price: plan.listPricePaise / 100,
      category: plan.billingPeriod === 'monthly'
        ? 'Monthly subscription'
        : 'Free plan',
    })),
    ...Object.values(CONSUMER_CATALOG_V1.oneTimeProducts).map((product) => ({
      '@type': 'Offer',
      name: product.displayName,
      priceCurrency: 'INR',
      price: product.listPricePaise / 100,
      category: 'One-time digital service',
    })),
  ]

  return (
    <>
      <JsonLd
        data={{
          '@context': 'https://schema.org',
          '@graph': [
            {
              '@type': 'Service',
              name: `${siteConfig.name} interview preparation plans`,
              areaServed: 'IN',
              hasOfferCatalog: {
                '@type': 'OfferCatalog',
                name: 'Consumer plans and one-time products',
                itemListElement: offers,
              },
            },
            {
              '@type': 'FAQPage',
              mainEntity: FAQ.map(({ q, a }) => ({
                '@type': 'Question',
                name: q,
                acceptedAnswer: {
                  '@type': 'Answer',
                  text: a,
                },
              })),
            },
          ],
        }}
      />
      {children}
    </>
  )
}
