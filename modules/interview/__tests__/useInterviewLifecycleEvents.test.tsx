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
    it('does NOT fire while phase is in {INIT, LOBBY, CALIBRATION}', () => {
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
      expect(trackMock).not.toHaveBeenCalled()
    })

    it('does NOT fire when sessionId is null (mic-permission-denied path)', () => {
      renderHook(() =>
        useInterviewLifecycleEvents({
          ...initialArgs,
          phase: 'INTERVIEW_START',
          sessionId: null,
          config: baseConfig,
        }),
      )
      expect(trackMock).not.toHaveBeenCalled()
    })

    it('fires once with full payload on first transition past CALIBRATION', () => {
      const { rerender } = renderHook(
        (args: Args) => useInterviewLifecycleEvents(args),
        { initialProps: { ...initialArgs } },
      )

      rerender({
        ...initialArgs,
        phase: 'CALIBRATION',
        sessionId: 'sess-1',
        config: baseConfig,
      })
      expect(trackMock).not.toHaveBeenCalled()

      rerender({
        ...initialArgs,
        phase: 'INTERVIEW_START',
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
            phase: 'INTERVIEW_START' as InterviewState,
            sessionId: 'sess-1',
            config: baseConfig,
          },
        },
      )
      expect(trackMock).toHaveBeenCalledTimes(1)

      rerender({
        ...initialArgs,
        phase: 'ASK_QUESTION',
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
    it('fires once on first transition into SCORING with question_count=questionIndex+1 (Codex P2)', () => {
      const { rerender } = renderHook(
        (args: Args) => useInterviewLifecycleEvents(args),
        {
          initialProps: {
            ...initialArgs,
            phase: 'INTERVIEW_START' as InterviewState,
            sessionId: 'sess-1',
            config: baseConfig,
          },
        },
      )
      trackMock.mockClear()

      // A 6-question interview reaches SCORING with questionIndex=5
      // because setQuestionIndex(qIdx) is called at the start of each
      // iteration in useInterview.ts and the final qIdx++ happens
      // after the loop's last setQuestionIndex call. The hook adds 1
      // to recover the cardinal count.
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

    it('uses SCORING (not FEEDBACK) as the terminal phase — Codex P1', () => {
      // useInterview never transitionTo('FEEDBACK'); it goes to
      // SCORING then router.push('/feedback/...') which unmounts
      // this hook. Asserting we don't accidentally regress to the
      // unreachable FEEDBACK gate.
      const { rerender } = renderHook(
        (args: Args) => useInterviewLifecycleEvents(args),
        {
          initialProps: {
            ...initialArgs,
            phase: 'INTERVIEW_START' as InterviewState,
            sessionId: 'sess-1',
            config: baseConfig,
          },
        },
      )
      trackMock.mockClear()

      // Phase reaching FEEDBACK should NOT fire — that's not a
      // reachable phase in production.
      rerender({
        phase: 'FEEDBACK',
        sessionId: 'sess-1',
        config: baseConfig,
        questionIndex: 5,
        timeRemaining: 120,
      })

      // FEEDBACK is past the pre-start gate so interview_started
      // fires, but interview_completed does NOT.
      const completedCalls = trackMock.mock.calls.filter(
        ([name]) => name === 'interview_completed',
      )
      expect(completedCalls).toHaveLength(0)
    })

    it('does NOT re-fire on subsequent renders after SCORING was reached', () => {
      const { rerender } = renderHook(
        (args: Args) => useInterviewLifecycleEvents(args),
        {
          initialProps: {
            ...initialArgs,
            phase: 'SCORING' as InterviewState,
            sessionId: 'sess-1',
            config: baseConfig,
            questionIndex: 5,
            timeRemaining: 120,
          },
        },
      )
      // Initial mount with phase=SCORING fires BOTH interview_started
      // (SCORING is past the pre-start gate) AND interview_completed.
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

    it('STILL latches abandonedFiredRef when sessionId is stale-null — Codex P1', () => {
      // useInterview.ts:2247 exposes sessionId via `sessionIdRef.current`,
      // and the ref write at useInterview.ts:411 is not paired with a
      // setState. So between session creation and the next unrelated
      // re-render, the page's `interview.sessionId` is stale `null`.
      // If End is clicked in that window the closure sees null.
      // We must STILL latch abandonedFiredRef so the subsequent
      // SCORING transition (with its now-fresh sessionId) doesn't
      // misclassify the abandon as completed.
      const { result, rerender } = renderHook(
        (args: Args) => useInterviewLifecycleEvents(args),
        {
          initialProps: {
            ...initialArgs,
            phase: 'INTERVIEW_START' as InterviewState,
            sessionId: null,
            config: baseConfig,
          },
        },
      )

      // User clicks End during the stale-sessionId window.
      act(() => {
        result.current.markAbandoned()
      })
      expect(trackMock).not.toHaveBeenCalled()

      // SCORING arrives — and so does the now-fresh sessionId, because
      // transitionTo('SCORING') itself is a state-setter that
      // refreshes the closure.
      rerender({
        phase: 'SCORING',
        sessionId: 'sess-late',
        config: baseConfig,
        questionIndex: 3,
        timeRemaining: 600,
      })

      // The interview_started event is allowed (we just learned the
      // sessionId) but interview_completed must NOT fire — the abandon
      // latch is the only guarantee distinguishing user-ended from
      // natural completion.
      const completedCalls = trackMock.mock.calls.filter(
        ([name]) => name === 'interview_completed',
      )
      expect(completedCalls).toHaveLength(0)
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
          phase: 'INTERVIEW_START',
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
