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
}

export function usePathwayGenerationPoll({
  sessionId,
  enabled,
  onRefresh,
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

    const started = startedAtRef.current ?? Date.now()
    if (Date.now() - started >= POLL_MAX_MS) {
      return 'exhausted'
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
      try {
        const outcome = await pollOnce()
        if (cancelled) return
        if (outcome === 'done') {
          setPhase('done')
          return
        }
        if (outcome === 'exhausted') {
          setPhase('exhausted')
          return
        }
      } catch {
        // Transient network — keep polling until budget exhausts.
      }
      if (!cancelled) {
        window.setTimeout(() => void tick(), POLL_INTERVAL_MS)
      }
    }

    void tick()

    return () => {
      cancelled = true
    }
  }, [enabled, sessionId, pollOnce])

  return { phase, pollExhausted: phase === 'exhausted' }
}
