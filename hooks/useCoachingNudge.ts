import { useEffect, useRef, useState } from 'react'
import { analyzeSpeech } from '@/lib/speechMetrics'
import { deriveNudge, type CoachingNudge } from '@/lib/coachingNudges'
import type { InterviewState } from '@/lib/types'

// ─── Constants ────────────────────────────────────────────────────────────────

const POLL_INTERVAL_MS = 4000
const MIN_ELAPSED_MS = 3000
const NUDGE_DISPLAY_MS = 5000

// ─── Hook ─────────────────────────────────────────────────────────────────────

interface UseCoachingNudgeOptions {
  phase: InterviewState
  liveTranscript: string
}

/**
 * Watches `liveTranscript` during LISTENING phase and surfaces one coaching
 * nudge at a time, with per-id cooldown so nudges never spam.
 *
 * Returns the currently-active nudge (or null).
 */
export function useCoachingNudge({ phase, liveTranscript }: UseCoachingNudgeOptions): CoachingNudge | null {
  const [activeNudge, setActiveNudge] = useState<CoachingNudge | null>(null)

  // Stable refs — avoids re-creating the poll interval on every transcript update
  const nudgeTimerRef = useRef<ReturnType<typeof setTimeout>>()
  const lastNudgeIdRef = useRef<string | null>(null)
  const listeningStartRef = useRef(0)
  const liveTranscriptRef = useRef(liveTranscript)
  liveTranscriptRef.current = liveTranscript

  // Track listening start; clear nudge when leaving LISTENING
  useEffect(() => {
    if (phase === 'LISTENING') {
      listeningStartRef.current = Date.now()
      lastNudgeIdRef.current = null
    } else {
      setActiveNudge(null)
      clearTimeout(nudgeTimerRef.current)
    }
  }, [phase])

  // Poll every POLL_INTERVAL_MS while LISTENING
  useEffect(() => {
    if (phase !== 'LISTENING') return

    const interval = setInterval(() => {
      const transcript = liveTranscriptRef.current
      if (!transcript) return

      const elapsedMs = Date.now() - listeningStartRef.current
      if (elapsedMs < MIN_ELAPSED_MS) return

      const metrics = analyzeSpeech(transcript, elapsedMs / 60000)
      const nudge = deriveNudge(metrics, elapsedMs / 1000)

      if (nudge && nudge.id !== lastNudgeIdRef.current) {
        lastNudgeIdRef.current = nudge.id
        setActiveNudge(nudge)
        clearTimeout(nudgeTimerRef.current)
        nudgeTimerRef.current = setTimeout(() => setActiveNudge(null), NUDGE_DISPLAY_MS)
      }
    }, POLL_INTERVAL_MS)

    return () => {
      clearInterval(interval)
      clearTimeout(nudgeTimerRef.current)
    }
  }, [phase]) // liveTranscript intentionally read from ref to avoid interval churn

  return activeNudge
}
