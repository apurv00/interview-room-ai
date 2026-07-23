import type { Metadata } from 'next'

export const metadata: Metadata = {
  title: 'Application tracker',
  alternates: {
    canonical: '/jobs/tracker',
  },
  robots: {
    index: false,
    follow: false,
    googleBot: {
      index: false,
      follow: false,
    },
  },
}

export default function JobsTrackerLayout({ children }: { children: React.ReactNode }) {
  return <>{children}</>
}
