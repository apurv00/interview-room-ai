'use client'

/**
 * Post-sign-in handoff into the interview engine — the hire side of the
 * session-provisioning seam, using only the engine's public client contract:
 * write STORAGE_KEYS.INTERVIEW_CONFIG (with _ownerId, plus the user-scoped
 * copy) exactly as the engine's own InterviewSetupForm does, clear stale
 * engine state, and enter /lobby. The engine then runs its untouched flow —
 * device checks → interview room → its own session creation.
 *
 * The server's POST /prepare stamps preparedAt on the round, opening the
 * window roundLinkService later matches the engine session against.
 */

import { useCallback, useEffect, useRef, useState } from 'react'
import { useRouter } from 'next/navigation'
import { useSession } from 'next-auth/react'
import { STORAGE_KEYS } from '@shared/storageKeys'

type State = 'loading' | 'error' | 'unauthenticated'

export default function CandidatePreparePage({
  params,
}: {
  params: { roundId: string }
}) {
  const router = useRouter()
  const { data: session, status } = useSession()
  const [state, setState] = useState<State>('loading')
  const [errorMsg, setErrorMsg] = useState<string>('')
  const startedRef = useRef(false)

  const prepare = useCallback(async () => {
    if (!session?.user?.id) return
    setState('loading')
    try {
      const res = await fetch(`/api/candidate/${params.roundId}/prepare`, {
        method: 'POST',
      })
      const data = (await res.json().catch(() => ({}))) as {
        config?: Record<string, unknown>
        error?: string
      }
      if (!res.ok || !data.config) {
        setErrorMsg(data.error || 'Could not prepare your interview.')
        setState('error')
        return
      }

      // _hireRoundId marks this as a hire-guest config: if the guest's
      // session later dies (e.g. an older round's tab signed the browser
      // out), the lobby says "reopen your email link" instead of offering
      // a PERSONAL Google/GitHub sign-in mid-round (2026-08-09).
      const persistable = {
        ...data.config,
        _ownerId: session.user.id,
        _hireRoundId: params.roundId,
      }
      localStorage.setItem(STORAGE_KEYS.INTERVIEW_CONFIG, JSON.stringify(persistable))
      localStorage.setItem(
        `${STORAGE_KEYS.INTERVIEW_CONFIG}:${session.user.id}`,
        JSON.stringify(persistable)
      )
      // Clear engine state a previous (or another user's) visit may have
      // left behind — the room treats a lingering active-session marker or
      // pending retake as its own flow's state.
      localStorage.removeItem(STORAGE_KEYS.INTERVIEW_ACTIVE_SESSION)
      localStorage.removeItem(STORAGE_KEYS.PENDING_RETAKE_PARENT)
      localStorage.removeItem(STORAGE_KEYS.INTERVIEW_DATA)

      router.push('/lobby')
    } catch {
      setErrorMsg('Could not prepare your interview. Check your connection.')
      setState('error')
    }
  }, [params.roundId, router, session?.user?.id])

  useEffect(() => {
    if (status === 'loading') return
    if (status === 'unauthenticated') {
      setState('unauthenticated')
      return
    }
    if (startedRef.current) return
    startedRef.current = true
    void prepare()
  }, [status, prepare])

  return (
    <main className="min-h-screen flex items-center justify-center bg-[#f8fafc] px-4">
      <div className="max-w-md w-full bg-white border border-[#e1e8ed] rounded-2xl p-8 text-center space-y-4">
        {state === 'loading' && (
          <>
            <div className="mx-auto w-6 h-6 rounded-full border-2 border-[#2563eb] border-t-transparent animate-spin" />
            <p className="text-sm text-[#536471]">Setting up your interview…</p>
          </>
        )}
        {state === 'unauthenticated' && (
          <>
            <div className="text-3xl">🔐</div>
            <p className="text-sm text-[#536471]">
              Your sign-in expired. Please reopen the interview link from your email
              to start again.
            </p>
          </>
        )}
        {state === 'error' && (
          <>
            <div className="text-3xl">⚠️</div>
            <p className="text-sm text-[#536471]">{errorMsg}</p>
            <button
              onClick={() => {
                startedRef.current = false
                void prepare()
              }}
              className="px-4 py-2 rounded-xl bg-[#2563eb] text-white text-sm font-semibold hover:bg-blue-500 transition-colors"
            >
              Try again
            </button>
          </>
        )}
      </div>
    </main>
  )
}
