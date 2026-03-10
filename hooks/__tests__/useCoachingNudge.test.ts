import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { renderHook, act } from '@testing-library/react'
import { useCoachingNudge } from '../useCoachingNudge'

// ─── Mocks ────────────────────────────────────────────────────────────────────

vi.mock('@/lib/speechMetrics', () => ({
  analyzeSpeech: vi.fn(),
}))

vi.mock('@/lib/coachingNudges', () => ({
  deriveNudge: vi.fn(),
}))

import { analyzeSpeech } from '@/lib/speechMetrics'
import { deriveNudge } from '@/lib/coachingNudges'
import type { SpeechMetrics } from '@/lib/types'

const mockAnalyzeSpeech = vi.mocked(analyzeSpeech)
const mockDeriveNudge = vi.mocked(deriveNudge)

const defaultMetrics: SpeechMetrics = {
  wpm: 140,
  fillerRate: 0.02,
  pauseScore: 80,
  ramblingIndex: 0.1,
  totalWords: 50,
  fillerWordCount: 1,
  durationMinutes: 0.5,
}

const slowDownNudge = {
  id: 'slow-down',
  message: 'Slow down — you\'re speaking quickly',
  type: 'pace' as const,
  severity: 'warning' as const,
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('useCoachingNudge', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    mockAnalyzeSpeech.mockReturnValue(defaultMetrics)
    mockDeriveNudge.mockReturnValue(null)
  })

  afterEach(() => {
    vi.useRealTimers()
    vi.clearAllMocks()
  })

  it('returns null when not in LISTENING phase', () => {
    const { result } = renderHook(() =>
      useCoachingNudge({ phase: 'ASK_QUESTION', liveTranscript: '' })
    )
    act(() => { vi.advanceTimersByTime(8000) })
    expect(result.current).toBeNull()
    expect(mockDeriveNudge).not.toHaveBeenCalled()
  })

  it('returns null initially during LISTENING with no transcript', () => {
    const { result } = renderHook(() =>
      useCoachingNudge({ phase: 'LISTENING', liveTranscript: '' })
    )
    act(() => { vi.advanceTimersByTime(4000) })
    // transcript is empty — deriveNudge should not run
    expect(result.current).toBeNull()
  })

  it('returns null if deriveNudge returns null', () => {
    mockDeriveNudge.mockReturnValue(null)
    const { result } = renderHook(() =>
      useCoachingNudge({ phase: 'LISTENING', liveTranscript: 'some words here' })
    )
    act(() => { vi.advanceTimersByTime(4000) })
    expect(result.current).toBeNull()
  })

  it('shows nudge when deriveNudge returns one after poll interval', () => {
    mockDeriveNudge.mockReturnValue(slowDownNudge)
    const { result } = renderHook(() =>
      useCoachingNudge({ phase: 'LISTENING', liveTranscript: 'some long transcript text here' })
    )
    act(() => { vi.advanceTimersByTime(4000) })
    expect(result.current).toEqual(slowDownNudge)
  })

  it('auto-dismisses nudge after NUDGE_DISPLAY_MS (5000ms)', () => {
    mockDeriveNudge.mockReturnValue(slowDownNudge)
    const { result } = renderHook(() =>
      useCoachingNudge({ phase: 'LISTENING', liveTranscript: 'transcript' })
    )
    act(() => { vi.advanceTimersByTime(4000) }) // poll → set nudge
    expect(result.current).toEqual(slowDownNudge)
    act(() => { vi.advanceTimersByTime(5000) }) // auto-dismiss
    expect(result.current).toBeNull()
  })

  it('does not repeat the same nudge id in consecutive polls', () => {
    mockDeriveNudge.mockReturnValue(slowDownNudge)
    const setStateSpy = vi.fn()

    const { result } = renderHook(() =>
      useCoachingNudge({ phase: 'LISTENING', liveTranscript: 'transcript' })
    )
    act(() => { vi.advanceTimersByTime(4000) }) // first poll → sets nudge
    expect(result.current).toEqual(slowDownNudge)
    const callsAfterFirst = mockDeriveNudge.mock.calls.length

    act(() => { vi.advanceTimersByTime(4000) }) // second poll → same id, skipped
    // deriveNudge called again but nudge not re-set
    expect(mockDeriveNudge.mock.calls.length).toBe(callsAfterFirst + 1)
    // nudge unchanged (still same object)
    expect(result.current).toEqual(slowDownNudge)
  })

  it('shows a new nudge if the id changes', () => {
    mockDeriveNudge.mockReturnValue(slowDownNudge)
    const { result } = renderHook(() =>
      useCoachingNudge({ phase: 'LISTENING', liveTranscript: 'transcript' })
    )
    act(() => { vi.advanceTimersByTime(4000) })
    expect(result.current?.id).toBe('slow-down')

    // New nudge type
    const fillerNudge = { id: 'fillers', message: 'Watch the filler words', type: 'filler' as const, severity: 'warning' as const }
    mockDeriveNudge.mockReturnValue(fillerNudge)
    act(() => { vi.advanceTimersByTime(4000) })
    expect(result.current?.id).toBe('fillers')
  })

  it('clears nudge when phase transitions away from LISTENING', () => {
    mockDeriveNudge.mockReturnValue(slowDownNudge)
    const { result, rerender } = renderHook(
      ({ phase, liveTranscript }: Parameters<typeof useCoachingNudge>[0]) =>
        useCoachingNudge({ phase, liveTranscript }),
      { initialProps: { phase: 'LISTENING' as const, liveTranscript: 'transcript' } }
    )
    act(() => { vi.advanceTimersByTime(4000) })
    expect(result.current).toEqual(slowDownNudge)

    rerender({ phase: 'PROCESSING' as const, liveTranscript: '' })
    expect(result.current).toBeNull()
  })

  it('resets lastNudgeId when phase re-enters LISTENING', () => {
    mockDeriveNudge.mockReturnValue(slowDownNudge)
    const { result, rerender } = renderHook(
      ({ phase, liveTranscript }: Parameters<typeof useCoachingNudge>[0]) =>
        useCoachingNudge({ phase, liveTranscript }),
      { initialProps: { phase: 'LISTENING' as const, liveTranscript: 'transcript' } }
    )
    act(() => { vi.advanceTimersByTime(4000) })
    expect(result.current?.id).toBe('slow-down')

    // Phase leaves → lastNudgeId should reset
    rerender({ phase: 'PROCESSING' as const, liveTranscript: '' })
    expect(result.current).toBeNull()

    // Re-enter LISTENING — same nudge id should fire again (because lastNudgeId was reset)
    rerender({ phase: 'LISTENING' as const, liveTranscript: 'new transcript' })
    act(() => { vi.advanceTimersByTime(4000) })
    expect(result.current).toEqual(slowDownNudge)
  })

  it('does not poll when phase is SCORING', () => {
    const { result } = renderHook(() =>
      useCoachingNudge({ phase: 'SCORING', liveTranscript: 'some transcript' })
    )
    act(() => { vi.advanceTimersByTime(20000) })
    expect(mockDeriveNudge).not.toHaveBeenCalled()
    expect(result.current).toBeNull()
  })
})
