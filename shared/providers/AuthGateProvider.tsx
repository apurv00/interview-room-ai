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
 * Otherwise the modal opens and `onAuthed` is discarded — the user
 * lands back on the same page after OAuth round-trip and clicks the
 * action again. (We deliberately do not persist callbacks across the
 * OAuth redirect — that would require serialization and is brittle.)
 */

import { createContext, useCallback, useContext, useState, useMemo } from 'react'
import { useSession } from 'next-auth/react'
import AuthGateModal, { type AuthReason } from '@shared/ui/AuthGateModal'

interface AuthGateContextValue {
  requireAuth: (reason: AuthReason, onAuthed?: () => void | Promise<void>) => void
  open: (reason: AuthReason) => void
  close: () => void
}

const AuthGateContext = createContext<AuthGateContextValue | null>(null)

export function AuthGateProvider({ children }: { children: React.ReactNode }) {
  const { status } = useSession()
  const [openReason, setOpenReason] = useState<AuthReason | null>(null)

  const close = useCallback(() => setOpenReason(null), [])
  const open = useCallback((reason: AuthReason) => setOpenReason(reason), [])

  const requireAuth = useCallback(
    (reason: AuthReason, onAuthed?: () => void | Promise<void>) => {
      if (status === 'authenticated') {
        if (onAuthed) void onAuthed()
        return
      }
      // 'loading' — treat as not-yet-authed; open modal so user gets feedback
      setOpenReason(reason)
    },
    [status]
  )

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
