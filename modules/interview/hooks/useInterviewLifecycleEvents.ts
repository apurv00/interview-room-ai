'use client'

/**
 * Interview lifecycle analytics — fires `interview_started`,
 * `interview_completed`, and `interview_abandoned` from outside
 * `useInterview.ts`.
 *
 * useInterview.ts is a HOT PATH file (see CLAUDE.md). Edits to it
 * require an end-to-end interview verification with real Deepgram +
 * Anthropic keys. Analytics instrumentation cannot satisfy that bar
 * without a live API budget, so we observe useInterview's exposed
 * `phase` + `sessionId` from the page that mounts it and derive
 * lifecycle transitions here. useInterview itself is untouched.
 *
 * State machine (see modules/interview/docs/INTERVIEW_FLOW.md §3):
 *   INIT → LOBBY → CALIBRATION → INTERVIEW_START → ASK_QUESTION
 *     → LISTENING → PROCESSING → COACHING → ASK_QUESTION (loop)
 *     → WRAP_UP → SCORING → FEEDBACK → ENDED
 *
 * Single-fire guarantees:
 *   - `interview_started` fires once per page mount, the first time we
 *     observe `phase` outside {INIT, LOBBY, CALIBRATION} with a
 *     non-null sessionId. (Mic-permission-denied paths never reach
 *     this state — sessionId stays null — so no spurious starts.)
 *   - `interview_completed` fires once per page mount, the first time
 *     `phase === 'FEEDBACK'` is observed AND the candidate did not
 *     mark abandon via `markAbandoned()`.
 *   - `interview_abandoned` fires synchronously from `markAbandoned()`
 *     (called from the End button click handler in
 *     `app/interview/page.tsx`) BEFORE `finishInterview('user_ended')`
 *     runs. Sets a ref that suppresses the otherwise-imminent
 *     `interview_completed` emit on the SCORING → FEEDBACK transition.
 */

import { useEffect, useRef } from 'react'
import { track } from '@shared/analytics/track'
import type { InterviewState, InterviewConfig } from '@shared/types'

interface UseInterviewLifecycleEventsArgs {
  phase: InterviewState
  sessionId: string | null
  config: InterviewConfig | null
  questionIndex: number
  timeRemaining: number
}

interface UseInterviewLifecycleEventsReturn {
  /**
   * Call from the End Interview button click handler BEFORE
   * `finishInterview('user_ended')` runs. Fires `interview_abandoned`
   * synchronously and prevents the upcoming FEEDBACK transition from
   * also firing `interview_completed`.
   */
  markAbandoned: () => void
}

const PRE_START_PHASES = new Set<InterviewState>(['INIT', 'LOBBY', 'CALIBRATION'])

function durationSecondsElapsed(config: InterviewConfig | null, timeRemaining: number): number {
  if (!config?.duration) return 0
  return Math.max(0, config.duration * 60 - timeRemaining)
}

export function useInterviewLifecycleEvents({
  phase,
  sessionId,
  config,
  questionIndex,
  timeRemaining,
}: UseInterviewLifecycleEventsArgs): UseInterviewLifecycleEventsReturn {
  const startedFiredRef = useRef(false)
  const completedFiredRef = useRef(false)
  const abandonedFiredRef = useRef(false)

  useEffect(() => {
    if (
      !startedFiredRef.current &&
      sessionId &&
      config &&
      !PRE_START_PHASES.has(phase)
    ) {
      startedFiredRef.current = true
      track('interview_started', {
        session_id: sessionId,
        domain: config.role || 'unknown',
        depth: config.interviewType || 'screening',
        duration_minutes: config.duration || 0,
        experience: config.experience || 'unknown',
      })
    }

    if (
      !completedFiredRef.current &&
      !abandonedFiredRef.current &&
      phase === 'FEEDBACK' &&
      sessionId
    ) {
      completedFiredRef.current = true
      track('interview_completed', {
        session_id: sessionId,
        question_count: questionIndex,
        duration_seconds_elapsed: durationSecondsElapsed(config, timeRemaining),
      })
    }
  }, [phase, sessionId, config, questionIndex, timeRemaining])

  const markAbandoned = (): void => {
    if (abandonedFiredRef.current) return
    if (!sessionId) return
    abandonedFiredRef.current = true
    track('interview_abandoned', {
      session_id: sessionId,
      q_index_at_abandon: questionIndex,
      time_remaining_at_abandon: timeRemaining,
      duration_seconds_elapsed: durationSecondsElapsed(config, timeRemaining),
    })
  }

  return { markAbandoned }
}
