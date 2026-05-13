import { describe, it, expect, vi, beforeEach } from 'vitest'
import { renderHook, act } from '@testing-library/react'
import { useInterviewLifecycleEvents } from '@interview/hooks/useInterviewLifecycleEvents'
import type { InterviewState, InterviewConfig } from '@shared/types'

const trackMock = vi.fn()
vi.mock('@shared/analytics/track', () => ({
  track: (...args: unknown[]) => trackMock(...args),
  identify: vi.fn(),
}))

const baseConfig: InterviewConfig = {
  role: 'swe',
  interviewType: 'technical',
  experience: '3-6',
  duration: 30,
}

interface Args {
  phase: InterviewState
  sessionId: string | null
  config: InterviewConfig | null
  questionIndex: number
  timeRemaining: number
}

const initialArgs: Args = {
  phase: 'INIT',
  sessionId: null,
  config: null,
  questionIndex: 0,
  timeRemaining: 30 * 60,
}

describe('useInterviewLifecycleEvents', () => {
  beforeEach(() => {
    trackMock.mockReset()
  })

  describe('interview_started', () => {
    it('does NOT fire while phase is in {INIT, LOBBY, CALIBRATION, INTERVIEW_START}', () => {
      // Codex P2 round 4: INTERVIEW_START is also pre-real because
      // useInterview.ts:520-521 catch-all timer-fire reaches SCORING
      // from any unlisted phase. Only ASK_QUESTION and onward count.
      const { rerender } = renderHook(
        ({ phase }: { phase: InterviewState }) =>
          useInterviewLifecycleEvents({
            ...initialArgs,
            phase,
            sessionId: 'sess-1',
            config: baseConfig,
          }),
        { initialProps: { phase: 'INIT' as InterviewState } },
      )
      rerender({ phase: 'LOBBY' as InterviewState })
      rerender({ phase: 'CALIBRATION' as InterviewState })
      rerender({ phase: 'INTERVIEW_START' as InterviewState })
      expect(trackMock).not.toHaveBeenCalled()
    })

    it('does NOT fire when sessionId is null (mic-permission-denied path)', () => {
      renderHook(() =>
        useInterviewLifecycleEvents({
          ...initialArgs,
          phase: 'ASK_QUESTION',
          sessionId: null,
          config: baseConfig,
        }),
      )
      expect(trackMock).not.toHaveBeenCalled()
    })

    it('fires once with full payload on first transition into ASK_QUESTION', () => {
      const { rerender } = renderHook(
        (args: Args) => useInterviewLifecycleEvents(args),
        { initialProps: { ...initialArgs } },
      )

      rerender({
        ...initialArgs,
        phase: 'INTERVIEW_START',
        sessionId: 'sess-1',
        config: baseConfig,
      })
      expect(trackMock).not.toHaveBeenCalled()

      rerender({
        ...initialArgs,
        phase: 'ASK_QUESTION',
        sessionId: 'sess-1',
        config: baseConfig,
      })

      expect(trackMock).toHaveBeenCalledTimes(1)
      expect(trackMock).toHaveBeenCalledWith('interview_started', {
        session_id: 'sess-1',
        domain: 'swe',
        depth: 'technical',
        duration_minutes: 30,
        experience: '3-6',
      })
    })

    it('SUPPRESSES interview_started after pre-start abandon — Codex P2', () => {
      // User clicks End during CALIBRATION (sessionId already created
      // server-side). markAbandoned() latches the ref synchronously.
      // finishInterview('user_ended') drives state to SCORING.
      // Without the abandon-check on the started gate, SCORING would
      // satisfy "phase not in PRE_START_PHASES" and emit
      // interview_started — inflating the funnel with sessions that
      // never actually began.
      const { result, rerender } = renderHook(
        (args: Args) => useInterviewLifecycleEvents(args),
        {
          initialProps: {
            ...initialArgs,
            phase: 'CALIBRATION' as InterviewState,
            sessionId: 'sess-early',
            config: baseConfig,
          },
        },
      )
      expect(trackMock).not.toHaveBeenCalled()

      act(() => {
        result.current.markAbandoned()
      })
      const startedCalls = () =>
        trackMock.mock.calls.filter(([name]) => name === 'interview_started')
      expect(trackMock.mock.calls.filter(([name]) => name === 'interview_abandoned')).toHaveLength(1)
      expect(startedCalls()).toHaveLength(0)

      rerender({
        ...initialArgs,
        phase: 'SCORING',
        sessionId: 'sess-early',
        config: baseConfig,
      })

      expect(startedCalls()).toHaveLength(0)
    })

    it('does NOT re-fire across subsequent phase transitions', () => {
      const { rerender } = renderHook(
        (args: Args) => useInterviewLifecycleEvents(args),
        {
          initialProps: {
            ...initialArgs,
            phase: 'ASK_QUESTION' as InterviewState,
            sessionId: 'sess-1',
            config: baseConfig,
          },
        },
      )
      expect(trackMock).toHaveBeenCalledTimes(1)

      rerender({
        ...initialArgs,
        phase: 'PROCESSING',
        sessionId: 'sess-1',
        config: baseConfig,
      })
      rerender({
        ...initialArgs,
        phase: 'LISTENING',
        sessionId: 'sess-1',
        config: baseConfig,
      })

      expect(trackMock).toHaveBeenCalledTimes(1)
    })
  })

  describe('interview_completed', () => {
    it('fires once on first transition into SCORING with question_count=questionIndex+1 for general flow (Codex P2)', () => {
      // Setup: phase=ASK_QUESTION first so started fires (the
      // completed gate now requires startedFiredRef per Codex P2
      // round 4).
      const { rerender } = renderHook(
        (args: Args) => useInterviewLifecycleEvents(args),
        {
          initialProps: {
            ...initialArgs,
            phase: 'ASK_QUESTION' as InterviewState,
            sessionId: 'sess-1',
            config: baseConfig,
          },
        },
      )
      trackMock.mockClear()

      // A 6-question general/screening interview reaches SCORING
      // with questionIndex=5 because setQuestionIndex(qIdx) is called
      // at the start of each iteration in useInterview.ts and the
      // final qIdx++ happens after the loop's last setQuestionIndex
      // call. The hook adds 1 to recover the cardinal count.
      rerender({
        phase: 'SCORING',
        sessionId: 'sess-1',
        config: baseConfig,
        questionIndex: 5,
        timeRemaining: 120,
      })

      expect(trackMock).toHaveBeenCalledTimes(1)
      expect(trackMock).toHaveBeenCalledWith('interview_completed', {
        session_id: 'sess-1',
        question_count: 6,
        duration_seconds_elapsed: 30 * 60 - 120,
      })
    })

    it('emits question_count=questionIndex (no +1) for coding flow — Codex P1 round 4', () => {
      // Coding flow uses 1-based questionIndex (useInterview.ts:1922
      // setQuestionIndex(1) at the first problem). React state at
      // SCORING already equals the cardinal count.
      const codingConfig: InterviewConfig = { ...baseConfig, interviewType: 'coding' }
      const { rerender } = renderHook(
        (args: Args) => useInterviewLifecycleEvents(args),
        {
          initialProps: {
            ...initialArgs,
            phase: 'CODE_EDITING' as InterviewState,
            sessionId: 'sess-c',
            config: codingConfig,
          },
        },
      )
      trackMock.mockClear()

      rerender({
        phase: 'SCORING',
        sessionId: 'sess-c',
        config: codingConfig,
        questionIndex: 3,
        timeRemaining: 200,
      })

      expect(trackMock).toHaveBeenCalledWith('interview_completed', expect.objectContaining({
        question_count: 3,
      }))
    })

    it('emits question_count=questionIndex (no +1) for system-design flow — Codex P1 round 4', () => {
      const designConfig: InterviewConfig = { ...baseConfig, interviewType: 'system-design' }
      const { rerender } = renderHook(
        (args: Args) => useInterviewLifecycleEvents(args),
        {
          initialProps: {
            ...initialArgs,
            phase: 'DESIGN_CANVAS' as InterviewState,
            sessionId: 'sess-d',
            config: designConfig,
          },
        },
      )
      trackMock.mockClear()

      rerender({
        phase: 'SCORING',
        sessionId: 'sess-d',
        config: designConfig,
        questionIndex: 2,
        timeRemaining: 300,
      })

      expect(trackMock).toHaveBeenCalledWith('interview_completed', expect.objectContaining({
        question_count: 2,
      }))
    })

    it('SUPPRESSES interview_completed when SCORING is reached without ever entering a real phase — Codex P2 round 4', () => {
      // Idle pre-start time-up: timer expires while still in
      // CALIBRATION → useInterview.ts:520-521 catch-all `else` fires
      // `finishInterview('time_up')` → SCORING. Before this fix, my
      // hook would have emitted interview_completed for an interview
      // that never actually started.
      const { rerender } = renderHook(
        (args: Args) => useInterviewLifecycleEvents(args),
        {
          initialProps: {
            ...initialArgs,
            phase: 'CALIBRATION' as InterviewState,
            sessionId: 'sess-idle',
            config: baseConfig,
          },
        },
      )
      expect(trackMock).not.toHaveBeenCalled()

      // Timer expires from CALIBRATION — useInterview drives
      // straight to SCORING without passing through ASK_QUESTION.
      rerender({
        ...initialArgs,
        phase: 'SCORING',
        sessionId: 'sess-idle',
        config: baseConfig,
        questionIndex: 0,
        timeRemaining: 0,
      })

      expect(trackMock).not.toHaveBeenCalled()
    })

    it('uses SCORING (not FEEDBACK) as the terminal phase — Codex P1', () => {
      // useInterview never transitionTo('FEEDBACK'); it goes to
      // SCORING then router.push('/feedback/...') which unmounts
      // this hook. Asserting we don't accidentally regress to the
      // unreachable FEEDBACK gate. Setup uses ASK_QUESTION so
      // started fires (Codex P2 round 4: completed gate now
      // requires startedFiredRef).
      const { rerender } = renderHook(
        (args: Args) => useInterviewLifecycleEvents(args),
        {
          initialProps: {
            ...initialArgs,
            phase: 'ASK_QUESTION' as InterviewState,
            sessionId: 'sess-1',
            config: baseConfig,
          },
        },
      )
      trackMock.mockClear()

      // Phase reaching FEEDBACK should NOT fire completed.
      rerender({
        phase: 'FEEDBACK',
        sessionId: 'sess-1',
        config: baseConfig,
        questionIndex: 5,
        timeRemaining: 120,
      })

      const completedCalls = trackMock.mock.calls.filter(
        ([name]) => name === 'interview_completed',
      )
      expect(completedCalls).toHaveLength(0)
    })

    it('does NOT re-fire on subsequent renders after SCORING was reached', () => {
      // Setup: ASK_QUESTION → SCORING. ASK_QUESTION fires started,
      // SCORING fires completed (gate now requires startedFiredRef).
      const { rerender } = renderHook(
        (args: Args) => useInterviewLifecycleEvents(args),
        {
          initialProps: {
            ...initialArgs,
            phase: 'ASK_QUESTION' as InterviewState,
            sessionId: 'sess-1',
            config: baseConfig,
            questionIndex: 5,
            timeRemaining: 120,
          },
        },
      )
      rerender({
        ...initialArgs,
        phase: 'SCORING',
        sessionId: 'sess-1',
        config: baseConfig,
        questionIndex: 5,
        timeRemaining: 120,
      })

      const completedCalls = () =>
        trackMock.mock.calls.filter(([name]) => name === 'interview_completed')
      expect(completedCalls()).toHaveLength(1)

      rerender({
        ...initialArgs,
        phase: 'SCORING',
        sessionId: 'sess-1',
        config: baseConfig,
        questionIndex: 5,
        timeRemaining: 120,
      })

      expect(completedCalls()).toHaveLength(1)
    })
  })

  describe('interview_abandoned', () => {
    it('fires synchronously when markAbandoned is called', () => {
      const { result } = renderHook(() =>
        useInterviewLifecycleEvents({
          ...initialArgs,
          phase: 'ASK_QUESTION',
          sessionId: 'sess-1',
          config: baseConfig,
          questionIndex: 3,
          timeRemaining: 600,
        }),
      )
      trackMock.mockClear()

      act(() => {
        result.current.markAbandoned()
      })

      expect(trackMock).toHaveBeenCalledTimes(1)
      expect(trackMock).toHaveBeenCalledWith('interview_abandoned', {
        session_id: 'sess-1',
        q_index_at_abandon: 3,
        time_remaining_at_abandon: 600,
        duration_seconds_elapsed: 30 * 60 - 600,
      })
    })

    it('does NOT fire if sessionId is null', () => {
      const { result } = renderHook(() =>
        useInterviewLifecycleEvents({
          ...initialArgs,
          phase: 'CALIBRATION',
          sessionId: null,
          config: baseConfig,
        }),
      )

      act(() => {
        result.current.markAbandoned()
      })

      expect(trackMock).not.toHaveBeenCalled()
    })

    it('BACKFILLS interview_abandoned when sessionId is stale-null then arrives — Codex P2 round 5', () => {
      // useInterview.ts:2247 exposes sessionId via sessionIdRef.current,
      // and the ref write at useInterview.ts:411 is not paired with a
      // setState. So between session creation and the next unrelated
      // re-render, the page's `interview.sessionId` is stale `null`.
      // If End is clicked in that window:
      //   - markAbandoned latches abandonedFiredRef (round-2 fix —
      //     prevents subsequent SCORING render from firing
      //     interview_completed).
      //   - The click-time payload is stashed in pendingAbandonRef
      //     (round-5 fix — preserves abandon attribution that round 2
      //     would have thrown away).
      //   - The next render that has a fresh sessionId emits
      //     interview_abandoned with the stashed payload, so the
      //     funnel correctly records the user-ended session.
      const { result, rerender } = renderHook(
        (args: Args) => useInterviewLifecycleEvents(args),
        {
          initialProps: {
            ...initialArgs,
            phase: 'CALIBRATION' as InterviewState,
            sessionId: null,
            config: baseConfig,
            questionIndex: 3,
            timeRemaining: 600,
          },
        },
      )

      // User clicks End during the stale-sessionId window. The emit
      // bails because sessionId is null in the closure, but the
      // payload + abandon-latch are captured.
      act(() => {
        result.current.markAbandoned()
      })
      expect(trackMock).not.toHaveBeenCalled()

      // SCORING arrives with a fresh sessionId (transitionTo is a
      // state-setter that refreshes the closure). The useEffect's
      // backfill block emits interview_abandoned with the captured
      // payload + the now-fresh session_id.
      rerender({
        phase: 'SCORING',
        sessionId: 'sess-late',
        config: baseConfig,
        // Drift: by the time SCORING lands the timer has continued
        // ticking. The backfill MUST emit the click-time values
        // (q=3 / t=600), not the SCORING-time values, so funnel
        // attribution stays accurate to the moment of intent.
        questionIndex: 5,
        timeRemaining: 0,
      })

      const abandonedCalls = trackMock.mock.calls.filter(
        ([name]) => name === 'interview_abandoned',
      )
      expect(abandonedCalls).toHaveLength(1)
      expect(abandonedCalls[0]).toEqual([
        'interview_abandoned',
        {
          session_id: 'sess-late',
          q_index_at_abandon: 3,
          time_remaining_at_abandon: 600,
          duration_seconds_elapsed: 30 * 60 - 600,
        },
      ])

      // interview_completed is still suppressed (round-2 mechanic).
      const completedCalls = trackMock.mock.calls.filter(
        ([name]) => name === 'interview_completed',
      )
      expect(completedCalls).toHaveLength(0)
    })

    it('does NOT backfill if sessionId never arrives (genuinely sessionless abandon)', () => {
      const { result, rerender } = renderHook(
        (args: Args) => useInterviewLifecycleEvents(args),
        {
          initialProps: {
            ...initialArgs,
            phase: 'CALIBRATION' as InterviewState,
            sessionId: null,
            config: baseConfig,
          },
        },
      )

      act(() => {
        result.current.markAbandoned()
      })

      // sessionId never arrives — re-render with phase=ENDED but
      // sessionId still null (e.g., mic-permission-denied path).
      rerender({
        ...initialArgs,
        phase: 'ENDED',
        sessionId: null,
        config: baseConfig,
      })

      expect(trackMock).not.toHaveBeenCalled()
    })

    it('is idempotent — second markAbandoned() call is a no-op', () => {
      const { result } = renderHook(() =>
        useInterviewLifecycleEvents({
          ...initialArgs,
          phase: 'ASK_QUESTION',
          sessionId: 'sess-1',
          config: baseConfig,
        }),
      )

      act(() => {
        result.current.markAbandoned()
        result.current.markAbandoned()
        result.current.markAbandoned()
      })

      expect(
        trackMock.mock.calls.filter(([name]) => name === 'interview_abandoned'),
      ).toHaveLength(1)
    })

    it('SUPPRESSES interview_completed when SCORING transition follows abandon', () => {
      const { result, rerender } = renderHook(
        (args: Args) => useInterviewLifecycleEvents(args),
        {
          initialProps: {
            ...initialArgs,
            phase: 'ASK_QUESTION' as InterviewState,
            sessionId: 'sess-1',
            config: baseConfig,
            questionIndex: 3,
            timeRemaining: 600,
          },
        },
      )
      trackMock.mockClear()

      act(() => {
        result.current.markAbandoned()
      })
      expect(trackMock).toHaveBeenCalledTimes(1)
      expect(trackMock).toHaveBeenCalledWith('interview_abandoned', expect.any(Object))

      rerender({
        ...initialArgs,
        phase: 'SCORING',
        sessionId: 'sess-1',
        config: baseConfig,
        questionIndex: 3,
        timeRemaining: 600,
      })

      expect(
        trackMock.mock.calls.filter(([name]) => name === 'interview_completed'),
      ).toHaveLength(0)
    })
  })

  describe('payload edge cases', () => {
    it('falls back to "unknown" / "screening" when config fields are missing', () => {
      const sparseConfig = { role: '', interviewType: undefined, experience: '0-2' as const, duration: 0 }
      renderHook(() =>
        useInterviewLifecycleEvents({
          ...initialArgs,
          phase: 'ASK_QUESTION',
          sessionId: 'sess-x',
          config: sparseConfig,
        }),
      )
      expect(trackMock).toHaveBeenCalledWith('interview_started', {
        session_id: 'sess-x',
        domain: 'unknown',
        depth: 'screening',
        duration_minutes: 0,
        experience: '0-2',
      })
    })

    it('clamps duration_seconds_elapsed at 0 (defensive — timer should never overshoot)', () => {
      const { result } = renderHook(() =>
        useInterviewLifecycleEvents({
          ...initialArgs,
          phase: 'ASK_QUESTION',
          sessionId: 'sess-1',
          config: baseConfig,
          timeRemaining: 99999,
        }),
      )

      act(() => {
        result.current.markAbandoned()
      })

      expect(trackMock).toHaveBeenCalledWith('interview_abandoned', expect.objectContaining({
        duration_seconds_elapsed: 0,
      }))
    })
  })
})
