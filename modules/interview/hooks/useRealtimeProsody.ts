'use client'

import { useEffect, useRef, useState } from 'react'
import type { CoachingNudge } from '@interview/config/coachingNudges'
import type { InterviewState } from '@shared/types'

const CHECK_INTERVAL_MS = 2000
const NUDGE_DISPLAY_MS = 5000
const COOLDOWN_MS = 20000

interface UseRealtimeProsodyOptions {
  phase: InterviewState
  liveTranscript: string
  enabled: boolean
}

/**
 * Real-time prosody coaching — detects pace changes and hesitation
 * by analyzing transcript growth rate over time.
 */
export function useRealtimeProsody({
  phase,
  liveTranscript,
  enabled,
}: UseRealtimeProsodyOptions): CoachingNudge | null {
  const [activeNudge, setActiveNudge] = useState<CoachingNudge | null>(null)
  const nudgeTimerRef = useRef<ReturnType<typeof setTimeout>>()
  const cooldownsRef = useRef<Map<string, number>>(new Map())
  const transcriptRef = useRef(liveTranscript)
  transcriptRef.current = liveTranscript

  // Track word count samples over time
  const samplesRef = useRef<Array<{ time: number; wordCount: number }>>([])
  const listeningStartRef = useRef(0)

  useEffect(() => {
    if (phase !== 'LISTENING' || !enabled) {
      setActiveNudge(null)
      clearTimeout(nudgeTimerRef.current)
      samplesRef.current = []
      return
    }

    listeningStartRef.current = Date.now()
    samplesRef.current = []
    cooldownsRef.current.clear()

    const interval = setInterval(() => {
      const transcript = transcriptRef.current
      const wordCount = transcript.split(/\s+/).filter(Boolean).length
      const now = Date.now()

      samplesRef.current.push({ time: now, wordCount })

      // Keep last 30 seconds of samples
      const cutoff = now - 30000
      samplesRef.current = samplesRef.current.filter((s) => s.time > cutoff)

      if (samplesRef.current.length < 3) return // Need enough samples
      const elapsed = (now - listeningStartRef.current) / 1000
      if (elapsed < 5) return // Wait at least 5s

      const nudge = deriveProsodyNudge(samplesRef.current, now, cooldownsRef.current)

      if (nudge) {
        cooldownsRef.current.set(nudge.id, now)
        setActiveNudge(nudge)
        clearTimeout(nudgeTimerRef.current)
        nudgeTimerRef.current = setTimeout(() => setActiveNudge(null), NUDGE_DISPLAY_MS)
      }
    }, CHECK_INTERVAL_MS)

    return () => {
      clearInterval(interval)
      clearTimeout(nudgeTimerRef.current)
    }
  }, [phase, enabled])

  return activeNudge
}

function deriveProsodyNudge(
  samples: Array<{ time: number; wordCount: number }>,
  now: number,
  cooldowns: Map<string, number>
): CoachingNudge | null {
  const canShow = (id: string) => {
    const last = cooldowns.get(id)
    return !last || now - last > COOLDOWN_MS
  }

  // Compare recent pace (last 8s) vs earlier pace (8-16s ago)
  const recentCutoff = now - 8000
  const earlierCutoff = now - 16000

  const recentSamples = samples.filter((s) => s.time > recentCutoff)
  const earlierSamples = samples.filter((s) => s.time > earlierCutoff && s.time <= recentCutoff)

  if (recentSamples.length < 2 || earlierSamples.length < 2) return null

  const recentRate = getWordsPerMinute(recentSamples)
  const earlierRate = getWordsPerMinute(earlierSamples)

  // Acceleration detection
  if (recentRate > 0 && earlierRate > 0) {
    const ratio = recentRate / earlierRate

    if (ratio > 1.5 && recentRate > 170 && canShow('pace-accelerating')) {
      return {
        id: 'pace-accelerating',
        message: 'You\'re speeding up — take a breath and slow down',
        type: 'prosody',
        severity: 'warning',
      }
    }

    if (ratio < 0.5 && recentRate < 80 && canShow('pace-stalling')) {
      return {
        id: 'pace-stalling',
        message: 'You\'re slowing down — keep your momentum going',
        type: 'prosody',
        severity: 'info',
      }
    }
  }

  // Stall detection: no word growth for 4+ seconds
  const lastSample = samples[samples.length - 1]
  const fourSecondsAgo = samples.find((s) => s.time > now - 5000 && s.time < now - 3000)
  if (fourSecondsAgo && lastSample.wordCount === fourSecondsAgo.wordCount && canShow('long-pause')) {
    return {
      id: 'long-pause',
      message: 'Long pause detected — it\'s okay to think, then continue',
      type: 'prosody',
      severity: 'info',
    }
  }

  return null
}

function getWordsPerMinute(samples: Array<{ time: number; wordCount: number }>): number {
  if (samples.length < 2) return 0
  const first = samples[0]
  const last = samples[samples.length - 1]
  const timeSpanMin = (last.time - first.time) / 60000
  if (timeSpanMin === 0) return 0
  const wordDiff = last.wordCount - first.wordCount
  return wordDiff / timeSpanMin
}
