/**
 * @vitest-environment node
 *
 * Covers the PRESERVE_SOCKET_TRIGGERS allowlist added to keep the
 * Deepgram WebSocket open across question turns (2026-04-21). Wrong
 * membership here directly regresses the per-Q WS re-handshake that
 * added 1.1–1.6s × 6Q of user-visible latency.
 *
 * The full hook is ~1200 LOC of browser/WebSocket/AudioContext state,
 * exercised end-to-end in the live interview flow. This test pins the
 * allowlist itself — a pure, boundary-defining value — so future edits
 * (adding a new FinishTrigger, renaming one) can't silently drop a turn
 * from the preserve path or over-preserve a terminal error path.
 */
import { describe, it, expect } from 'vitest'
import { PRESERVE_SOCKET_TRIGGERS } from '../useDeepgramRecognition'

describe('PRESERVE_SOCKET_TRIGGERS', () => {
  it('includes the five question-end triggers whose next-Q latency we fixed', () => {
    // graceTimer: natural utterance-end → most common preserve path
    // stopListeningIntentionalSilence: silence probe fired, candidate didn't respond
    // stopListeningInactivityPostSpeech: candidate spoke then fell silent
    // stopListeningMaxAnswer: answer length cap — next Q still coming
    // stopListeningExternal: caller-level fallback end-of-turn
    expect(PRESERVE_SOCKET_TRIGGERS.has('graceTimer')).toBe(true)
    expect(PRESERVE_SOCKET_TRIGGERS.has('stopListeningIntentionalSilence')).toBe(true)
    expect(PRESERVE_SOCKET_TRIGGERS.has('stopListeningInactivityPostSpeech')).toBe(true)
    expect(PRESERVE_SOCKET_TRIGGERS.has('stopListeningMaxAnswer')).toBe(true)
    expect(PRESERVE_SOCKET_TRIGGERS.has('stopListeningExternal')).toBe(true)
    expect(PRESERVE_SOCKET_TRIGGERS.size).toBe(5)
  })

  it('excludes every error / session-end trigger — these MUST tear the ws down', () => {
    // Including any of these would leak a dead or session-terminal socket
    // across into the next turn: token refresh broken, network gone, the
    // user ended the interview, etc.
    const terminal = [
      'startListenReentry',
      'tokenFetchFailed',
      'offline',
      'reconnectExhausted',
      'getUserMediaFailed',
      'warmUpTimeout',
      'stopListeningInactivityPreSpeech',
      'stopListeningFinishInterview',
      'stopListeningUsageLimit',
    ] as const
    for (const t of terminal) {
      expect(PRESERVE_SOCKET_TRIGGERS.has(t)).toBe(false)
    }
  })
})
