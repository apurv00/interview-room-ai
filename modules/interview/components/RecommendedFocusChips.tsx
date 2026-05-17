'use client'

import { Target } from 'lucide-react'

/**
 * RecommendedFocusChips — visible confirmation of the focus competencies
 * that a Pathway action seeded into the URL.
 *
 * Pathway P2 Wave 1 (feature #4): when a user clicks an action on the
 * Pathway page, the resulting URL carries `?focus=communication,clarity`
 * etc. — but until now those competencies were forwarded silently into
 * the downstream config and never shown to the user. That broke the
 * action-anchored coaching promise: the user couldn't tell what the
 * pathway thought this interview was for.
 *
 * This component renders the focus list as a chip row at the top of
 * the setup form so the user sees "we're tuning this interview to
 * sharpen your clarity and structure" before they pick a domain.
 *
 * Purely presentational — no state, no fetching. Data flows in from
 * `pathwayContext.focus[]`.
 */
export default function RecommendedFocusChips({
  focus,
}: {
  focus: string[]
}) {
  if (!focus || focus.length === 0) return null

  return (
    <section
      data-testid="recommended-focus-chips"
      aria-label="Focus competencies recommended by your pathway"
      className="mb-6 rounded-2xl border border-blue-200/70 bg-gradient-to-br from-blue-50 to-white px-5 py-4"
    >
      <div className="flex items-center gap-2 mb-2">
        <Target className="w-4 h-4 text-blue-600" aria-hidden="true" />
        <h2 className="text-[11px] font-semibold text-blue-700 uppercase tracking-[0.12em]">
          Recommended focus
        </h2>
      </div>
      <p className="text-sm text-slate-700 mb-3">
        We&apos;ll tune this interview around the {focus.length === 1 ? 'area' : 'areas'} your pathway flagged for you:
      </p>
      <ul className="flex flex-wrap gap-2" role="list">
        {focus.map((item) => (
          <li
            key={item}
            className="inline-flex items-center gap-1.5 rounded-full bg-white border border-blue-200 px-3 py-1 text-xs font-medium text-blue-700 shadow-sm"
          >
            <span className="w-1.5 h-1.5 rounded-full bg-blue-500" aria-hidden="true" />
            {item}
          </li>
        ))}
      </ul>
    </section>
  )
}
