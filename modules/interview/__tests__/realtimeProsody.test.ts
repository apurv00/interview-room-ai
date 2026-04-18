import { renderHook, act } from '@testing-library/react'
import { useRealtimeProsody } from '../hooks/useRealtimeProsody'

describe('useRealtimeProsody — long-pause nudge', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  it('does NOT fire "Long pause detected" when transcript is empty', async () => {
    // Dead-mic scenario: phase=LISTENING, but liveTranscript never grows
    // because Deepgram WS is dead / AudioContext suspended. The nudge
    // would blame the user for a system failure.
    const { result, rerender } = renderHook(
      ({ t }: { t: string }) => useRealtimeProsody({
        phase: 'LISTENING',
        liveTranscript: t,
        enabled: true,
      }),
      { initialProps: { t: '' } },
    )

    // Let the 5s initial wait + several CHECK_INTERVAL_MS (2s) ticks pass
    // with zero transcript. If the guard is absent, "long-pause" nudge
    // would fire around t=9s.
    for (let i = 0; i < 10; i++) {
      await act(async () => { await vi.advanceTimersByTimeAsync(2000) })
      rerender({ t: '' })
    }

    expect(result.current).toBeNull()
  })

  it('DOES fire "Long pause detected" after the user has spoken and paused', async () => {
    // Candidate said "I worked on payment systems" then froze for >4s.
    // This is the legitimate use case — guard should NOT block it.
    const { result, rerender } = renderHook(
      ({ t }: { t: string }) => useRealtimeProsody({
        phase: 'LISTENING',
        liveTranscript: t,
        enabled: true,
      }),
      { initialProps: { t: '' } },
    )

    // Speak for the first 4s to accumulate word growth samples
    await act(async () => { await vi.advanceTimersByTimeAsync(2000) })
    rerender({ t: 'I worked on' })
    await act(async () => { await vi.advanceTimersByTimeAsync(2000) })
    rerender({ t: 'I worked on payment systems' })

    // Then stall — wordCount stays at 5 for >4s
    for (let i = 0; i < 5; i++) {
      await act(async () => { await vi.advanceTimersByTimeAsync(2000) })
      rerender({ t: 'I worked on payment systems' })
    }

    expect(result.current).toMatchObject({ id: 'long-pause' })
  })
})
