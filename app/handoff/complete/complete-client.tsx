'use client'

import { useEffect, useRef } from 'react'
import { signOut } from 'next-auth/react'
import { clearAllInterviewStorage } from '@shared/storageKeys'

export default function HireRuntimeCompleteClient({
  controlUrl,
}: {
  controlUrl: string
}) {
  const signedOutRef = useRef(false)

  useEffect(() => {
    if (signedOutRef.current) return
    signedOutRef.current = true
    // Never redirect through NextAuth here. This host-only runtime identity is
    // discarded regardless of whether the candidate follows the control link.
    // Purge persisted transcript/config and pending replay blobs at the same
    // terminal boundary so a shared device cannot expose the prior candidate.
    void clearAllInterviewStorage().catch(() => undefined)
    void signOut({ redirect: false }).catch(() => undefined)
  }, [])

  return (
    <main className="flex min-h-screen items-center justify-center bg-slate-50 px-4">
      <section className="w-full max-w-md rounded-2xl border border-slate-200 bg-white p-8 text-center shadow-sm">
        <div
          aria-hidden="true"
          className="mx-auto mb-5 flex h-12 w-12 items-center justify-center rounded-full bg-emerald-50 text-2xl text-emerald-700"
        >
          ✓
        </div>
        <h1 className="text-xl font-semibold text-slate-950">
          Interview submitted
        </h1>
        <p className="mt-3 text-sm leading-6 text-slate-600">
          Your responses have been saved. You can safely close this tab.
        </p>
        <a
          href={controlUrl}
          rel="noreferrer"
          className="mt-6 inline-flex rounded-xl border border-slate-300 px-5 py-2.5 text-sm font-semibold text-slate-800 transition-colors hover:bg-slate-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-600 focus-visible:ring-offset-2"
        >
          Return to InterviewPrep Guru Hire
        </a>
      </section>
    </main>
  )
}
