import type { Metadata } from 'next'
import { siteConfig } from '@shared/siteConfig'

const description =
  'Browse live job postings, save roles, practice from the job description, and track the application status you record.'
const socialTitle = `Jobs | ${siteConfig.name}`

export const metadata: Metadata = {
  title: {
    default: 'Jobs',
    template: `%s | Jobs | ${siteConfig.name}`,
  },
  description,
  alternates: {
    canonical: '/jobs',
  },
  openGraph: {
    type: 'website',
    url: '/jobs',
    siteName: siteConfig.name,
    title: socialTitle,
    description,
  },
  twitter: {
    card: 'summary_large_image',
    title: socialTitle,
    description,
    creator: siteConfig.twitterHandle,
  },
  robots: {
    index: true,
    follow: true,
  },
}

export default function JobsLayout({ children }: { children: React.ReactNode }) {
  return <>{children}</>
}
