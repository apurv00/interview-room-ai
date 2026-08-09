'use client'

/**
 * Post-interview landing for IPG Hire guests (middleware diverts them here
 * from /feedback/:sessionId — candidates never see scores; results belong
 * to the hiring team's portal).
 *
 * Two jobs, in order:
 *   1. Fire report generation for the hiring team (POST /api/generate-feedback
 *      — normally triggered by the B2C feedback page the guest never
 *      reaches). Requires the guest's still-live session, so it runs BEFORE
 *      sign-out; failures are tolerated (the HR card shows honest per-answer
 *      results + "report pending", and reconciliation retries the snapshot).
 *   2. Sign the synthetic guest out — the candidate leaves logged out, with
 *      a close-this-tab message and an explore link.
 */

import { useEffect, useRef, useState } from 'react'
import { useSearchParams } from 'next/navigation'
import { Suspense } from 'react'
import { signOut } from 'next-auth/react'

function ThankYouInner() {
  const searchParams = useSearchParams()
  const startedRef = useRef(false)
  const [ready, setReady] = useState(false)

  useEffect(() => {
    if (startedRef.current) return
    startedRef.current = true
    const sessionId = searchParams?.get('session') ?? ''

    async function finish() {
      // Kick the hiring team's report while the guest session still exists.
      if (/^[a-f0-9]{24}$/i.test(sessionId)) {
        try {
          const controller = new AbortController()
          const timer = setTimeout(() => controller.abort(), 10_000)
          await fetch('/api/generate-feedback', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ sessionId }),
            signal: controller.signal,
            keepalive: true,
          })
          clearTimeout(timer)
        } catch {
          // Tolerated — reconciliation surfaces "report pending" honestly.
        }
      }
      try {
        await signOut({ redirect: false })
      } catch {
        // Even if sign-out fails, show the terminal screen; the cookie
        // expires on its own and the guest identity is synthetic.
      }
      setReady(true)
    }
    void finish()
  }, [searchParams])

  return (
    <main className="min-h-screen flex items-center justify-center bg-[#f8fafc] px-4">
      <div className="max-w-md w-full bg-white border border-[#e1e8ed] rounded-2xl p-8 text-center space-y-4">
        <div className="text-4xl">🎉</div>
        <h1 className="text-xl font-bold text-[#0f1419]">Thank you!</h1>
        <p className="text-sm text-[#536471] leading-relaxed">
          Your interview has been submitted to the hiring team. They&apos;ll review it
          and get back to you about next steps.
        </p>
        <p className="text-sm text-[#536471]">You can safely close this tab.</p>
        {!ready ? (
          <div className="mx-auto w-5 h-5 rounded-full border-2 border-[#2563eb] border-t-transparent animate-spin" />
        ) : (
          <a
            href="/"
            className="inline-block px-5 py-2.5 rounded-xl bg-[#2563eb] text-white text-sm font-semibold hover:bg-blue-500 transition-colors"
          >
            Explore InterviewPrep.guru
          </a>
        )}
      </div>
    </main>
  )
}

export default function CandidateThankYouPage() {
  return (
    <Suspense fallback={null}>
      <ThankYouInner />
    </Suspense>
  )
}
