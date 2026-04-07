'use client'

import { Suspense } from 'react'
import { useSearchParams } from 'next/navigation'
import Link from 'next/link'
import SignInForm from '@shared/ui/SignInForm'

function SignInContent() {
  const searchParams = useSearchParams()
  const callbackUrl = searchParams.get('callbackUrl') || '/'
  const error = searchParams.get('error')

  return (
    <main className="min-h-screen bg-[#ffffff] flex items-center justify-center px-4 sm:px-6">
      <div className="w-full max-w-[640px]">
        <div className="bg-white border border-[#e1e8ed] rounded-2xl p-7 sm:p-8">
          {/* Logo */}
          <div className="flex justify-center mb-6">
            <div className="w-8 h-8 rounded-[6px] bg-[#2563eb] flex items-center justify-center">
              <svg className="w-4.5 h-4.5 text-white" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2.5}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M15.536 8.464a5 5 0 010 7.072m2.828-9.9a9 9 0 010 12.728M5.586 15H4a1 1 0 01-1-1v-4a1 1 0 011-1h1.586l4.707-4.707C10.923 3.663 12 4.109 12 5v14c0 .891-1.077 1.337-1.707.707L5.586 15z" />
              </svg>
            </div>
          </div>

          <SignInForm
            callbackUrl={callbackUrl}
            errorCode={error}
            headline="Sign in"
            subcopy="Sign in to start your interview practice"
          />

          {/* Migration notice for former email/password users */}
          <div className="mt-6 p-3 bg-[rgba(37,99,235,0.05)] border border-[rgba(37,99,235,0.12)] rounded-[10px] text-xs text-[#536471]">
            Previously used email and password? Just sign in with Google or GitHub using the same email address — your account will be linked automatically.
          </div>

          <p className="text-xs text-[#71767b] text-center mt-6">
            Don&apos;t have an account?{' '}
            <Link href="/signup" className="text-[#2563eb] hover:text-[#1d4ed8] transition-colors">
              Sign up
            </Link>
          </p>
        </div>

        <p className="text-xs text-[#71767b] text-center mt-4">
          Practice mock interviews with AI feedback.{' '}
          <Link href="/" className="text-[#2563eb] hover:text-[#1d4ed8] transition-colors">
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
