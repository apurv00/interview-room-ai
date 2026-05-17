'use client'

import { useEffect, useState } from 'react'
import Link from 'next/link'
import { ArrowRight, ArrowUpRight, ArrowDownRight, Minus, Repeat } from 'lucide-react'
import { deduplicatedFetch } from '@shared/cachedFetch'

interface PriorFeedback {
  sessionId: string
  completedAt: string | null
  domain: string
  interviewType: string | null
  overallScore: number | null
  topImprovements: string[]
}

interface PriorPayload {
  feedback: PriorFeedback | null
}

/**
 * PostInterviewDeltaCard — closes the action-anchored coaching loop
 * opened by the Setup page's Pre-interview Coach Card.
 *
 * Pathway P2 Wave 2 (feature B): when a user finishes an interview,
 * the Overview tab surfaces last same-domain interview's top focus
 * area side-by-side with this one's, plus the overall_score delta.
 * The user sees at a glance:
 *
 *   - Did the LLM-flagged focus area repeat? → "Still showing up" badge
 *   - Did overall move? → ±N badge with direction
 *   - Where to dig deeper → link back to prior feedback page
 *
 * Diagnostic-coach framing: the card answers "did I close the loop on
 * what was flagged last time?" rather than imposing a curriculum.
 *
 * Distinct from the existing ComparisonCard:
 *   - ComparisonCard: numeric per-dimension deltas
 *     (relevance/structure/specificity/ownership) against rolling avg
 *     or retake parent
 *   - This card: qualitative top_3_improvements continuity + overall
 *     delta against the IMMEDIATELY-PREVIOUS same-domain session
 *
 * Hides itself when no prior same-domain session exists (first
 * interview in a domain).
 */
export default function PostInterviewDeltaCard({
  sessionId,
  domain,
  currentOverallScore,
  currentTopImprovements,
}: {
  sessionId: string
  domain: string | undefined
  currentOverallScore: number
  currentTopImprovements: string[]
}) {
  const [prior, setPrior] = useState<PriorFeedback | null>(null)
  const [loading, setLoading] = useState(false)
  const [errored, setErrored] = useState(false)

  useEffect(() => {
    if (!domain || !sessionId || sessionId === 'local') {
      setPrior(null)
      return
    }
    let cancelled = false
    setLoading(true)
    setErrored(false)

    deduplicatedFetch(
      `/api/interviews/last-same-domain-feedback?domain=${encodeURIComponent(domain)}&priorTo=${encodeURIComponent(sessionId)}`,
      { cache: 'no-store' },
    )
      .then((res) => {
        if (!res.ok) throw new Error(`HTTP ${res.status}`)
        return res.json() as Promise<PriorPayload>
      })
      .then((payload) => {
        if (cancelled) return
        setPrior(payload.feedback)
      })
      .catch(() => {
        if (cancelled) return
        setErrored(true)
        setPrior(null)
      })
      .finally(() => {
        if (!cancelled) setLoading(false)
      })

    return () => {
      cancelled = true
    }
  }, [domain, sessionId])

  // Silent degradation across all empty/error states — this card is
  // additive context, not a blocker.
  if (loading || errored || !prior || prior.topImprovements.length === 0) {
    return null
  }

  const priorTop = prior.topImprovements[0]
  const currentTop = currentTopImprovements[0] ?? null
  // String similarity is fragile; the conservative check is "is the
  // prior top improvement still the literal first improvement now?"
  // Same phrasing across LLM runs strongly suggests a repeated pattern.
  // Different phrasing is treated as a shift, even if the underlying
  // weakness is still there — surfacing a false "cleared" is less
  // misleading than a false "repeated" because the user reads BOTH
  // strings side-by-side.
  const normalize = (s: string) =>
    s.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim()
  const repeated = currentTop !== null && normalize(currentTop) === normalize(priorTop)

  const delta =
    typeof prior.overallScore === 'number'
      ? currentOverallScore - prior.overallScore
      : null
  const direction: 'up' | 'down' | 'flat' | null =
    delta === null ? null : delta > 2 ? 'up' : delta < -2 ? 'down' : 'flat'

  return (
    <section
      data-testid="post-interview-delta-card"
      aria-label="Comparison with your last interview in this domain"
      className="surface-card-bordered p-5 sm:p-6"
    >
      <div className="flex items-center justify-between mb-4 gap-3 flex-wrap">
        <h3 className="text-sm font-semibold text-[#0f1419]">
          Compared to your last interview in this domain
        </h3>
        {delta !== null && direction && (
          <DeltaBadge delta={delta} direction={direction} />
        )}
      </div>

      <div className="grid sm:grid-cols-2 gap-3">
        <div className="rounded-xl border border-[#e1e8ed] bg-[#f8fafc] p-4">
          <p className="text-[11px] uppercase tracking-[0.12em] font-semibold text-[#71767b] mb-1.5">
            Last time
          </p>
          <p className="text-sm text-[#0f1419] leading-snug">{priorTop}</p>
          {typeof prior.overallScore === 'number' && (
            <p className="mt-2 text-xs text-[#71767b]">
              Overall {prior.overallScore}
            </p>
          )}
        </div>

        <div
          className={`rounded-xl border p-4 ${
            repeated
              ? 'border-amber-200 bg-amber-50'
              : 'border-emerald-200 bg-emerald-50'
          }`}
        >
          <div className="flex items-center justify-between mb-1.5">
            <p
              className={`text-[11px] uppercase tracking-[0.12em] font-semibold ${
                repeated ? 'text-amber-700' : 'text-emerald-700'
              }`}
            >
              This time
            </p>
            {repeated && (
              <span className="inline-flex items-center gap-1 text-[10px] font-medium text-amber-700 bg-white border border-amber-200 px-1.5 py-0.5 rounded">
                <Repeat className="w-3 h-3" aria-hidden="true" />
                Still showing up
              </span>
            )}
          </div>
          <p className="text-sm text-[#0f1419] leading-snug">
            {currentTop ?? 'No focus area identified.'}
          </p>
          <p className="mt-2 text-xs text-[#71767b]">
            Overall {currentOverallScore}
          </p>
        </div>
      </div>

      <Link
        href={`/feedback/${prior.sessionId}`}
        className="mt-3 inline-flex items-center gap-1 text-xs font-medium text-blue-600 hover:text-blue-700 transition-colors"
      >
        See last interview&apos;s full feedback
        <ArrowRight className="w-3 h-3" aria-hidden="true" />
      </Link>
    </section>
  )
}

function DeltaBadge({
  delta,
  direction,
}: {
  delta: number
  direction: 'up' | 'down' | 'flat'
}) {
  const sign = delta > 0 ? '+' : ''
  const color =
    direction === 'up'
      ? 'text-emerald-700 bg-emerald-100'
      : direction === 'down'
        ? 'text-red-700 bg-red-100'
        : 'text-[#536471] bg-[#f8fafc]'
  const Icon =
    direction === 'up' ? ArrowUpRight : direction === 'down' ? ArrowDownRight : Minus
  return (
    <span
      className={`inline-flex items-center gap-1 px-2 py-1 rounded-full text-xs font-semibold ${color}`}
      aria-label={`Overall score moved ${sign}${delta} versus the previous interview in this domain`}
    >
      <Icon className="w-3.5 h-3.5" aria-hidden="true" />
      {sign}
      {delta} overall
    </span>
  )
}
