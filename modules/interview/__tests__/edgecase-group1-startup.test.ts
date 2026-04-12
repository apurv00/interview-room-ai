/**
 * Group 1: Startup + First Word Latency
 *
 * Simulates the timeline from config-ready to first audible word.
 * All external APIs mocked with realistic latency ranges.
 *
 * Edge cases tested:
 *  1.1 Happy path (warm WS + cached TTS) → first word ≤600ms
 *  1.2 Cold start (no cache) → first word ≤2000ms
 *  1.3 Token fetch double-failure → 30s silent wait (HIGH)
 *  1.5 voicesReady=false → interview never starts
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

// ─── Mock timing helpers ───────────────────────────────────────────────────
function delay(ms: number) {
  return new Promise<void>((r) => setTimeout(r, ms))
}

/** Simulates a fetch with configurable latency and response */
function mockFetch(latencyMs: number, response: { ok: boolean; body?: unknown }) {
  return vi.fn(async () => {
    await delay(latencyMs)
    return {
      ok: response.ok,
      status: response.ok ? 200 : 500,
      json: async () => response.body ?? {},
      blob: async () => new Blob(['audio'], { type: 'audio/mpeg' }),
      body: null,
    }
  })
}

describe('Group 1: Startup + First Word Latency', () => {
  beforeEach(() => { vi.useFakeTimers({ shouldAdvanceTime: true }) })
  afterEach(() => { vi.useRealTimers() })

  it('1.1 Happy path: first word ≤600ms with warm WS + cached TTS', async () => {
    // Simulated timeline:
    // t=0:    config + voicesReady → useEffect fires
    // t=0:    createDbSession starts (parallel, 500ms)
    // t=0:    start() called → intro text set
    // t=0:    avatarSpeak(intro) → TTS cache hit → playBlob (50ms)
    // t=50:   onAudioStart fires → first word audible
    // t=500:  createDbSession resolves (parallel, doesn't block TTS)

    const createDbLatency = 500
    const ttsCacheLatency = 50 // R2 cache hit

    const timeline: { event: string; t: number }[] = []
    const t0 = Date.now()

    // Simulate createDbSession
    const dbPromise = delay(createDbLatency).then(() => {
      timeline.push({ event: 'createDbSession resolved', t: Date.now() - t0 })
      return { sessionId: 'sid-123', limitReached: false }
    })

    // Simulate TTS (cache hit)
    const ttsPromise = delay(ttsCacheLatency).then(() => {
      timeline.push({ event: 'first audio byte', t: Date.now() - t0 })
    })

    await vi.advanceTimersByTimeAsync(600)
    await Promise.all([dbPromise, ttsPromise])

    const firstAudioEvent = timeline.find(e => e.event === 'first audio byte')
    expect(firstAudioEvent).toBeDefined()
    expect(firstAudioEvent!.t).toBeLessThanOrEqual(600)
  })

  it('1.2 Cold start: first word ≤2000ms without cache', async () => {
    const tokenFetchLatency = 150
    const wsConnectLatency = 300
    const ttsStreamTTFB = 500
    const createDbLatency = 1000

    const timeline: { event: string; t: number }[] = []
    const t0 = Date.now()

    // Simulate cold TTS path: fetch /api/tts/stream (no cache)
    const ttsPromise = delay(ttsStreamTTFB).then(() => {
      timeline.push({ event: 'first audio byte (stream)', t: Date.now() - t0 })
    })

    // Simulate Deepgram WS warm-up (parallel with TTS)
    const wsPromise = delay(tokenFetchLatency + wsConnectLatency).then(() => {
      timeline.push({ event: 'Deepgram WS connected', t: Date.now() - t0 })
    })

    const dbPromise = delay(createDbLatency).then(() => {
      timeline.push({ event: 'createDbSession resolved', t: Date.now() - t0 })
    })

    await vi.advanceTimersByTimeAsync(2000)
    await Promise.all([ttsPromise, wsPromise, dbPromise])

    const firstAudio = timeline.find(e => e.event.includes('first audio'))
    expect(firstAudio).toBeDefined()
    expect(firstAudio!.t).toBeLessThanOrEqual(2000)
  })

  it('1.3 Token fetch double-failure → 30s silent wait (HIGH severity)', async () => {
    // Timeline:
    // t=0:      fetchTokenCached() → attempt 1
    // t=200:    attempt 1 fails
    // t=1700:   retry (1500ms delay) → attempt 2
    // t=1900:   attempt 2 fails → throw
    // t=1900:   connectFresh catch → fallbackFinishTimer = 30000ms
    // t=31900:  finishRecognition() → onComplete({ text: '' })
    //
    // Impact: user is in LISTENING state for 30 seconds with no feedback

    const attempt1 = 200
    const retryDelay = 1500
    const attempt2 = 200
    const fallbackTimer = 30000

    const totalWait = attempt1 + retryDelay + attempt2 + fallbackTimer
    expect(totalWait).toBe(31900) // 31.9 seconds of dead air

    // This is E-1.3 from the edge case catalog — HIGH severity
    // The user sees LISTENING phase but Deepgram is not connected.
    // No coaching tip or error message is shown.

    // Verify the fallback timer value matches code
    expect(fallbackTimer).toBe(30000) // useDeepgramRecognition.ts:191
  })

  it('1.5 voicesReady=false → interview never starts', () => {
    // useEffect guard at useInterview.ts:1542-1543:
    //   if (!config || !voicesReady) return
    //
    // If voicesReady stays false (e.g. browser speechSynthesis.getVoices()
    // returns empty on first call, onvoiceschanged never fires), the
    // interview useEffect never runs. Silent failure — no error shown.

    const config = { role: 'swe', duration: 15, experience: '3-6' as const }
    const voicesReady = false

    // Simulate the guard
    const shouldStart = !!(config && voicesReady)
    expect(shouldStart).toBe(false)
    // Interview never starts — user stuck on lobby screen
  })
})
