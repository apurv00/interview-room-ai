'use client'

import { useEffect, useState } from 'react'
import { TrendingUp, Info } from 'lucide-react'
import { deduplicatedFetch } from '@shared/cachedFetch'

interface HistoryEntry {
  id: string
  delta: number
  competency: string
  createdAt: string
}

interface HistoryResponse {
  attempts: HistoryEntry[]
}

/**
 * DeltaContextNote — one-line trend note that appears alongside the
 * "+N" delta badge after a drill submission.
 *
 * Pathway P2 Wave 5 (feature 5C). Three rendered states:
 *
 *   1. First drill on this competency → "First {competency} drill —
 *      you'll see your retry trend after the next one."
 *   2. Has prior history → "Average +{N} across {M} prior {competency}
 *      drills" (mean computed from the priors, excluding the current
 *      attempt to avoid mixing the just-submitted one into its own
 *      baseline).
 *   3. Approximate-delta caveat → "Approximate — the original score
 *      was rolled up across 4 dims; this retry was scored independently."
 *      Renders below the trend line ONLY when |latestDelta| > 15 (a
 *      threshold beyond which the cross-prompt scoring incommensurability
 *      flagged by the Plan agent could materially change the read).
 *
 * Self-fetches via `deduplicatedFetch` (Wave 1 pattern) so the parent
 * page doesn't have to thread history state into its already-busy
 * drill state machine.
 */
export default function DeltaContextNote({
  competency,
  latestDelta,
}: {
  competency: string
  /**
   * The delta the user just earned on THIS drill. Excluded from the
   * trend aggregation — we want "your priors averaged +N", not "your
   * priors plus this one averaged +N" (the latter conflates the
   * baseline with the data point being contextualised).
   */
  latestDelta: number
}) {
  const [priors, setPriors] = useState<HistoryEntry[] | null>(null)
  const [errored, setErrored] = useState(false)

  useEffect(() => {
    if (!competency) {
      setPriors(null)
      return
    }
    let cancelled = false

    // Limit 11: 10 priors + the just-submitted attempt. The submitted
    // one ALREADY landed in the DB before the evaluate route returned,
    // so it's in the response. We filter it out below.
    deduplicatedFetch(
      `/api/learn/drill/history?competency=${encodeURIComponent(competency)}&limit=11`,
      { cache: 'no-store' },
    )
      .then((res) => {
        if (!res.ok) throw new Error(`HTTP ${res.status}`)
        return res.json() as Promise<HistoryResponse>
      })
      .then((payload) => {
        if (cancelled) return
        setPriors(payload.attempts ?? [])
        setErrored(false)
      })
      .catch(() => {
        if (cancelled) return
        setErrored(true)
        setPriors(null)
      })

    return () => {
      cancelled = true
    }
  }, [competency])

  if (errored || priors === null) return null

  // The just-submitted attempt is the most recent (createdAt desc).
  // Exclude it so the trend reflects ACTUAL prior history. The DB
  // doesn't surface our drill-attempt id in the evaluator response, so
  // we use the "drop the most recent matching delta" heuristic — same
  // outcome since the priors are already competency-filtered.
  const justSubmittedIndex = priors.findIndex((p) => p.delta === latestDelta)
  const filteredPriors = justSubmittedIndex >= 0
    ? [...priors.slice(0, justSubmittedIndex), ...priors.slice(justSubmittedIndex + 1)]
    : priors

  const prettyCompetency = competency.replace(/_/g, ' ')
  const showApproxCaveat = Math.abs(latestDelta) > 15

  if (filteredPriors.length === 0) {
    return (
      <div
        data-testid="delta-context-note"
        className="text-xs text-[#71767b] flex items-start gap-1.5 mt-2"
      >
        <TrendingUp className="w-3.5 h-3.5 shrink-0 mt-0.5 text-[#8b98a5]" aria-hidden="true" />
        <span>
          First {prettyCompetency} drill — you&apos;ll see your retry trend after the next one.
        </span>
      </div>
    )
  }

  const meanDelta = Math.round(
    filteredPriors.reduce((sum, p) => sum + p.delta, 0) / filteredPriors.length,
  )
  const sign = meanDelta > 0 ? '+' : ''

  return (
    <div data-testid="delta-context-note" className="space-y-1 mt-2">
      <div className="text-xs text-[#71767b] flex items-start gap-1.5">
        <TrendingUp
          className={`w-3.5 h-3.5 shrink-0 mt-0.5 ${
            meanDelta > 0 ? 'text-emerald-600' : meanDelta < 0 ? 'text-red-500' : 'text-[#8b98a5]'
          }`}
          aria-hidden="true"
        />
        <span>
          Average{' '}
          <span className="font-medium text-[#536471]">
            {sign}
            {meanDelta}
          </span>{' '}
          across {filteredPriors.length} prior {prettyCompetency}{' '}
          {filteredPriors.length === 1 ? 'drill' : 'drills'}.
        </span>
      </div>
      {showApproxCaveat && (
        <div
          data-testid="delta-context-approx-caveat"
          className="text-[11px] text-[#8b98a5] flex items-start gap-1.5"
        >
          <Info className="w-3 h-3 shrink-0 mt-0.5" aria-hidden="true" />
          <span>
            Approximate — the original score was rolled up across 4 dimensions; this retry was
            scored independently.
          </span>
        </div>
      )}
    </div>
  )
}
