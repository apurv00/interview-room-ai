'use client'

/**
 * AuthGateProvider — global "deferred auth" gate.
 *
 * Anonymous users browse the app freely; only value-capture actions
 * (save resume, download PDF, start interview, etc.) trigger this modal.
 *
 * Usage:
 *   const { requireAuth } = useAuthGate()
 *   <button onClick={() => requireAuth('download_resume', handleDownload)}>
 *     Download
 *   </button>
 *
 * If the user is authenticated, `onAuthed` runs immediately.
 * Otherwise the modal opens and we **hold the callback in a ref**.
 * When NextAuth's session status flips to `authenticated` while the
 * modal is open (credentials sign-in in place), we invoke the callback
 * and close the modal — so users don't have to re-click the CTA.
 *
 * For OAuth flows that do a full page round-trip, the ref is lost
 * across the navigation; those users still land back on the same page
 * after sign-in. We accept that corner case until we have evidence it
 * materially hurts conversion.
 */

import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react'
import { useSession } from 'next-auth/react'
import AuthGateModal, { type AuthReason } from '@shared/ui/AuthGateModal'
import { track } from '@shared/analytics/track'

interface AuthGateContextValue {
  requireAuth: (reason: AuthReason, onAuthed?: () => void | Promise<void>) => void
  open: (reason: AuthReason) => void
  close: () => void
}

const AuthGateContext = createContext<AuthGateContextValue | null>(null)

export function AuthGateProvider({ children }: { children: React.ReactNode }) {
  const { status } = useSession()
  const [openReason, setOpenReason] = useState<AuthReason | null>(null)
  const pendingCallbackRef = useRef<(() => void | Promise<void>) | null>(null)

  const close = useCallback(() => {
    setOpenReason(null)
    pendingCallbackRef.current = null
  }, [])
  const open = useCallback((reason: AuthReason) => {
    setOpenReason(reason)
    track('auth_gate_opened', { reason })
  }, [])

  const requireAuth = useCallback(
    (reason: AuthReason, onAuthed?: () => void | Promise<void>) => {
      if (status === 'authenticated') {
        if (onAuthed) void onAuthed()
        return
      }
      // 'loading' — treat as not-yet-authed; open modal so user gets feedback
      pendingCallbackRef.current = onAuthed ?? null
      setOpenReason(reason)
      track('auth_gate_opened', { reason })
    },
    [status]
  )

  // When the user successfully signs in via the modal, NextAuth's session
  // status flips to 'authenticated'. Fire any pending callback and close.
  useEffect(() => {
    if (status !== 'authenticated') return
    if (!openReason && !pendingCallbackRef.current) return
    const cb = pendingCallbackRef.current
    pendingCallbackRef.current = null
    setOpenReason(null)
    if (cb) {
      track('auth_completed', { had_pending_action: true })
      void cb()
    } else {
      track('auth_completed', { had_pending_action: false })
    }
  }, [status, openReason])

  const value = useMemo(() => ({ requireAuth, open, close }), [requireAuth, open, close])

  return (
    <AuthGateContext.Provider value={value}>
      {children}
      <AuthGateModal reason={openReason} onClose={close} />
    </AuthGateContext.Provider>
  )
}

export function useAuthGate(): AuthGateContextValue {
  const ctx = useContext(AuthGateContext)
  if (!ctx) {
    throw new Error('useAuthGate must be used inside <AuthGateProvider>')
  }
  return ctx
}
