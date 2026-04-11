import type { MetadataRoute } from 'next'
import { siteConfig } from '@shared/siteConfig'

export default function robots(): MetadataRoute.Robots {
  return {
    rules: [
      {
        userAgent: '*',
        allow: '/',
        // Disallow per-user or authenticated surfaces. `/progress` is the
        // legacy route — the live authenticated pages are `/learn/progress`
        // and `/learn/pathway`. `/resume/builder` and `/resume/wizard` are
        // disallowed because they load per-user draft data even though the
        // routes themselves are publicly reachable.
        disallow: [
          '/api/',
          '/interview',
          '/lobby',
          '/feedback/',
          '/history',
          '/dashboard',
          '/learn/progress',
          '/learn/pathway',
          '/learn/badges',
          '/learn/challenge',
          '/learn/saved',
          '/resume/builder',
          '/resume/wizard',
          '/settings',
          '/onboarding',
        ],
      },
    ],
    sitemap: `${siteConfig.url}/sitemap.xml`,
  }
}
