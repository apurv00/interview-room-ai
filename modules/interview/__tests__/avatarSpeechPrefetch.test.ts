/**
 * @vitest-environment jsdom
 *
 * Pins the Bug A fix (2026-04-22 session 69e8c2f3...): prefetchTTS must
 * skip the /api/tts blob fetch when the streaming audio pipeline is
 * available. The previous behavior produced a duplicate-synthesis bug
 * whenever useInterview.ts:1356-1359 prepended a random filler to the
 * next question — prefetch fired /api/tts under key `question`, then
 * avatarSpeak looked up `filler + question`, missed, and fired
 * /api/tts/stream. Result: both endpoints synthesized the same turn's
 * text.
 *
 * Contract this test pins:
 *   1. When isStreamingSupported === true → prefetchTTS MUST NOT call fetch.
 *   2. When isStreamingSupported === false → prefetchTTS still warms
 *      the blob cache (mobile Safari / degraded browser fallback path).
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { renderHook, act } from '@testing-library/react'

// Mock voiceMixer — we don't exercise recording capture here.
vi.mock('@interview/audio/voiceMixer', () => ({
  tapAudioElement: vi.fn(),
}))

// useStreamingAudio is the hook that reports MediaSource capability.
// Tests toggle `isSupported` to exercise both prefetch branches.
const streamingMock = {
  streamAndPlay: vi.fn(),
  cancel: vi.fn(),
  softCancel: vi.fn(),
  isSupported: true,
}
vi.mock('@interview/hooks/useStreamingAudio', () => ({
  useStreamingAudio: () => streamingMock,
}))

import { useAvatarSpeech } from '@interview/hooks/useAvatarSpeech'

describe('useAvatarSpeech — prefetchTTS streaming-aware guard (Bug A)', () => {
  let fetchSpy: ReturnType<typeof vi.fn>

  beforeEach(() => {
    fetchSpy = vi.fn(() =>
      Promise.resolve({
        ok: true,
        blob: () => Promise.resolve(new Blob(['x'], { type: 'audio/mpeg' })),
      }) as unknown as Response,
    )
    // @ts-expect-error — overriding global fetch for the test
    global.fetch = fetchSpy
  })

  afterEach(() => {
    vi.clearAllMocks()
  })

  it('does NOT call /api/tts when streaming is supported', () => {
    streamingMock.isSupported = true
    const { result } = renderHook(() =>
      useAvatarSpeech({ isMultimodalEnabled: true, interviewType: 'technical' }),
    )

    act(() => {
      result.current.prefetchTTS('Tell me about yourself.')
    })

    // The whole point of the fix: no fetch when streaming path wins.
    expect(fetchSpy).not.toHaveBeenCalled()
  })

  it('DOES call /api/tts when streaming is NOT supported (Safari mobile fallback)', () => {
    streamingMock.isSupported = false
    const { result } = renderHook(() =>
      useAvatarSpeech({ isMultimodalEnabled: true, interviewType: 'technical' }),
    )

    act(() => {
      result.current.prefetchTTS('Tell me about yourself.')
    })

    // Blob warmup is still useful when streaming isn't available.
    expect(fetchSpy).toHaveBeenCalledTimes(1)
    expect(fetchSpy).toHaveBeenCalledWith(
      '/api/tts',
      expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({ text: 'Tell me about yourself.' }),
      }),
    )
  })

  it('does NOT call /api/tts when multimodal is disabled (feature flag off)', () => {
    streamingMock.isSupported = false // would normally warm cache
    const { result } = renderHook(() =>
      useAvatarSpeech({ isMultimodalEnabled: false, interviewType: 'technical' }),
    )

    act(() => {
      result.current.prefetchTTS('Tell me about yourself.')
    })

    // Multimodal off short-circuits before the streaming branch runs.
    expect(fetchSpy).not.toHaveBeenCalled()
  })

  it('does NOT fire twice for the same text within one session (existing dedup still works)', () => {
    streamingMock.isSupported = false
    const { result } = renderHook(() =>
      useAvatarSpeech({ isMultimodalEnabled: true, interviewType: 'technical' }),
    )

    act(() => {
      result.current.prefetchTTS('Tell me about yourself.')
      result.current.prefetchTTS('Tell me about yourself.')
    })

    expect(fetchSpy).toHaveBeenCalledTimes(1)
  })
})
