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
import { STORAGE_KEYS } from '@shared/storageKeys'

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

  it('sends combined Jobs-retake intent only to session creation and clears both transports', async () => {
    const jobsConfig: InterviewConfig = {
      ...baseConfig,
      jobDescription: 'A server-issued job description',
      attribution: {
        source: 'jobs',
        jobId: '507f1f77bcf86cd799439011',
      },
    }
    localStorage.setItem(STORAGE_KEYS.INTERVIEW_CONFIG, JSON.stringify({
      ...jobsConfig,
      jobsHandoffToken: 'signed-jobs-token',
    }))
    localStorage.setItem(
      STORAGE_KEYS.PENDING_RETAKE_PARENT,
      '507f1f77bcf86cd799439012'
    )
    ;(global.fetch as ReturnType<typeof vi.fn>).mockImplementation(async (url: string) => {
      if (url.startsWith('/api/jobs/')) {
        return {
          ok: true,
          json: () => Promise.resolve({ practiceHandoffToken: 'fresh-jobs-token' }),
        }
      }
      return {
        ok: true,
        json: () => Promise.resolve({
          sessionId: 'test-session-123',
          question: 'Tell me about a challenge you faced.',
        }),
      }
    })

    renderHook(() => useInterview(makeOptions({
      config: jobsConfig,
      jobsHandoffToken: 'signed-jobs-token',
    })))

    await act(async () => {
      await vi.advanceTimersByTimeAsync(0)
    })

    const createCall = (global.fetch as ReturnType<typeof vi.fn>).mock.calls.find(
      ([url]) => url === '/api/interviews'
    )
    expect(createCall).toBeDefined()
    const body = JSON.parse((createCall?.[1] as RequestInit).body as string)
    expect(global.fetch).toHaveBeenCalledWith(
      '/api/jobs/507f1f77bcf86cd799439011',
      { cache: 'no-store' },
    )
    expect(body.jobsHandoffToken).toBe('fresh-jobs-token')
    expect(body.parentSessionId).toBe('507f1f77bcf86cd799439012')
    expect(body.config).not.toHaveProperty('jobsHandoffToken')
    expect(JSON.parse(localStorage.getItem(STORAGE_KEYS.INTERVIEW_CONFIG) || '{}')).not.toHaveProperty(
      'jobsHandoffToken'
    )
    expect(localStorage.getItem(STORAGE_KEYS.PENDING_RETAKE_PARENT)).toBeNull()
  })

  it('starts a scrubbed Jobs fallback as new general practice without false lineage', async () => {
    const generalConfig: InterviewConfig = {
      ...baseConfig,
      interviewType: 'behavioral',
      resumeText: 'Candidate-owned resume',
      resumeFileName: 'resume.pdf',
    }

    renderHook(() => useInterview(makeOptions({ config: generalConfig })))

    await act(async () => {
      await vi.advanceTimersByTimeAsync(0)
    })

    const createCall = (global.fetch as ReturnType<typeof vi.fn>).mock.calls.find(
      ([url]) => url === '/api/interviews'
    )
    const body = JSON.parse((createCall?.[1] as RequestInit).body as string)
    expect(body.config).toMatchObject({
      role: 'SWE',
      resumeText: 'Candidate-owned resume',
      resumeFileName: 'resume.pdf',
    })
    expect(body).not.toHaveProperty('parentSessionId')
    expect(body).not.toHaveProperty('jobsHandoffToken')
    expect(body.config).not.toHaveProperty('jobDescription')
    expect(body.config).not.toHaveProperty('attribution')
  })

  it('handles DB session creation failure gracefully', async () => {
    localStorage.setItem(
      STORAGE_KEYS.PENDING_RETAKE_PARENT,
      '507f1f77bcf86cd799439012'
    )
    ;(global.fetch as ReturnType<typeof vi.fn>).mockRejectedValueOnce(new Error('Network'))

    const { result } = renderHook(() => useInterview(makeOptions()))

    await act(async () => {
      await vi.advanceTimersByTimeAsync(100)
    })

    // Should not throw — sessionId stays null
    expect(result.current.sessionId).toBeNull()
    // The next reload can retry the same lineage after a transient failure.
    expect(localStorage.getItem(STORAGE_KEYS.PENDING_RETAKE_PARENT)).toBe(
      '507f1f77bcf86cd799439012'
    )
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

  it('surfaces an invalid Jobs handoff distinctly and returns to that posting', async () => {
    ;(global.fetch as ReturnType<typeof vi.fn>).mockImplementation(async (url: string) => {
      if (url.startsWith('/api/jobs/')) {
        return {
          ok: true,
          json: () => Promise.resolve({ practiceHandoffToken: 'refreshed-but-stale-token' }),
        }
      }
      if (url === '/api/interviews') {
        return {
          ok: false,
          status: 409,
          json: () => Promise.resolve({
            code: 'JOBS_HANDOFF_INVALID',
            error: 'This job practice link expired or changed.',
          }),
        }
      }
      return {
        ok: true,
        json: () => Promise.resolve({ question: 'Tell me about a challenge you faced.' }),
      }
    })
    const jobsConfig: InterviewConfig = {
      ...baseConfig,
      attribution: { source: 'jobs', jobId: '507f1f77bcf86cd799439011' },
    }

    const { result } = renderHook(() => useInterview(makeOptions({
      config: jobsConfig,
      jobsHandoffToken: 'expired-token',
    })))

    await act(async () => {
      await vi.advanceTimersByTimeAsync(100)
    })

    expect(result.current.phase).toBe('ENDED')
    expect(result.current.currentQuestion).toContain('expired or changed')
    expect(result.current.coachingTip).toContain('job posting')

    await act(async () => {
      await vi.advanceTimersByTimeAsync(4000)
    })
    expect(mockPush).toHaveBeenCalledWith('/jobs/507f1f77bcf86cd799439011')
  })

  it('keeps STATUS notices visible even when live coaching is disabled (Codex P2)', async () => {
    // The `coachingTip` channel is shared between silenceable coaching tips and
    // non-silenceable status notices. With the in-room switch OFF, status
    // notices (here: usage-limit) must still surface — only coaching tips are
    // gated. Regression guard for the Codex re-review finding on PR #459.
    ;(global.fetch as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      ok: false,
      status: 402,
      json: () => Promise.resolve({ error: 'Monthly interview limit reached' }),
    })

    const { result } = renderHook(() => useInterview(makeOptions({ liveCoachingEnabled: false })))

    await act(async () => {
      await vi.advanceTimersByTimeAsync(100)
    })

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
