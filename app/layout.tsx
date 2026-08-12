import type { Metadata, Viewport } from 'next'
import RootSurfaceComposition from './_components/RootSurfaceComposition'
import JsonLd from '@shared/seo/JsonLd'
import { siteConfig } from '@shared/siteConfig'
import { resolveDeploymentSurface } from '@shared/surfaces/hireSurfaceIsolation'
import './globals.css'

export const viewport: Viewport = {
  width: 'device-width',
  initialScale: 1,
  themeColor: '#ffffff',
}

export const metadata: Metadata = {
  metadataBase: new URL(siteConfig.url),
  title: {
    default: siteConfig.name,
    template: `%s | ${siteConfig.name}`,
  },
  description: siteConfig.shortDescription,
  keywords: [...siteConfig.keywords],
  authors: [{ name: siteConfig.name }],
  creator: siteConfig.name,

  openGraph: {
    type: 'website',
    locale: 'en_US',
    url: siteConfig.url,
    siteName: siteConfig.name,
    title: siteConfig.name,
    description: siteConfig.description,
  },

  twitter: {
    card: 'summary_large_image',
    title: siteConfig.name,
    description: siteConfig.shortDescription,
    creator: siteConfig.twitterHandle,
  },

  robots: {
    index: true,
    follow: true,
    googleBot: {
      index: true,
      follow: true,
      'max-video-preview': -1,
      'max-image-preview': 'large',
      'max-snippet': -1,
    },
  },

  alternates: {
    canonical: '/',
  },
}

export default function RootLayout({ children }: { children: React.ReactNode }) {
  const gaId = process.env.NEXT_PUBLIC_GA_MEASUREMENT_ID
  const enableSpeedInsights =
    process.env.VERCEL === '1' || process.env.NEXT_PUBLIC_ENABLE_SPEED_INSIGHTS === 'true'
  const deploymentSurface = resolveDeploymentSurface({
    configuredSurface: process.env.IPG_SURFACE,
  })

  return (
    <html lang="en" data-ipg-surface={deploymentSurface}>
      <body className="min-h-screen bg-page text-[var(--foreground)] antialiased">
        <JsonLd
          data={{
            '@context': 'https://schema.org',
            '@type': 'WebSite',
            name: siteConfig.name,
            url: siteConfig.url,
            description: siteConfig.description,
          }}
        />
        <JsonLd
          data={{
            '@context': 'https://schema.org',
            '@type': 'SoftwareApplication',
            name: siteConfig.name,
            applicationCategory: 'EducationalApplication',
            operatingSystem: 'Web',
            description: siteConfig.description,
            offers: {
              '@type': 'Offer',
              price: '0',
              priceCurrency: 'USD',
            },
          }}
        />
        <JsonLd
          data={{
            '@context': 'https://schema.org',
            '@type': 'Organization',
            name: siteConfig.name,
            url: siteConfig.url,
            logo: `${siteConfig.url}/icon`,
          }}
        />
        <RootSurfaceComposition
          deploymentSurface={deploymentSurface}
          gaId={gaId}
          enableSpeedInsights={enableSpeedInsights}
        >
          {children}
        </RootSurfaceComposition>
      </body>
    </html>
  )
}
