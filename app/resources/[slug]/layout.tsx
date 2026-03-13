import type { Metadata } from 'next'
import { notFound } from 'next/navigation'
import { getResourceBySlug, getAllSlugs } from '@/lib/resources'
import { siteConfig } from '@shared/siteConfig'

interface Props {
  params: { slug: string }
}

export function generateStaticParams() {
  return getAllSlugs().map(slug => ({ slug }))
}

export function generateMetadata({ params }: Props): Metadata {
  const resource = getResourceBySlug(params.slug)
  if (!resource) return notFound()

  const url = `${siteConfig.url}/resources/${resource.slug}`

  return {
    title: resource.title,
    description: resource.description,
    keywords: resource.keywords,
    alternates: { canonical: url },
    openGraph: {
      title: `${resource.title} | ${siteConfig.name}`,
      description: resource.description,
      url,
      type: 'article',
      siteName: siteConfig.name,
    },
    twitter: {
      card: 'summary',
      title: resource.title,
      description: resource.description,
    },
  }
}

export default function ResourceLayout({ children }: { children: React.ReactNode }) {
  return <>{children}</>
}
