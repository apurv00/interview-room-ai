'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import type { PathwayUpdateEligibility } from '@learn/services/pathwayUpdateEligibility'
import type { PathwayViewModel } from '@learn/services/pathwayViewModel'

const POLL_INTERVAL_MS = 3000
const POLL_MAX_MS = 120_000

export type PathwayPollPhase = 'idle' | 'polling' | 'done' | 'exhausted'

interface PathwayPollResponse extends PathwayViewModel {
  pathway?: { generatedFromSessionId?: string | null } | null
  pathwayUpdate?: PathwayUpdateEligibility | null
}

interface UsePathwayGenerationPollOptions {
  sessionId: string | null | undefined
  enabled: boolean
  onRefresh: () => void | Promise<void>
  /** Bump after a successful pathway retry to restart the 120s poll window. */
  pollEpoch?: number
}

export function usePathwayGenerationPoll({
  sessionId,
  enabled,
  onRefresh,
  pollEpoch = 0,
}: UsePathwayGenerationPollOptions) {
  const [phase, setPhase] = useState<PathwayPollPhase>('idle')
  const startedAtRef = useRef<number | null>(null)
  const onRefreshRef = useRef(onRefresh)
  onRefreshRef.current = onRefresh

  const pollOnce = useCallback(async (): Promise<'continue' | 'done' | 'exhausted'> => {
    if (!sessionId) return 'exhausted'
    const res = await fetch(
      `/api/learn/pathway?fromFeedback=${encodeURIComponent(sessionId)}`,
      { cache: 'no-store' },
    )
    if (!res.ok) return 'continue'

    const data = (await res.json()) as PathwayPollResponse
    const update = data.pathwayUpdate
    const generatedFrom = data.pathway?.generatedFromSessionId
      ? String(data.pathway.generatedFromSessionId)
      : ''

    if (
      update?.reason === 'pathway_succeeded' ||
      generatedFrom === sessionId ||
      (data.state !== 'pending' && data.state !== 'failed' && update?.poll === false)
    ) {
      await onRefreshRef.current()
      return 'done'
    }

    if (update?.reason === 'pathway_failed' || data.state === 'failed') {
      await onRefreshRef.current()
      return 'done'
    }

    return 'continue'
  }, [sessionId])

  useEffect(() => {
    if (!enabled || !sessionId) {
      setPhase('idle')
      startedAtRef.current = null
      return
    }

    let cancelled = false
    startedAtRef.current = Date.now()
    setPhase('polling')

    const tick = async () => {
      if (cancelled) return
      let outcome: 'continue' | 'done' | 'exhausted'
      try {
        outcome = await pollOnce()
      } catch {
        // Transient network/parse failure — same as a non-OK response: fall
        // through to the budget check below. (This path used to reschedule
        // unconditionally, so an offline or persistently-401 tab polled every
        // 3s forever — the comment here claimed a bound that did not exist.)
        outcome = 'continue'
      }
      if (cancelled) return
      if (outcome === 'done') {
        setPhase('done')
        return
      }
      if (outcome === 'exhausted') {
        setPhase('exhausted')
        return
      }
      // Budget check covers EVERY continue-flavored exit — ok-but-pending,
      // non-OK responses, and thrown fetches — and runs AFTER response
      // classification so a success that lands past the 120s budget still
      // resolves 'done' instead of being discarded as 'exhausted'.
      const started = startedAtRef.current ?? Date.now()
      if (Date.now() - started >= POLL_MAX_MS) {
        setPhase('exhausted')
        return
      }
      window.setTimeout(() => void tick(), POLL_INTERVAL_MS)
    }

    void tick()

    return () => {
      cancelled = true
    }
  }, [enabled, sessionId, pollOnce, pollEpoch])

  return { phase, pollExhausted: phase === 'exhausted' }
}
