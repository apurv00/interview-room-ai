import type { MetadataRoute } from 'next'
import { siteConfig } from '@shared/siteConfig'

export default function robots(): MetadataRoute.Robots {
  return {
    rules: [
      {
        userAgent: '*',
        allow: '/',
        disallow: ['/api/', '/interview', '/lobby', '/feedback/', '/history', '/progress', '/settings'],
      },
    ],
    sitemap: `${siteConfig.url}/sitemap.xml`,
  }
}
