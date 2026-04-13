'use client'

import { useState } from 'react'
import { signIn, signOut, useSession } from 'next-auth/react'
import { clearAllInterviewStorage } from '@shared/storageKeys'

interface Props {
  /** URL to return to after OAuth completes. Defaults to current page. */
  callbackUrl?: string
  /** Optional headline shown above OAuth buttons. */
  headline?: string
  /** Optional subcopy shown under headline. */
  subcopy?: string
  /** Optional error to display (e.g. from URL search params on /signin page). */
  errorCode?: string | null
}

/**
 * Shared OAuth sign-in form. Used by both the /signin page and the
 * <AuthGateModal>. Email/password is intentionally omitted — this app
 * is OAuth-only (Google + GitHub).
 */
export default function SignInForm({ callbackUrl, headline, subcopy, errorCode }: Props) {
  const { data: session } = useSession()
  const [isLoading, setIsLoading] = useState(false)

  async function handleOAuthSignIn(provider: 'google' | 'github') {
    setIsLoading(true)
    const target = callbackUrl ?? (typeof window !== 'undefined' ? window.location.href : '/')
    // Clear localStorage + server session before starting a new OAuth flow.
    // Note: document.cookie cannot clear httpOnly cookies — signOut() handles
    // that server-side via Set-Cookie.
    clearAllInterviewStorage()
    try {
      await signOut({ redirect: false })
    } catch { /* continue even if signout fails */ }
    await signIn(provider, { callbackUrl: target })
  }

  const errorMessage = errorCode === 'OAuthAccountNotLinked'
    ? 'An account with this email already exists. Please sign in with the same provider you used originally, or try a different one.'
    : errorCode === 'CredentialsSignin'
      ? 'Email/password login has been removed. Please sign in with Google or GitHub below.'
      : errorCode || ''

  return (
    <div>
      {headline && (
        <h2 className="text-xl font-semibold text-[#0f1419] text-center">{headline}</h2>
      )}
      {subcopy && (
        <p className="text-sm text-[#71767b] text-center mt-1">{subcopy}</p>
      )}

      {session && (
        <div className="mt-4 p-3 bg-[rgba(37,99,235,0.08)] border border-[rgba(37,99,235,0.15)] rounded-[10px] text-xs text-[#2563eb]" role="status">
          You are signed in as <strong>{session.user?.email}</strong>. Signing in again will switch your account.
        </div>
      )}

      {errorMessage && (
        <div className="mt-4 p-3 bg-[rgba(239,68,68,0.08)] border border-[rgba(239,68,68,0.15)] rounded-[10px] text-xs text-[#f87171]" role="alert">
          {errorMessage}
        </div>
      )}

      <div className="space-y-3 mt-5">
        <button
          onClick={() => handleOAuthSignIn('google')}
          disabled={isLoading}
          className="w-full flex items-center justify-center gap-3 h-11 px-4 bg-white text-gray-900 rounded-[10px] text-sm font-medium hover:bg-[#f8fafc] transition-colors disabled:opacity-40 border border-[#e1e8ed]"
        >
          <svg className="w-5 h-5" viewBox="0 0 24 24">
            <path d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92a5.06 5.06 0 0 1-2.2 3.32v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.1z" fill="#4285F4" />
            <path d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z" fill="#34A853" />
            <path d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.07H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.93l2.85-2.22.81-.62z" fill="#FBBC05" />
            <path d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.07l3.66 2.84c.87-2.6 3.3-4.53 6.16-4.53z" fill="#EA4335" />
          </svg>
          Continue with Google
        </button>

        <button
          onClick={() => handleOAuthSignIn('github')}
          disabled={isLoading}
          className="w-full flex items-center justify-center gap-3 h-11 px-4 bg-white text-[#536471] rounded-[10px] text-sm font-medium hover:bg-[#f8fafc] transition-colors disabled:opacity-40 border border-[#e1e8ed]"
        >
          <svg className="w-5 h-5" fill="currentColor" viewBox="0 0 24 24">
            <path d="M12 0c-6.626 0-12 5.373-12 12 0 5.302 3.438 9.8 8.207 11.387.599.111.793-.261.793-.577v-2.234c-3.338.726-4.033-1.416-4.033-1.416-.546-1.387-1.333-1.756-1.333-1.756-1.089-.745.083-.729.083-.729 1.205.084 1.839 1.237 1.839 1.237 1.07 1.834 2.807 1.304 3.492.997.107-.775.418-1.305.762-1.604-2.665-.305-5.467-1.334-5.467-5.931 0-1.311.469-2.381 1.236-3.221-.124-.303-.535-1.524.117-3.176 0 0 1.008-.322 3.301 1.23.957-.266 1.983-.399 3.003-.404 1.02.005 2.047.138 3.006.404 2.291-1.552 3.297-1.23 3.297-1.23.653 1.653.242 2.874.118 3.176.77.84 1.235 1.911 1.235 3.221 0 4.609-2.807 5.624-5.479 5.921.43.372.823 1.102.823 2.222v3.293c0 .319.192.694.801.576 4.765-1.589 8.199-6.086 8.199-11.386 0-6.627-5.373-12-12-12z" />
          </svg>
          Continue with GitHub
        </button>
      </div>

      <p className="mt-5 text-[11px] text-[#71767b] text-center">
        By continuing you agree to our{' '}
        <a href="/terms" className="text-[#2563eb] hover:underline">Terms</a> and{' '}
        <a href="/privacy" className="text-[#2563eb] hover:underline">Privacy Policy</a>.
      </p>
    </div>
  )
}
