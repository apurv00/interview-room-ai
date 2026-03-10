import type { Metadata } from 'next'
import JsonLd from '@/components/seo/JsonLd'
import { siteConfig } from '@/lib/siteConfig'
import { FAQ } from '@/lib/pricingFaq'

export const metadata: Metadata = {
  title: 'Pricing',
  description: `Simple, transparent pricing for ${siteConfig.name}. Start free with 3 interviews per month, upgrade to Pro for 30.`,
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
