'use client'

import { useEffect, useState } from 'react'
import Link from 'next/link'
import { Sparkles, ArrowRight } from 'lucide-react'
import { deduplicatedFetch } from '@shared/cachedFetch'
import { getDomainLabel } from '@interview/config/interviewConfig'

interface LastFeedbackPayload {
  feedback: {
    sessionId: string
    completedAt: string | null
    domain: string
    interviewType: string | null
    overallScore: number | null
    topImprovements: string[]
  } | null
}

/**
 * PreInterviewCoachCard — surfaces the most-recent same-domain
 * `feedback.top_3_improvements[]` at the moment a user is about
 * to start another interview.
 *
 * Pathway P2 Wave 1 (feature A): replaces the killed "Weekly Focus"
 * concept (which imported edtech cadence into a diagnostic-coach
 * product). Coaching insight is delivered AT the moment of action,
 * not on a weekly calendar — when the user is configuring an
 * interview, they hear "last time on Product Manager, your top
 * focus was X" so they can practise it deliberately.
 *
 * Behavior:
 *   - Renders nothing until a domain is selected
 *   - Fetches /api/interviews/last-same-domain-feedback?domain=<role>
 *   - Renders nothing if no same-domain completed history exists
 *   - Otherwise shows the top improvement as a one-line callout
 *     plus a link back to the full feedback page
 *
 * Fetch uses `deduplicatedFetch` so flipping between domains in
 * Step 0 doesn't fire redundant requests.
 */
export default function PreInterviewCoachCard({
  domain,
}: {
  domain: string | null
}) {
  const [data, setData] = useState<LastFeedbackPayload['feedback']>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    if (!domain) {
      setData(null)
      setError(null)
      return
    }

    let cancelled = false
    setLoading(true)
    setError(null)

    deduplicatedFetch(
      `/api/interviews/last-same-domain-feedback?domain=${encodeURIComponent(domain)}`,
      { cache: 'no-store' },
    )
      .then((res) => {
        if (!res.ok) throw new Error(`HTTP ${res.status}`)
        return res.json() as Promise<LastFeedbackPayload>
      })
      .then((payload) => {
        if (cancelled) return
        setData(payload.feedback)
      })
      .catch((err) => {
        if (cancelled) return
        setError(err instanceof Error ? err.message : 'fetch failed')
        setData(null)
      })
      .finally(() => {
        if (!cancelled) setLoading(false)
      })

    return () => {
      cancelled = true
    }
  }, [domain])

  if (!domain || loading || error || !data || data.topImprovements.length === 0) {
    return null
  }

  const primary = data.topImprovements[0]
  const rest = data.topImprovements.slice(1)
  const domainLabel = getDomainLabel(data.domain)

  return (
    <section
      data-testid="pre-interview-coach-card"
      aria-label="Coaching focus from your last same-domain interview"
      className="mb-6 rounded-2xl border border-amber-200/80 bg-gradient-to-br from-amber-50 to-white px-5 py-4"
    >
      <div className="flex items-center gap-2 mb-2">
        <Sparkles className="w-4 h-4 text-amber-600" aria-hidden="true" />
        <h2 className="text-[11px] font-semibold text-amber-700 uppercase tracking-[0.12em]">
          From your last {domainLabel} interview
        </h2>
      </div>
      <p className="text-sm text-slate-800 font-medium leading-snug">{primary}</p>
      {rest.length > 0 && (
        <ul
          className="mt-2 space-y-1 text-sm text-slate-600"
          role="list"
        >
          {rest.map((item, i) => (
            <li key={i} className="flex gap-2 leading-snug">
              <span aria-hidden="true" className="text-amber-500">•</span>
              <span>{item}</span>
            </li>
          ))}
        </ul>
      )}
      <Link
        href={`/feedback/${data.sessionId}`}
        className="mt-3 inline-flex items-center gap-1 text-xs font-medium text-amber-700 hover:text-amber-800 transition-colors"
      >
        See full feedback
        <ArrowRight className="w-3 h-3" aria-hidden="true" />
      </Link>
    </section>
  )
}
