import type { MetadataRoute } from 'next'
import { siteConfig } from '@shared/siteConfig'
import { getAllSlugs } from '@/lib/resources'

export default function sitemap(): MetadataRoute.Sitemap {
  const resourceSlugs = getAllSlugs()

  return [
    { url: siteConfig.url, lastModified: new Date(), changeFrequency: 'weekly', priority: 1.0 },
    { url: `${siteConfig.url}/pricing`, lastModified: new Date(), changeFrequency: 'monthly', priority: 0.8 },
    { url: `${siteConfig.url}/resources`, lastModified: new Date(), changeFrequency: 'weekly', priority: 0.8 },
    ...resourceSlugs.map((slug) => ({
      url: `${siteConfig.url}/resources/${slug}`,
      lastModified: new Date(),
      changeFrequency: 'monthly' as const,
      priority: 0.7,
    })),
    { url: `${siteConfig.url}/signin`, lastModified: new Date(), changeFrequency: 'yearly', priority: 0.5 },
    { url: `${siteConfig.url}/signup`, lastModified: new Date(), changeFrequency: 'yearly', priority: 0.5 },
    { url: `${siteConfig.url}/privacy`, lastModified: new Date(), changeFrequency: 'yearly', priority: 0.3 },
    { url: `${siteConfig.url}/terms`, lastModified: new Date(), changeFrequency: 'yearly', priority: 0.3 },
  ]
}
