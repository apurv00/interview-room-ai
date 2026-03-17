import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { renderHook, act } from '@testing-library/react'
import {
  AnswerEvaluationSchema,
  GenerateQuestionSchema,
  EvaluateAnswerSchema,
} from '@interview/validators/interview'

// ─── Mocks (must be before import) ──────────────────────────────────────────

const mockPush = vi.fn()
vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: mockPush }),
}))

vi.mock('@shared/fetchWithRetry', () => ({
  fetchWithRetry: vi.fn().mockResolvedValue(true),
}))

vi.mock('@interview/config/coachingTips', () => ({
  deriveCoachingTip: vi.fn().mockReturnValue('Good job!'),
}))

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

class MockUtterance {
  text: string
  voice: null = null
  rate = 1
  pitch = 1
  volume = 1
  onend: (() => void) | null = null
  onerror: (() => void) | null = null
  constructor(text: string) { this.text = text }
}
vi.stubGlobal('SpeechSynthesisUtterance', MockUtterance)

import { useInterview } from '../hooks/useInterview'
import type { InterviewConfig } from '@shared/types'

// ─── Helpers ────────────────────────────────────────────────────────────────

const baseConfig: InterviewConfig = {
  role: 'SWE',
  experience: '3-6',
  duration: 10,
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

// ─── Backward Compatibility Tests ───────────────────────────────────────────

describe('Backward Compatibility', () => {
  describe('Old evaluation format (no probeDecision/pushback)', () => {
    it('AnswerEvaluationSchema accepts old format without probeDecision', () => {
      const result = AnswerEvaluationSchema.safeParse({
        questionIndex: 0,
        question: 'Tell me about yourself',
        answer: 'I am a developer...',
        relevance: 70,
        structure: 65,
        specificity: 60,
        ownership: 75,
        needsFollowUp: true,
        followUpQuestion: 'Can you elaborate?',
        flags: ['Generic answer'],
      })
      expect(result.success).toBe(true)
    })

    it('AnswerEvaluationSchema accepts old format without pushback', () => {
      const result = AnswerEvaluationSchema.safeParse({
        questionIndex: 1,
        question: 'Describe a challenge',
        answer: 'There was this time...',
        relevance: 80,
        structure: 75,
        specificity: 70,
        ownership: 85,
        needsFollowUp: false,
        flags: [],
      })
      expect(result.success).toBe(true)
    })
  })

  describe('Old GenerateQuestionSchema format', () => {
    it('accepts old format without performanceSignal, lastThreadSummary, completedThreads', () => {
      const result = GenerateQuestionSchema.safeParse({
        config: {
          role: 'PM',
          experience: '0-2',
          duration: 20,
        },
        questionIndex: 3,
        previousQA: [
          { speaker: 'interviewer', text: 'Q1', timestamp: 1000 },
          { speaker: 'candidate', text: 'A1', timestamp: 2000 },
        ],
      })
      expect(result.success).toBe(true)
    })

    it('accepts config without interviewType (defaults to screening)', () => {
      const result = GenerateQuestionSchema.safeParse({
        config: {
          role: 'SWE',
          experience: '7+',
          duration: 30,
        },
        questionIndex: 0,
        previousQA: [],
      })
      expect(result.success).toBe(true)
      if (result.success) {
        expect(result.data.config.interviewType).toBe('screening')
      }
    })
  })

  describe('Old EvaluateAnswerSchema format', () => {
    it('accepts old format without probeDepth', () => {
      const result = EvaluateAnswerSchema.safeParse({
        config: {
          role: 'SWE',
          experience: '3-6',
          duration: 20,
        },
        question: 'Tell me about...',
        answer: 'I once had to...',
        questionIndex: 2,
      })
      expect(result.success).toBe(true)
    })
  })
})

// ─── Existing Flow Preserved ────────────────────────────────────────────────

describe('Existing Flow Preserved', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.clearAllMocks()
    localStorage.clear()

    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({
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

  it('starts with INTERVIEW_START phase', () => {
    const { result } = renderHook(() => useInterview(makeOptions()))
    expect(result.current.phase).toBe('INTERVIEW_START')
  })

  it('starts with friendly avatar emotion', () => {
    const { result } = renderHook(() => useInterview(makeOptions()))
    expect(result.current.avatarEmotion).toBe('friendly')
  })

  it('timer counts down correctly', () => {
    const { result } = renderHook(() => useInterview(makeOptions()))
    expect(result.current.timeRemaining).toBe(600) // 10 min * 60
    act(() => { vi.advanceTimersByTime(5000) })
    expect(result.current.timeRemaining).toBe(595)
  })

  it('finishInterview transitions to SCORING', async () => {
    const { result } = renderHook(() => useInterview(makeOptions()))
    await act(async () => {
      result.current.finishInterview()
      await vi.advanceTimersByTimeAsync(100)
    })
    expect(result.current.phase).toBe('SCORING')
  })

  it('finishInterview persists data to localStorage', async () => {
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

  it('navigates to feedback page on finish', async () => {
    const { result } = renderHook(() => useInterview(makeOptions()))
    await act(async () => { await vi.advanceTimersByTimeAsync(100) })
    await act(async () => {
      result.current.finishInterview()
      await vi.advanceTimersByTimeAsync(4000)
    })
    expect(mockPush).toHaveBeenCalledWith('/feedback/test-session-123')
  })

  it('cancels speech on finish', async () => {
    const { result } = renderHook(() => useInterview(makeOptions()))
    await act(async () => {
      result.current.finishInterview()
      await vi.advanceTimersByTimeAsync(100)
    })
    expect(mockCancel).toHaveBeenCalled()
  })

  it('returns null coachingTip initially', () => {
    const { result } = renderHook(() => useInterview(makeOptions()))
    expect(result.current.coachingTip).toBeNull()
  })

  it('returns 0 questionIndex initially', () => {
    const { result } = renderHook(() => useInterview(makeOptions()))
    expect(result.current.questionIndex).toBe(0)
  })

  it('starts speaking when voicesReady becomes true', async () => {
    renderHook(() => useInterview(makeOptions({ voicesReady: true })))
    await act(async () => { await vi.advanceTimersByTimeAsync(600) })
    expect(mockSpeak).toHaveBeenCalled()
  })
})
