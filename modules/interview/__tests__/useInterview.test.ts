import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { renderHook, act } from '@testing-library/react'

// ─── Mocks (must be before import) ──────────────────────────────────────────

const mockPush = vi.fn()
vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: mockPush }),
}))

vi.mock('@shared/fetchWithRetry', () => ({
  fetchWithRetry: vi.fn().mockResolvedValue(true),
}))

vi.mock('@interview/config/coachingTips', () => ({
  deriveCoachingTip: vi.fn().mockReturnValue('Great answer! Keep that energy.'),
}))

// Mock SpeechSynthesis globally
const mockSpeak = vi.fn()
const mockCancel = vi.fn()
const mockGetVoices = vi.fn().mockReturnValue([])

Object.defineProperty(window, 'speechSynthesis', {
  value: {
    speak: mockSpeak,
    cancel: mockCancel,
    getVoices: mockGetVoices,
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
  },
  writable: true,
})

// Mock SpeechSynthesisUtterance
class MockUtterance {
  text: string
  voice: null = null
  rate = 1
  pitch = 1
  volume = 1
  onend: (() => void) | null = null
  onerror: (() => void) | null = null

  constructor(text: string) {
    this.text = text
  }
}
vi.stubGlobal('SpeechSynthesisUtterance', MockUtterance)

import { useInterview } from '../hooks/useInterview'
import type { InterviewConfig } from '@shared/types'
import { fetchWithRetry } from '@shared/fetchWithRetry'
import { deriveCoachingTip } from '@interview/config/coachingTips'

// ─── Helpers ────────────────────────────────────────────────────────────────

const baseConfig: InterviewConfig = {
  role: 'SWE',
  experience: '3-6',
  duration: 5,
}

function makeOptions(overrides: Partial<Parameters<typeof useInterview>[0]> = {}) {
  return {
    config: baseConfig,
    voicesReady: false,
    startListening: vi.fn(),
    stopListening: vi.fn(),
    onRecordingStop: vi.fn(),
    ...overrides,
  }
}

// Helper to trigger SpeechSynthesis onend
function completeSpeech() {
  const lastCall = mockSpeak.mock.calls[mockSpeak.mock.calls.length - 1]
  if (lastCall) {
    const utterance = lastCall[0] as MockUtterance
    utterance.onend?.()
  }
}

// ─── Tests ──────────────────────────────────────────────────────────────────

describe('useInterview', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.clearAllMocks()
    localStorage.clear()

    // Default: fetch always succeeds with a question
    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: () =>
        Promise.resolve({
          sessionId: 'test-session-123',
          question: 'Tell me about a challenge you faced.',
          relevance: 80,
          structure: 75,
          specificity: 70,
          ownership: 80,
          needsFollowUp: false,
          flags: [],
        }),
    })
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  // ── Initial state ──

  it('starts with INTERVIEW_START phase', () => {
    const { result } = renderHook(() => useInterview(makeOptions()))
    expect(result.current.phase).toBe('INTERVIEW_START')
  })

  it('returns friendly avatar emotion initially', () => {
    const { result } = renderHook(() => useInterview(makeOptions()))
    expect(result.current.avatarEmotion).toBe('friendly')
  })

  it('returns empty currentQuestion initially', () => {
    const { result } = renderHook(() => useInterview(makeOptions()))
    expect(result.current.currentQuestion).toBe('')
  })

  it('returns 0 for questionIndex initially', () => {
    const { result } = renderHook(() => useInterview(makeOptions()))
    expect(result.current.questionIndex).toBe(0)
  })

  // ── Timer ──

  it('initializes timeRemaining from config duration', () => {
    const { result } = renderHook(() => useInterview(makeOptions()))
    expect(result.current.timeRemaining).toBe(300) // 5 min * 60
  })

  it('counts down timer every second', () => {
    const { result } = renderHook(() => useInterview(makeOptions()))
    act(() => {
      vi.advanceTimersByTime(3000)
    })
    expect(result.current.timeRemaining).toBe(297)
  })

  it('does not go below 0', () => {
    const opts = makeOptions({ config: { ...baseConfig, duration: 5 } })
    const { result } = renderHook(() => useInterview(opts))
    act(() => {
      vi.advanceTimersByTime(400_000) // way more than 5 min
    })
    expect(result.current.timeRemaining).toBe(0)
  })

  // ── DB session creation ──

  it('calls fetch to create DB session on mount', async () => {
    renderHook(() => useInterview(makeOptions()))

    // Flush promises for createDbSession
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0)
    })

    expect(global.fetch).toHaveBeenCalledWith('/api/interviews', expect.objectContaining({
      method: 'POST',
    }))
  })

  it('handles DB session creation failure gracefully', async () => {
    ;(global.fetch as ReturnType<typeof vi.fn>).mockRejectedValueOnce(new Error('Network'))

    const { result } = renderHook(() => useInterview(makeOptions()))

    await act(async () => {
      await vi.advanceTimersByTimeAsync(100)
    })

    // Should not throw — sessionId stays null
    expect(result.current.sessionId).toBeNull()
  })

  it('ends interview immediately when monthly usage limit is reached', async () => {
    ;(global.fetch as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      ok: false,
      status: 402,
      json: () => Promise.resolve({ error: 'Monthly interview limit reached' }),
    })

    const { result } = renderHook(() => useInterview(makeOptions()))

    await act(async () => {
      await vi.advanceTimersByTimeAsync(100)
    })

    expect(result.current.phase).toBe('ENDED')
    expect(result.current.currentQuestion).toContain('Monthly interview limit reached')
    expect(result.current.coachingTip).toContain('monthly interview limit')
  })

  // ── No config ──

  it('does not start timer when config is null', () => {
    const { result } = renderHook(() => useInterview(makeOptions({ config: null })))
    expect(result.current.timeRemaining).toBe(0)
    act(() => {
      vi.advanceTimersByTime(5000)
    })
    expect(result.current.timeRemaining).toBe(0)
  })

  // ── Interview start ──

  it('does not start interview loop when voicesReady is false', async () => {
    renderHook(() => useInterview(makeOptions({ voicesReady: false })))

    await act(async () => {
      await vi.advanceTimersByTimeAsync(1000)
    })

    // Speech should not be triggered
    expect(mockSpeak).not.toHaveBeenCalled()
  })

  it('starts avatar speaking when config and voices are ready', async () => {
    renderHook(() => useInterview(makeOptions({ voicesReady: true })))

    // The start() function has a 500ms delay
    await act(async () => {
      await vi.advanceTimersByTimeAsync(600)
    })

    expect(mockSpeak).toHaveBeenCalled()
    const utterance = mockSpeak.mock.calls[0][0] as MockUtterance
    // Should be the SWE intro
    expect(utterance.text).toContain('Alex')
  })

  // ── finishInterview ──

  it('transitions to SCORING phase when finishInterview is called', async () => {
    const { result } = renderHook(() => useInterview(makeOptions()))

    await act(async () => {
      result.current.finishInterview()
      await vi.advanceTimersByTimeAsync(100)
    })

    expect(result.current.phase).toBe('SCORING')
  })

  it('cancels speech synthesis on finish', async () => {
    const { result } = renderHook(() => useInterview(makeOptions()))

    await act(async () => {
      result.current.finishInterview()
      await vi.advanceTimersByTimeAsync(100)
    })

    expect(mockCancel).toHaveBeenCalled()
  })

  it('calls stopListening on finish', async () => {
    const stopListening = vi.fn()
    const { result } = renderHook(() => useInterview(makeOptions({ stopListening })))

    await act(async () => {
      result.current.finishInterview()
      await vi.advanceTimersByTimeAsync(100)
    })

    expect(stopListening).toHaveBeenCalled()
  })

  it('calls onRecordingStop on finish', async () => {
    const onRecordingStop = vi.fn()
    const { result } = renderHook(() => useInterview(makeOptions({ onRecordingStop })))

    await act(async () => {
      result.current.finishInterview()
      await vi.advanceTimersByTimeAsync(100)
    })

    expect(onRecordingStop).toHaveBeenCalled()
  })

  // Race regression: /api/analysis/start fired before the recording
  // upload PATCHed audioRecordingR2Key onto the session, so the server
  // returned 400 ("Session has no audio to transcribe"). Multimodal
  // analysis never started. The fix captures onRecordingStop()'s
  // returned promise and gates the analysis fetch on it resolving.
  it('does not fire /api/analysis/start until onRecordingStop promise resolves', async () => {
    const originalFlag = process.env.NEXT_PUBLIC_FEATURE_MULTIMODAL
    process.env.NEXT_PUBLIC_FEATURE_MULTIMODAL = 'true'

    try {
      let resolveRecording: () => void = () => {}
      const recordingStopPromise = new Promise<void>((res) => {
        resolveRecording = res
      })
      const onRecordingStop = vi.fn(() => recordingStopPromise)

      const { result } = renderHook(() =>
        useInterview(makeOptions({ onRecordingStop })),
      )

      // Wait for initial session creation
      await act(async () => {
        await vi.advanceTimersByTimeAsync(100)
      })

      // finishInterview + drain the ~3s pendingEvalRef race and the
      // localStorage path. The onRecordingStop promise is still
      // unresolved, so analysis/start must NOT have fired.
      await act(async () => {
        result.current.finishInterview()
        await vi.advanceTimersByTimeAsync(5000)
      })

      const fetchMock = global.fetch as ReturnType<typeof vi.fn>
      const analysisStartBefore = fetchMock.mock.calls.some(
        (call) => call[0] === '/api/analysis/start',
      )
      expect(analysisStartBefore).toBe(false)

      // generate-feedback does NOT depend on the recording upload —
      // it should have fired already (transcript-only payload).
      const feedbackBefore = fetchMock.mock.calls.some(
        (call) => call[0] === '/api/generate-feedback',
      )
      expect(feedbackBefore).toBe(true)

      // Now resolve the recording upload — analysis/start must fire.
      await act(async () => {
        resolveRecording()
        await vi.advanceTimersByTimeAsync(50)
      })

      const analysisStartAfter = fetchMock.mock.calls.some(
        (call) => call[0] === '/api/analysis/start',
      )
      expect(analysisStartAfter).toBe(true)
    } finally {
      process.env.NEXT_PUBLIC_FEATURE_MULTIMODAL = originalFlag
    }
  })

  it('persists data to localStorage on finish', async () => {
    const { result } = renderHook(() => useInterview(makeOptions()))

    await act(async () => {
      result.current.finishInterview()
      await vi.advanceTimersByTimeAsync(4000)
    })

    const stored = localStorage.getItem('interviewData')
    expect(stored).not.toBeNull()
    const parsed = JSON.parse(stored!)
    expect(parsed).toHaveProperty('config')
    expect(parsed).toHaveProperty('transcript')
    expect(parsed).toHaveProperty('evaluations')
    expect(parsed).toHaveProperty('speechMetrics')
  })

  it('navigates to /feedback/local when no DB session', async () => {
    // Make createDbSession return null
    ;(global.fetch as ReturnType<typeof vi.fn>).mockResolvedValue({
      ok: false,
      json: () => Promise.resolve({}),
    })

    const { result } = renderHook(() => useInterview(makeOptions()))

    await act(async () => {
      await vi.advanceTimersByTimeAsync(100)
    })

    await act(async () => {
      result.current.finishInterview()
      await vi.advanceTimersByTimeAsync(4000)
    })

    expect(mockPush).toHaveBeenCalledWith('/feedback/local')
  })

  it('navigates to /feedback/:sessionId when DB session exists', async () => {
    const { result } = renderHook(() => useInterview(makeOptions()))

    // Wait for session creation
    await act(async () => {
      await vi.advanceTimersByTimeAsync(100)
    })

    await act(async () => {
      result.current.finishInterview()
      await vi.advanceTimersByTimeAsync(4000)
    })

    expect(mockPush).toHaveBeenCalledWith('/feedback/test-session-123')
  })

  // ── Timer auto-finish ──

  it('calls finishInterview when timer reaches 0', async () => {
    const { result } = renderHook(() => useInterview(makeOptions()))

    await act(async () => {
      // Advance past full duration (300s)
      await vi.advanceTimersByTimeAsync(301_000)
    })

    expect(result.current.phase).toBe('SCORING')
  })

  // ── Coaching tip ──

  it('returns null coachingTip initially', () => {
    const { result } = renderHook(() => useInterview(makeOptions()))
    expect(result.current.coachingTip).toBeNull()
  })

  // ── isAvatarTalking ──

  it('returns false for isAvatarTalking initially', () => {
    const { result } = renderHook(() => useInterview(makeOptions()))
    expect(result.current.isAvatarTalking).toBe(false)
  })

  // ── liveAnswer ──

  it('returns empty liveAnswer initially', () => {
    const { result } = renderHook(() => useInterview(makeOptions()))
    expect(result.current.liveAnswer).toBe('')
  })
})
