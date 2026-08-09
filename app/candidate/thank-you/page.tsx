'use client'

/**
 * Post-interview landing for IPG Hire guests (middleware diverts them here
 * from /feedback/:sessionId — candidates never see scores; results belong
 * to the hiring team's portal).
 *
 * Report generation is NOT triggered here: the engine already fires the
 * full /api/generate-feedback request fire-and-forget at completion
 * (useInterview), and a sessionId-only call would fail schema validation
 * anyway (Codex P1 on #607). If that engine request is ever lost, the HR
 * card shows the honest "report pending" state with per-answer scores.
 *
 * The ONLY job here is ending the synthetic guest session immediately —
 * before the candidate can close the tab — and only for synthetic guests:
 * a real signed-in user who opens this public URL directly is never
 * logged out (Codex P2 on #607).
 *
 * SCOPED to one round via ?round=<id> (appended by the middleware redirect
 * that sends guests here): with 2+ invites in one browser, a stale
 * thank-you tab from an OLDER round — reloaded by tab discard or revisit —
 * must never end a NEWER round's live session (founder-hit bug,
 * 2026-08-09). Without the param (direct visit) the pre-scoping behavior
 * is kept: any synthetic guest is signed out.
 */

import { useEffect, useRef, useState } from 'react'
import { signOut, useSession } from 'next-auth/react'
import { isHireGuestEmail, isGuestEmailForRound } from '@shared/auth/guestScope'

export default function CandidateThankYouPage() {
  const { data: session, status } = useSession()
  const firedRef = useRef(false)
  const [ready, setReady] = useState(false)

  useEffect(() => {
    if (firedRef.current || status === 'loading') return
    firedRef.current = true
    const email = session?.user?.email ?? ''
    // window.location (not useSearchParams) — client-only read, no Suspense
    // boundary needed, and the param survives tab-discard reloads.
    let roundParam: string | null = null
    try {
      roundParam = new URLSearchParams(window.location.search).get('round')
    } catch {
      roundParam = null
    }
    const isOwnGuestSession = roundParam
      ? isGuestEmailForRound(email, roundParam)
      : isHireGuestEmail(email)
    if (status === 'authenticated' && isOwnGuestSession) {
      void signOut({ redirect: false }).finally(() => setReady(true))
    } else {
      setReady(true)
    }
  }, [status, session?.user?.email])

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
