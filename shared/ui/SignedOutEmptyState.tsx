'use client'

import Link from 'next/link'
import { useAuthGate } from '@shared/providers/AuthGateProvider'
import type { AuthReason } from '@shared/ui/AuthGateModal'

interface Props {
  reason: AuthReason
  headline: string
  description?: string
  /** Where the primary CTA should send anonymous users. Defaults to /interview/setup. */
  primaryHref?: string
  primaryLabel?: string
}

/**
 * Inline empty-state used on user-data pages (history, dashboard, progress)
 * when an anonymous user lands there. Shows a friendly CTA + Sign-in link
 * instead of a redirect or auto-popping modal.
 */
export default function SignedOutEmptyState({
  reason,
  headline,
  description = 'Run your first interview to start tracking your progress here.',
  primaryHref = '/interview/setup',
  primaryLabel = 'Start your first interview',
}: Props) {
  const { open } = useAuthGate()

  return (
    <div className="max-w-md mx-auto text-center py-16 px-4">
      <div className="mx-auto w-14 h-14 rounded-2xl bg-blue-50 flex items-center justify-center mb-5">
        <svg className="w-6 h-6 text-[#2563eb]" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
          <path strokeLinecap="round" strokeLinejoin="round" d="M9 19v-6a2 2 0 00-2-2H5a2 2 0 00-2 2v6a2 2 0 002 2h2a2 2 0 002-2zm0 0V9a2 2 0 012-2h2a2 2 0 012 2v10m-6 0a2 2 0 002 2h2a2 2 0 002-2m0 0V5a2 2 0 012-2h2a2 2 0 012 2v14a2 2 0 01-2 2h-2a2 2 0 01-2-2z" />
        </svg>
      </div>
      <h2 className="text-xl font-semibold text-[#0f1419]">{headline}</h2>
      <p className="text-sm text-[#71767b] mt-2">{description}</p>

      <div className="mt-6 flex flex-col sm:flex-row items-center justify-center gap-3">
        <Link
          href={primaryHref}
          className="inline-flex items-center justify-center px-5 py-2.5 rounded-full bg-[#2563eb] text-white text-sm font-semibold hover:bg-[#1d4ed8] transition-colors"
        >
          {primaryLabel}
        </Link>
        <button
          type="button"
          onClick={() => open(reason)}
          className="inline-flex items-center justify-center px-5 py-2.5 rounded-full border border-[#e1e8ed] text-[#0f1419] text-sm font-semibold hover:bg-slate-50 transition-colors"
        >
          Sign in
        </button>
      </div>
    </div>
  )
}
