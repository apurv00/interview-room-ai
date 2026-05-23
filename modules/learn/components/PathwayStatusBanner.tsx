'use client'

import Link from 'next/link'
import { ArrowRight, Target } from 'lucide-react'
import { usePathwayNextAction } from '@learn/hooks/usePathwayNextAction'

const READINESS_LABELS: Record<string, string> = {
  not_ready: 'Foundation',
  developing: 'Developing',
  approaching: 'Approaching',
  ready: 'Interview Ready',
  strong: 'Strong',
}

/**
 * Authed-only banner shown above the marketing homepage hero.
 * Silently renders nothing for unauthenticated visitors. Authenticated users
 * see either their next Pathway action or the baseline interview activation.
 *
 * Wave 3 / UAT-021: pathway state now comes from the shared
 * `usePathwayNextAction` hook so the signed-in MarketingHomepage CTA
 * can read the same `nextAction` (deduplicatedFetch shares the
 * in-flight network call between this banner and the hero CTA).
 *
 * Codex P2 (PR #402): treat 'error' as 'empty' rather than vanishing
 * the whole banner. Pre-Wave-3 code rendered the "Start your pathway"
 * baseline whenever the fetch failed (the inline catch set loading
 * false + pathway null, which fell into the empty branch). After the
 * hook migration, returning null on `'error'` removed every recovery
 * affordance on degraded networks — fix by falling through to the
 * baseline render in both 'empty' AND 'error' states.
 */
export default function PathwayStatusBanner() {
  const { status: hookStatus, state: pathwayState, nextAction, pathway } = usePathwayNextAction()

  // Anonymous + still-loading visitors get nothing.
  if (hookStatus === 'loading' || hookStatus === 'anonymous') return null

  // On 'error' we fall through to the baseline branch below — pathway
  // is null in that state, so `!pathway` evaluates true and the
  // "Start your pathway" affordance still renders. That keeps a
  // recovery CTA in the banner area on transient network failures.
  if (pathwayState === 'empty' || !pathway) {
    return (
      <div className="w-full bg-gradient-to-r from-blue-600 to-indigo-600 text-white">
        <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-3">
          <Link
            href={nextAction?.href || '/learn/pathway'}
            className="flex items-center justify-between gap-4 group"
          >
            <div className="flex items-center gap-3 min-w-0">
              <div className="shrink-0 w-9 h-9 rounded-full bg-white/15 flex items-center justify-center">
                <Target className="w-4 h-4" />
              </div>
              <div className="min-w-0">
                <div className="text-[11px] uppercase tracking-wide text-white/70 font-semibold">
                  Start your pathway
                </div>
                <p className="text-sm font-medium truncate">
                  Run a baseline interview to generate your first plan.
                </p>
              </div>
            </div>
            <div className="shrink-0 flex items-center gap-1 text-sm font-semibold group-hover:translate-x-0.5 transition-transform">
              <span className="hidden sm:inline">{nextAction?.ctaLabel || 'Start baseline'}</span>
              <ArrowRight className="w-4 h-4" />
            </div>
          </Link>
        </div>
      </div>
    )
  }

  const readinessLabel = READINESS_LABELS[pathway.readinessLevel] || 'In progress'
  const nextTask =
    nextAction?.title ||
    pathway.practiceTasks?.find((t) => !t.completed)?.title ||
    pathway.nextSessionRecommendation?.reason ||
    'Continue your pathway'

  return (
    <div className="w-full bg-gradient-to-r from-blue-600 to-indigo-600 text-white">
      <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-3">
        <Link
          href="/learn/pathway"
          className="flex items-center justify-between gap-4 group"
        >
          <div className="flex items-center gap-3 min-w-0">
            <div className="shrink-0 w-9 h-9 rounded-full bg-white/15 flex items-center justify-center">
              <Target className="w-4 h-4" />
            </div>
            <div className="min-w-0">
              <div className="flex items-center gap-2 text-[11px] uppercase tracking-wide text-white/70 font-semibold">
                <span>Your pathway</span>
                <span className="px-1.5 py-0.5 rounded-full bg-white/15 text-[10px]">
                  {pathway.readinessScore}/100 · {readinessLabel}
                </span>
              </div>
              <p className="text-sm font-medium truncate">
                Next step: <span className="text-white/90">{nextTask}</span>
              </p>
            </div>
          </div>
          <div className="shrink-0 flex items-center gap-1 text-sm font-semibold group-hover:translate-x-0.5 transition-transform">
            <span className="hidden sm:inline">View pathway</span>
            <ArrowRight className="w-4 h-4" />
          </div>
        </Link>
      </div>
    </div>
  )
}
