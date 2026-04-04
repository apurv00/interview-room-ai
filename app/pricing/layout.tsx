import type { Metadata } from 'next'
import JsonLd from '@shared/seo/JsonLd'
import { siteConfig } from '@shared/siteConfig'
import { FAQ } from '@shared/pricingFaq'

export const metadata: Metadata = {
  title: 'Pricing',
  description: `Simple, transparent pricing for ${siteConfig.name}. Start free with unlimited interviews during development.`,
  alternates: { canonical: '/pricing' },
}

export default function PricingLayout({ children }: { children: React.ReactNode }) {
  return (
    <>
      <JsonLd
        data={{
          '@context': 'https://schema.org',
          '@type': 'FAQPage',
          mainEntity: FAQ.map(({ q, a }) => ({
            '@type': 'Question',
            name: q,
            acceptedAnswer: { '@type': 'Answer', text: a },
          })),
        }}
      />
      {children}
    </>
  )
}
