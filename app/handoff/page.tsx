import type { Metadata } from 'next'
import { Suspense } from 'react'
import HireRuntimeHandoffClient from './handoff-client'

export const dynamic = 'force-dynamic'

export const metadata: Metadata = {
  title: 'Preparing your interview | InterviewPrep Guru',
  robots: { index: false, follow: false },
  referrer: 'no-referrer',
}

function HandoffFallback() {
  return (
    <main className="flex min-h-screen items-center justify-center bg-slate-50 px-4">
      <p className="text-sm text-slate-600">Preparing your interview…</p>
    </main>
  )
}

export default function HireRuntimeHandoffPage() {
  return (
    <Suspense fallback={<HandoffFallback />}>
      <HireRuntimeHandoffClient />
    </Suspense>
  )
}
