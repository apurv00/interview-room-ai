'use client'

import { useEffect, useState } from 'react'
import Link from 'next/link'
import { useSession } from 'next-auth/react'
import { ArrowRight, Target } from 'lucide-react'

interface BannerPathway {
  readinessScore: number
  readinessLevel: string
  nextSessionRecommendation?: {
    reason?: string
    focusCompetencies?: string[]
  } | null
  practiceTasks?: Array<{ title: string; completed: boolean }>
}

const READINESS_LABELS: Record<string, string> = {
  not_ready: 'Foundation',
  developing: 'Developing',
  approaching: 'Approaching',
  ready: 'Interview Ready',
  strong: 'Strong',
}

/**
 * Authed-only banner shown above the marketing homepage hero.
 * Silently renders nothing for:
 *  - unauthenticated visitors
 *  - users with no pathway yet (zero completed sessions)
 * This keeps the marketing page pristine for first-time visitors while
 * giving returning users a one-click hook back into their habit loop.
 */
export default function PathwayStatusBanner() {
  const { status } = useSession()
  const [pathway, setPathway] = useState<BannerPathway | null>(null)
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    if (status !== 'authenticated') {
      setLoading(false)
      return
    }
    fetch('/api/learn/pathway')
      .then((r) => (r.ok ? r.json() : null))
      .then((data) => {
        setPathway(data?.pathway || null)
        setLoading(false)
      })
      .catch(() => setLoading(false))
  }, [status])

  if (status !== 'authenticated' || loading || !pathway) return null

  const readinessLabel = READINESS_LABELS[pathway.readinessLevel] || 'In progress'
  const nextTask =
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
