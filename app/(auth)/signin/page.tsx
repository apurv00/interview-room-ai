'use client'

import { useState, Suspense } from 'react'
import { signIn, signOut, useSession } from 'next-auth/react'
import { useSearchParams } from 'next/navigation'
import Link from 'next/link'

function SignInContent() {
  const { data: session } = useSession()
  const searchParams = useSearchParams()
  const callbackUrl = searchParams.get('callbackUrl') || '/lobby'
  const error = searchParams.get('error')

  const [isLoading, setIsLoading] = useState(false)

  async function handleOAuthSignIn(provider: string) {
    setIsLoading(true)
    // Force clear session cookie before starting new OAuth flow.
    // Without this, the old JWT persists and the user ends up logged
    // in as the previous account after selecting a new Google account.
    try {
      // Clear NextAuth session (server-side cookie deletion)
      await signOut({ redirect: false })
      // Clear any cached session data client-side
      // Delete the session cookie directly as a safety net
      document.cookie = 'next-auth.session-token=; path=/; expires=Thu, 01 Jan 1970 00:00:00 GMT'
      document.cookie = '__Secure-next-auth.session-token=; path=/; expires=Thu, 01 Jan 1970 00:00:00 GMT; secure'
      document.cookie = `__Secure-next-auth.session-token=; path=/; expires=Thu, 01 Jan 1970 00:00:00 GMT; secure; domain=.interviewprep.guru`
    } catch { /* continue even if signout fails */ }
    await signIn(provider, { callbackUrl })
  }

  const errorMessage = error === 'OAuthAccountNotLinked'
    ? 'An account with this email already exists. Please sign in with the same provider you used originally, or try a different one.'
    : error === 'CredentialsSignin'
      ? 'Email/password login has been removed. Please sign in with Google or GitHub below.'
      : error || ''

  return (
    <main className="min-h-screen bg-[#ffffff] flex items-center justify-center px-4 sm:px-6">
      <div className="w-full max-w-[640px]">
        <div className="bg-white border border-[#e1e8ed] rounded-2xl p-7 sm:p-8">
          {/* Logo */}
          <div className="flex justify-center mb-section">
            <div className="w-8 h-8 rounded-[6px] bg-[#6366f1] flex items-center justify-center">
              <svg className="w-4.5 h-4.5 text-white" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2.5}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M15.536 8.464a5 5 0 010 7.072m2.828-9.9a9 9 0 010 12.728M5.586 15H4a1 1 0 01-1-1v-4a1 1 0 011-1h1.586l4.707-4.707C10.923 3.663 12 4.109 12 5v14c0 .891-1.077 1.337-1.707.707L5.586 15z" />
              </svg>
            </div>
          </div>

          <h1 className="text-heading text-[#0f1419] text-center">Sign in</h1>
          <p className="text-body text-[#71767b] text-center mt-1">
            Sign in to start your interview practice
          </p>

          {session && (
            <div className="mt-4 p-3 bg-[rgba(99,102,241,0.08)] border border-[rgba(99,102,241,0.15)] rounded-[10px] text-caption text-[#6366f1]" role="status">
              You are signed in as <strong>{session.user?.email}</strong>. Signing in again will switch your account.
            </div>
          )}

          {errorMessage && (
            <div className="mt-4 p-3 bg-[rgba(239,68,68,0.08)] border border-[rgba(239,68,68,0.15)] rounded-[10px] text-caption text-[#f87171]" role="alert">
              {errorMessage}
            </div>
          )}

          {/* OAuth */}
          <div className="space-y-element mt-section">
            <button
              onClick={() => handleOAuthSignIn('google')}
              disabled={isLoading}
              className="w-full flex items-center justify-center gap-3 h-11 px-4 bg-white text-gray-900 rounded-[10px] text-sm font-medium hover:bg-[#f7f9f9] transition-colors disabled:opacity-40 border border-[#e1e8ed]"
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
              className="w-full flex items-center justify-center gap-3 h-11 px-4 bg-white text-[#536471] rounded-[10px] text-sm font-medium hover:bg-[#f7f9f9] transition-colors disabled:opacity-40 border border-[#e1e8ed]"
            >
              <svg className="w-5 h-5" fill="currentColor" viewBox="0 0 24 24">
                <path d="M12 0c-6.626 0-12 5.373-12 12 0 5.302 3.438 9.8 8.207 11.387.599.111.793-.261.793-.577v-2.234c-3.338.726-4.033-1.416-4.033-1.416-.546-1.387-1.333-1.756-1.333-1.756-1.089-.745.083-.729.083-.729 1.205.084 1.839 1.237 1.839 1.237 1.07 1.834 2.807 1.304 3.492.997.107-.775.418-1.305.762-1.604-2.665-.305-5.467-1.334-5.467-5.931 0-1.311.469-2.381 1.236-3.221-.124-.303-.535-1.524.117-3.176 0 0 1.008-.322 3.301 1.23.957-.266 1.983-.399 3.003-.404 1.02.005 2.047.138 3.006.404 2.291-1.552 3.297-1.23 3.297-1.23.653 1.653.242 2.874.118 3.176.77.84 1.235 1.911 1.235 3.221 0 4.609-2.807 5.624-5.479 5.921.43.372.823 1.102.823 2.222v3.293c0 .319.192.694.801.576 4.765-1.589 8.199-6.086 8.199-11.386 0-6.627-5.373-12-12-12z" />
              </svg>
              Continue with GitHub
            </button>
          </div>

          {/* Migration notice for former email/password users */}
          <div className="mt-6 p-3 bg-[rgba(99,102,241,0.05)] border border-[rgba(99,102,241,0.12)] rounded-[10px] text-caption text-[#536471]">
            Previously used email and password? Just sign in with Google or GitHub using the same email address — your account will be linked automatically.
          </div>

          <p className="text-caption text-[#71767b] text-center mt-section">
            Don&apos;t have an account?{' '}
            <Link href="/signup" className="text-[#6366f1] hover:text-[#4f46e5] transition-colors">
              Sign up
            </Link>
          </p>
        </div>

        <p className="text-caption text-[#71767b] text-center mt-4">
          Practice mock interviews with AI feedback.{' '}
          <Link href="/" className="text-[#6366f1] hover:text-[#4f46e5] transition-colors">
            Learn more &rarr;
          </Link>
        </p>
      </div>
    </main>
  )
}

export default function SignInPage() {
  return (
    <Suspense
      fallback={
        <div className="min-h-screen bg-[#ffffff] flex items-center justify-center">
          <div className="text-[#71767b]">Loading...</div>
        </div>
      }
    >
      <SignInContent />
    </Suspense>
  )
}
