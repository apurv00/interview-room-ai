'use client'

import { useAuthGate } from '@shared/providers/AuthGateProvider'

/**
 * Sticky banner shown above the resume editor when the user is not
 * signed in. Their work is held in localStorage only and will be lost
 * if they clear the browser. Clicking the CTA opens the auth modal
 * with the `save_resume` reason.
 */
export default function AnonymousDraftBanner() {
  const { open } = useAuthGate()

  return (
    <div className="rounded-xl border border-amber-200 bg-amber-50 px-4 py-3 flex items-center justify-between gap-3">
      <div className="flex items-start gap-2.5">
        <svg className="w-4 h-4 text-amber-600 mt-0.5 shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
          <path strokeLinecap="round" strokeLinejoin="round" d="M12 9v2m0 4h.01M5 19h14a2 2 0 001.84-2.75L13.74 4a2 2 0 00-3.48 0l-7.1 12.25A2 2 0 005 19z" />
        </svg>
        <p className="text-xs text-amber-900 leading-relaxed">
          Your work is saved in this browser only. <strong>Sign in to save to the cloud</strong> and access it anywhere.
        </p>
      </div>
      <button
        type="button"
        onClick={() => open('save_resume')}
        className="shrink-0 px-3 py-1.5 rounded-lg bg-amber-600 hover:bg-amber-700 text-white text-xs font-semibold transition-colors"
      >
        Sign in
      </button>
    </div>
  )
}
