import { notFound } from 'next/navigation'
import type { Metadata } from 'next'
import PillarPage from '@learn/components/PillarPage'
import { getPillarBySlug } from '@learn/lib/pillars'
import { siteConfig } from '@shared/siteConfig'

const PILLAR_SLUG = 'interview-types'

export function generateMetadata(): Metadata {
  const pillar = getPillarBySlug(PILLAR_SLUG)
  if (!pillar) return {}

  const url = `${siteConfig.url}/learn/guides/${PILLAR_SLUG}`
  return {
    title: pillar.metaTitle,
    description: pillar.metaDescription,
    keywords: pillar.keywords,
    alternates: { canonical: url },
    openGraph: {
      title: pillar.metaTitle,
      description: pillar.metaDescription,
      url,
      type: 'website',
      siteName: siteConfig.name,
    },
    twitter: { card: 'summary', title: pillar.metaTitle, description: pillar.metaDescription },
  }
}

export default function InterviewTypesHub() {
  const pillar = getPillarBySlug(PILLAR_SLUG)
  if (!pillar) return notFound()
  return <PillarPage pillar={pillar} />
}
