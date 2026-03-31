'use client'

import { useEffect, useRef, useState } from 'react'
import type { CoachingNudge } from '@interview/config/coachingNudges'
import type { FacialFrame } from '@shared/types/multimodal'
import type { InterviewState } from '@shared/types'

const CHECK_INTERVAL_MS = 1000
const WINDOW_SIZE = 25       // 5 seconds at 5fps
const NUDGE_DISPLAY_MS = 5000
const COOLDOWN_MS = 30000    // Don't repeat same nudge type for 30s

interface UseRealtimeFacialCoachingOptions {
  phase: InterviewState
  framesRef: React.RefObject<FacialFrame[]>
  enabled: boolean
}

/**
 * Analyzes live facial landmark frames during LISTENING phase
 * and produces visual coaching nudges (eye contact, expression, stability).
 */
export function useRealtimeFacialCoaching({
  phase,
  framesRef,
  enabled,
}: UseRealtimeFacialCoachingOptions): CoachingNudge | null {
  const [activeNudge, setActiveNudge] = useState<CoachingNudge | null>(null)
  const nudgeTimerRef = useRef<ReturnType<typeof setTimeout>>()
  const cooldownsRef = useRef<Map<string, number>>(new Map())

  useEffect(() => {
    if (phase !== 'LISTENING' || !enabled) {
      setActiveNudge(null)
      clearTimeout(nudgeTimerRef.current)
      return
    }

    const interval = setInterval(() => {
      const frames = framesRef.current
      if (!frames || frames.length < 10) return // Need enough data

      // Sliding window of last WINDOW_SIZE frames
      const window = frames.slice(-WINDOW_SIZE)
      if (window.length < 10) return

      const now = Date.now()
      const nudge = deriveFacialNudge(window, now, cooldownsRef.current)

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
  }, [phase, enabled, framesRef])

  // Clear on phase change
  useEffect(() => {
    if (phase === 'LISTENING') {
      cooldownsRef.current.clear()
    }
  }, [phase])

  return activeNudge
}

function deriveFacialNudge(
  window: FacialFrame[],
  now: number,
  cooldowns: Map<string, number>
): CoachingNudge | null {
  // Check cooldowns
  const canShow = (id: string) => {
    const last = cooldowns.get(id)
    return !last || now - last > COOLDOWN_MS
  }

  // 1. Eye contact check
  const avgEyeContact = window.reduce((sum, f) => sum + f.eyeContactScore, 0) / window.length
  if (avgEyeContact < 0.3 && canShow('eye-contact')) {
    return {
      id: 'eye-contact',
      message: 'Try to look at the camera — it shows confidence',
      type: 'visual',
      severity: 'info',
    }
  }

  // 2. Expression stale check (all neutral or frown)
  const expressionCounts = { neutral: 0, frown: 0 }
  for (const f of window) {
    if (f.expression === 'neutral') expressionCounts.neutral++
    if (f.expression === 'frown') expressionCounts.frown++
  }
  const staleRatio = (expressionCounts.neutral + expressionCounts.frown) / window.length
  if (staleRatio > 0.9 && canShow('expression')) {
    return {
      id: 'expression',
      message: 'Try to show engagement — a natural smile goes a long way',
      type: 'visual',
      severity: 'info',
    }
  }

  // 3. Head stability check
  const yawValues = window.map((f) => f.headPoseYaw)
  const pitchValues = window.map((f) => f.headPosePitch)
  const yawVar = variance(yawValues)
  const pitchVar = variance(pitchValues)
  if ((yawVar + pitchVar) > 150 && canShow('head-stability')) {
    return {
      id: 'head-stability',
      message: 'Try to keep your head steady — it shows composure',
      type: 'visual',
      severity: 'info',
    }
  }

  return null
}

function variance(values: number[]): number {
  if (values.length === 0) return 0
  const mean = values.reduce((a, b) => a + b, 0) / values.length
  return values.reduce((sum, v) => sum + (v - mean) ** 2, 0) / values.length
}
