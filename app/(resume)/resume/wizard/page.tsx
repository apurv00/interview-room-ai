'use client'

import { useSearchParams } from 'next/navigation'
import { useSession } from 'next-auth/react'
import Link from 'next/link'
import WizardShell from '@resume/wizard/components/WizardShell'

export default function WizardPage() {
  const { status } = useSession()
  const searchParams = useSearchParams()
  const sessionId = searchParams.get('sessionId') || undefined

  if (status === 'loading') {
    return (
      <div className="flex items-center justify-center py-20">
        <div className="w-6 h-6 rounded-full border-2 border-[#2563eb] border-t-transparent animate-spin" />
      </div>
    )
  }

  if (status === 'unauthenticated') {
    return (
      <div className="max-w-md mx-auto py-20 text-center space-y-4">
        <h1 className="text-2xl font-bold text-[#0f1419]">Sign in to use the Smart Wizard</h1>
        <p className="text-sm text-[#71767b]">Create an account to build your resume step-by-step with AI guidance</p>
        <div className="flex items-center justify-center gap-3 pt-2">
          <Link href="/signup" className="px-5 py-2.5 bg-[#2563eb] hover:bg-[#1d4ed8] text-white rounded-xl text-sm font-medium transition-colors">
            Get Started Free
          </Link>
          <Link href="/signin" className="px-5 py-2.5 bg-[#f7f9f9] border border-[#e1e8ed] text-[#536471] rounded-xl text-sm font-medium transition-colors hover:bg-[#eff3f4]">
            Sign In
          </Link>
        </div>
      </div>
    )
  }

  return (
    <div className="py-4 px-2 sm:px-4">
      <WizardShell initialSessionId={sessionId} />
    </div>
  )
}
