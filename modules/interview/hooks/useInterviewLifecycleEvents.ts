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
 *   - `interview_started` fires once per page mount, the first time
 *     `phase` enters REAL_INTERVIEW_PHASES (ASK_QUESTION, LISTENING,
 *     CODE_EDITING, DESIGN_CANVAS, PROCESSING, COACHING, FOLLOW_UP,
 *     WRAP_UP) with a non-null sessionId AND no prior abandon.
 *     INIT/LOBBY/CALIBRATION/INTERVIEW_START/SCORING/ENDED do NOT
 *     count as a real start. The positive-allowlist gate prevents
 *     pre-start time-ups (useInterview.ts:520-521 catch-all `else`
 *     branch fires `finishInterview('time_up')` from any unlisted
 *     phase, including CALIBRATION) from being misclassified as
 *     started.
 *   - `interview_completed` fires once per page mount when
 *     `phase === 'SCORING'` AND `startedFiredRef.current` is true
 *     AND no prior abandon. The startedFiredRef requirement closes
 *     the same pre-start time-up loophole on the completion side.
 *     SCORING (not FEEDBACK) is the terminal phase reached inside
 *     useInterview — `finishInterview` calls `transitionTo('SCORING')`
 *     then `router.push('/feedback/...')`, which unmounts this hook
 *     before FEEDBACK could be observed. Per Codex P1 review.
 *   - `interview_abandoned` fires synchronously from `markAbandoned()`
 *     (called from the End button click handler in
 *     `app/interview/page.tsx`) BEFORE `finishInterview('user_ended')`
 *     runs. Sets a ref that suppresses the otherwise-imminent
 *     `interview_completed` emit on the SCORING transition.
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

/**
 * Positive allowlist of phases that count as "the user reached a real
 * interview phase". A pre-start timeout (timer expires while still in
 * INIT/LOBBY/CALIBRATION/INTERVIEW_START) drives `finishInterview` →
 * SCORING without ever passing through one of these phases, so we
 * suppress lifecycle events for those idle sessions. Codex P2 round 4
 * on PR #331.
 *
 * INTERVIEW_START is intentionally NOT in this set — the avatar's
 * intro greeting starts there, but the timer's catch-all `else`
 * branch (useInterview.ts:520-521) fires `finishInterview('time_up')`
 * from INTERVIEW_START too if nothing has progressed past it. The
 * earliest *certain* "real interview" signal is ASK_QUESTION (or
 * CODE_EDITING / DESIGN_CANVAS for the coding / system-design flows
 * where ASK_QUESTION is brief and immediately followed).
 */
const REAL_INTERVIEW_PHASES = new Set<InterviewState>([
  'ASK_QUESTION',
  'LISTENING',
  'CODE_EDITING',
  'DESIGN_CANVAS',
  'PROCESSING',
  'COACHING',
  'FOLLOW_UP',
  'WRAP_UP',
])

function durationSecondsElapsed(config: InterviewConfig | null, timeRemaining: number): number {
  if (!config?.duration) return 0
  return Math.max(0, config.duration * 60 - timeRemaining)
}

/**
 * Convert `questionIndex` to a cardinal count, accounting for the
 * different index bases useInterview.ts uses per interview mode:
 *
 * - General/screening/behavioral/etc. (`useInterview.ts:1350`):
 *   `setQuestionIndex(qIdx)` runs at the START of each loop iteration
 *   with a 0-based qIdx. The local `qIdx++` after the answer happens
 *   AFTER the loop's last setQuestionIndex call, so React state ends
 *   up one less than the count. +1 recovers the cardinal.
 *
 * - Coding (`useInterview.ts:1921-1922`) and system-design
 *   (`useInterview.ts:2039-2040`): `setQuestionIndex(1)` at the first
 *   problem (1-based). React state at SCORING already equals the
 *   cardinal count. No +1 needed.
 *
 * Codex P1 round 4 on PR #331.
 */
function questionCountAtCompletion(
  config: InterviewConfig | null,
  questionIndex: number,
): number {
  const t = config?.interviewType
  if (t === 'coding' || t === 'system-design') return questionIndex
  return questionIndex + 1
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
  /**
   * Captures the click-time payload when markAbandoned() runs with a
   * stale-null sessionId. The useEffect below backfills the emit on
   * the next render that has a fresh sessionId. Without this, the
   * round-2 latch correctly suppressed the false `interview_completed`
   * but threw away the abandon attribution itself — undercounting
   * user-ended sessions in the staleness window. Codex P2 round 5.
   */
  const pendingAbandonRef = useRef<null | {
    q_index_at_abandon: number
    time_remaining_at_abandon: number
    duration_seconds_elapsed: number
  }>(null)

  useEffect(() => {
    // Backfill: if a markAbandoned() call landed during the stale-null
    // sessionId window, emit the deferred event now that sessionId is
    // available. The captured fields reflect the click moment, not the
    // current render — the user clicked End at q=3 / t=600s, that's
    // what the funnel needs to record regardless of when the closure
    // refreshed. Codex P2 round 5.
    if (pendingAbandonRef.current && sessionId) {
      const payload = pendingAbandonRef.current
      pendingAbandonRef.current = null
      track('interview_abandoned', { session_id: sessionId, ...payload })
    }

    if (
      !startedFiredRef.current &&
      !abandonedFiredRef.current &&
      sessionId &&
      config &&
      REAL_INTERVIEW_PHASES.has(phase)
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

    // `interview_completed` REQUIRES `interview_started` to have fired.
    // Second half of the Codex P2 round 4 fix: an idle pre-start
    // session whose timer fires `finishInterview('time_up')` from
    // CALIBRATION reaches SCORING without ever passing through
    // REAL_INTERVIEW_PHASES, so startedFiredRef is false and the
    // spurious completion is suppressed. Without this gate, pre-start
    // time-ups would inflate the funnel completion count.
    if (
      startedFiredRef.current &&
      !completedFiredRef.current &&
      !abandonedFiredRef.current &&
      phase === 'SCORING' &&
      sessionId
    ) {
      completedFiredRef.current = true
      track('interview_completed', {
        session_id: sessionId,
        question_count: questionCountAtCompletion(config, questionIndex),
        duration_seconds_elapsed: durationSecondsElapsed(config, timeRemaining),
      })
    }
  }, [phase, sessionId, config, questionIndex, timeRemaining])

  const markAbandoned = (): void => {
    if (abandonedFiredRef.current) return
    // Latch BEFORE the sessionId guard. useInterview exposes
    // sessionId via `sessionIdRef.current` (useInterview.ts:2247 —
    // not React state). Ref writes don't re-render, so the page's
    // `interview.sessionId` stays stale at `null` between
    // sessionIdRef = sid (useInterview.ts:411) and the next
    // unrelated state-setter. If End is clicked in that window the
    // closure here sees null. Without latching abandonedFiredRef,
    // the SCORING transition (whose transitionTo IS a state-setter
    // and refreshes the closure) would then fire interview_completed,
    // misclassifying a user-ended interview as completed. Codex P1
    // round 2.
    abandonedFiredRef.current = true
    const payload = {
      q_index_at_abandon: questionIndex,
      time_remaining_at_abandon: timeRemaining,
      duration_seconds_elapsed: durationSecondsElapsed(config, timeRemaining),
    }
    if (!sessionId) {
      // Stash for backfill — the useEffect will emit on the next
      // render that has a fresh sessionId, preserving abandon
      // attribution that round 2's bare latch threw away. Codex P2
      // round 5.
      pendingAbandonRef.current = payload
      return
    }
    track('interview_abandoned', { session_id: sessionId, ...payload })
  }

  return { markAbandoned }
}
