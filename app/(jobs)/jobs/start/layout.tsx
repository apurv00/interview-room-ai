import type { Metadata } from 'next'

export const metadata: Metadata = {
  title: 'Personalize your job search',
  alternates: {
    canonical: '/jobs/start',
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

export default function JobsStartLayout({ children }: { children: React.ReactNode }) {
  return <>{children}</>
}
