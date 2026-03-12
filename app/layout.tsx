import type { Metadata, Viewport } from 'next'
import SessionProvider from '@/providers/SessionProvider'
import { ThemeProvider } from '@/providers/ThemeProvider'
import AppShell from '@/components/layout/AppShell'
import JsonLd from '@/components/seo/JsonLd'
import { siteConfig } from '@/lib/siteConfig'
import './globals.css'

// Inline script to prevent FOUC — runs before React hydrates
const themeScript = `(function(){var t=localStorage.getItem('theme');var d=document.documentElement;if(t==='light')d.classList.add('light');else if(t==='dark')d.classList.remove('light');else if(window.matchMedia('(prefers-color-scheme:light)').matches)d.classList.add('light');})()`

export const viewport: Viewport = {
  width: 'device-width',
  initialScale: 1,
  themeColor: '#070b14',
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
  return (
    <html lang="en" suppressHydrationWarning>
      <head>
        <script dangerouslySetInnerHTML={{ __html: themeScript }} />
      </head>
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
        <SessionProvider>
          <ThemeProvider>
            <AppShell>{children}</AppShell>
          </ThemeProvider>
        </SessionProvider>
      </body>
    </html>
  )
}
