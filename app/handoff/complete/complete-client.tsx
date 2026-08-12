'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import { signOut } from 'next-auth/react'
import { clearAllInterviewStorage } from '@shared/storageKeys'

type CompletionView = 'checking' | 'submitted' | 'unconfirmed' | 'cleanup_failed'
const COMPLETION_CHECK_TIMEOUT_MS = 10_000

export default function HireRuntimeCompleteClient({
  controlUrl,
}: {
  controlUrl: string
}) {
  const finalizedRef = useRef(false)
  const inFlightRef = useRef(false)
  const mountedRef = useRef(true)
  const [view, setView] = useState<CompletionView>('checking')

  const confirmCompletion = useCallback(async () => {
    if (finalizedRef.current || inFlightRef.current) return
    inFlightRef.current = true
    setView('checking')
    const controller = new AbortController()
    const timeout = window.setTimeout(
      () => controller.abort(),
      COMPLETION_CHECK_TIMEOUT_MS,
    )
    let completionConfirmed = false
    try {
      const response = await fetch('/api/hire-engine/completion-status', {
        method: 'GET',
        headers: { Accept: 'application/json' },
        cache: 'no-store',
        credentials: 'same-origin',
        signal: controller.signal,
      })
      const payload = response.ok
        ? await response.json() as { state?: unknown }
        : null
      if (payload?.state !== 'completed') {
        if (mountedRef.current) setView('unconfirmed')
        return
      }

      completionConfirmed = true
      // The exact runtime-bound session is durable. It is now safe to purge
      // local transcript/config/replay state and end the host-only identity.
      await clearAllInterviewStorage()
      await signOut({ redirect: false })
      finalizedRef.current = true
      if (mountedRef.current) setView('submitted')
    } catch {
      if (mountedRef.current) {
        setView(completionConfirmed ? 'cleanup_failed' : 'unconfirmed')
      }
    } finally {
      window.clearTimeout(timeout)
      inFlightRef.current = false
    }
  }, [])

  useEffect(() => {
    mountedRef.current = true
    void confirmCompletion()
    return () => {
      mountedRef.current = false
    }
  }, [confirmCompletion])

  return (
    <main className="flex min-h-screen items-center justify-center bg-slate-50 px-4">
      <section className="w-full max-w-md rounded-2xl border border-slate-200 bg-white p-8 text-center shadow-sm">
        {view === 'checking' && (
          <div role="status" aria-live="polite">
            <div
              aria-hidden="true"
              className="mx-auto mb-5 h-8 w-8 animate-spin rounded-full border-2 border-blue-600 border-t-transparent"
            />
            <h1 className="text-xl font-semibold text-slate-950">
              Confirming your submission
            </h1>
            <p className="mt-3 text-sm leading-6 text-slate-600">
              Keep this tab open while we verify that your responses were saved.
            </p>
          </div>
        )}

        {view === 'unconfirmed' && (
          <div role="alert">
            <div
              aria-hidden="true"
              className="mx-auto mb-5 flex h-12 w-12 items-center justify-center rounded-full bg-amber-50 text-2xl text-amber-700"
            >
              !
            </div>
            <h1 className="text-xl font-semibold text-slate-950">
              Submission not confirmed
            </h1>
            <p className="mt-3 text-sm leading-6 text-slate-600">
              We could not confirm a durable save. We have kept the interview
              data in this tab. Keep it open and check again. If this persists,
              contact the hiring team before closing the tab.
            </p>
            <button
              type="button"
              onClick={() => void confirmCompletion()}
              className="mt-6 inline-flex rounded-xl bg-blue-600 px-5 py-2.5 text-sm font-semibold text-white transition-colors hover:bg-blue-700 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-600 focus-visible:ring-offset-2"
            >
              Check again
            </button>
          </div>
        )}

        {view === 'cleanup_failed' && (
          <div role="alert">
            <div
              aria-hidden="true"
              className="mx-auto mb-5 flex h-12 w-12 items-center justify-center rounded-full bg-amber-50 text-2xl text-amber-700"
            >
              !
            </div>
            <h1 className="text-xl font-semibold text-slate-950">
              Interview saved — secure cleanup pending
            </h1>
            <p className="mt-3 text-sm leading-6 text-slate-600">
              Your responses are durable, but we could not finish clearing this
              tab and signing out. Keep it open and finish the secure cleanup.
            </p>
            <button
              type="button"
              onClick={() => void confirmCompletion()}
              className="mt-6 inline-flex rounded-xl bg-blue-600 px-5 py-2.5 text-sm font-semibold text-white transition-colors hover:bg-blue-700 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-600 focus-visible:ring-offset-2"
            >
              Finish secure cleanup
            </button>
          </div>
        )}

        {view === 'submitted' && (
          <div aria-live="polite">
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
          </div>
        )}
      </section>
    </main>
  )
}
