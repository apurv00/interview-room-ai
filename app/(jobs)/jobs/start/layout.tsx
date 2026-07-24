import type { Metadata } from 'next'
import { Suspense } from 'react'

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
  return (
    <Suspense fallback={(
      <main className="mx-auto max-w-xl px-4 py-10">
        <p className="text-sm text-slate-500">Loading personalization…</p>
      </main>
    )}>
      {children}
    </Suspense>
  )
}
