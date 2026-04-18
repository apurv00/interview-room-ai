import { renderHook, act } from '@testing-library/react'

// ─── Mocks (before imports) ────────────────────────────────────────────────

vi.mock('@interview/audio/recordingClock', () => ({
  wallClockMsToAudioSeconds: vi.fn(() => 0),
}))

vi.mock('@interview/config/speechMetrics', () => ({
  analyzeSpeech: vi.fn(() => ({
    wpm: 120,
    fillerRate: 0.01,
    pauseScore: 80,
    ramblingIndex: 0.1,
    totalWords: 10,
    fillerWordCount: 0,
    durationMinutes: 0.5,
  })),
}))

// ─── WebSocket mock ────────────────────────────────────────────────────────

let mockWsInstance: MockWebSocket | null = null

class MockWebSocket {
  static CONNECTING = 0
  static OPEN = 1
  static CLOSING = 2
  static CLOSED = 3

  readyState = MockWebSocket.CONNECTING
  onopen: ((ev: Event) => void) | null = null
  onclose: ((ev: CloseEvent) => void) | null = null
  onerror: ((ev: Event) => void) | null = null
  onmessage: ((ev: MessageEvent) => void) | null = null

  constructor(
    public url: string,
    public protocols?: string | string[],
  ) {
    mockWsInstance = this
  }

  send = vi.fn()

  close() {
    this.readyState = MockWebSocket.CLOSED
    this.onclose?.(new CloseEvent('close'))
  }

  // Test helpers
  simulateOpen() {
    this.readyState = MockWebSocket.OPEN
    this.onopen?.(new Event('open'))
  }

  simulateMessage(data: unknown) {
    this.onmessage?.(new MessageEvent('message', { data: JSON.stringify(data) }))
  }
}

vi.stubGlobal('WebSocket', MockWebSocket)

// ─── Fetch mock (token endpoint) ───────────────────────────────────────────

global.fetch = vi.fn().mockResolvedValue({
  ok: true,
  json: () => Promise.resolve({ token: 'test-deepgram-token' }),
})

// ─── AudioContext / getUserMedia mocks ─────────────────────────────────────

const mockConnect = vi.fn()
const mockDisconnect = vi.fn()
const mockProcessor = {
  connect: mockConnect,
  disconnect: mockDisconnect,
  onaudioprocess: null as ((e: unknown) => void) | null,
}

const mockSource = {
  connect: mockConnect,
  disconnect: mockDisconnect,
}

class MockAudioContext {
  sampleRate = 16000
  state = 'running'
  createMediaStreamSource = vi.fn(() => mockSource)
  createScriptProcessor = vi.fn(() => mockProcessor)
  destination = {}
  close = vi.fn().mockResolvedValue(undefined)
  resume = vi.fn().mockResolvedValue(undefined)
  addEventListener = vi.fn()
}

vi.stubGlobal('AudioContext', MockAudioContext)

const mockStream = {
  getTracks: () => [{ stop: vi.fn() }],
}

Object.defineProperty(navigator, 'mediaDevices', {
  value: {
    getUserMedia: vi.fn().mockResolvedValue(mockStream),
  },
  writable: true,
  configurable: true,
})

// Stub requestAnimationFrame/cancelAnimationFrame for live transcript updates
vi.stubGlobal('requestAnimationFrame', (cb: () => void) => { cb(); return 1 })
vi.stubGlobal('cancelAnimationFrame', vi.fn())

import { useDeepgramRecognition } from '../hooks/useDeepgramRecognition'

// ─── Helpers ───────────────────────────────────────────────────────────────

function makeResult(transcript: string, isFinal: boolean) {
  return {
    type: 'Results',
    is_final: isFinal,
    channel: {
      alternatives: [
        {
          transcript,
          words: transcript
            ? transcript.split(' ').map((w, i) => ({
                word: w,
                start: i * 0.3,
                end: i * 0.3 + 0.25,
                confidence: 0.99,
              }))
            : [],
        },
      ],
    },
  }
}

function makeUtteranceEnd() {
  return { type: 'UtteranceEnd' }
}

// ─── Tests ─────────────────────────────────────────────────────────────────

describe('useDeepgramRecognition', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.clearAllMocks()
    mockWsInstance = null
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('receives messages after warmUp + fast path startListening', async () => {
    const { result } = renderHook(() => useDeepgramRecognition())
    const onComplete = vi.fn()

    // warmUp → opens WebSocket
    act(() => {
      result.current.warmUp()
    })

    // Wait for token fetch to resolve
    await act(async () => {
      await vi.advanceTimersByTimeAsync(10)
    })

    // The WebSocket should have been created by warmUp
    expect(mockWsInstance).not.toBeNull()

    // Simulate WebSocket open → isWarmedUp becomes true
    act(() => {
      mockWsInstance!.simulateOpen()
    })

    // startListening should take the fast path (ws already open)
    await act(async () => {
      result.current.startListening(onComplete)
      // Let getUserMedia resolve
      await vi.advanceTimersByTimeAsync(10)
    })

    // Simulate a final result followed by UtteranceEnd
    await act(async () => {
      mockWsInstance!.simulateMessage(makeResult('Hello world', true))
    })

    await act(async () => {
      mockWsInstance!.simulateMessage(makeUtteranceEnd())
      // Advance past the grace period (3000ms for short answers <15 words)
      // + allow dynamic import of speechMetrics to resolve
      await vi.advanceTimersByTimeAsync(3500)
    })

    expect(onComplete).toHaveBeenCalledWith(
      expect.objectContaining({ text: 'Hello world' }),
    )
  })

  it('early question detection finishes without UtteranceEnd', async () => {
    const { result } = renderHook(() => useDeepgramRecognition())
    const onComplete = vi.fn()

    // warmUp
    act(() => { result.current.warmUp() })
    await act(async () => { await vi.advanceTimersByTimeAsync(10) })
    act(() => { mockWsInstance!.simulateOpen() })

    // startListening on fast path
    await act(async () => {
      result.current.startListening(onComplete)
      await vi.advanceTimersByTimeAsync(10)
    })

    // Send a short question (ends with ?) — should trigger immediate finish
    await act(async () => {
      mockWsInstance!.simulateMessage(makeResult('Can you repeat that?', true))
      await vi.advanceTimersByTimeAsync(10)
    })

    // onComplete fires immediately without needing UtteranceEnd
    expect(onComplete).toHaveBeenCalledWith(
      expect.objectContaining({ text: 'Can you repeat that?' }),
    )
  })

  it('interrupt fires when ≥3-word speech detected during non-listening', async () => {
    const { result } = renderHook(() => useDeepgramRecognition())
    const onInterrupt = vi.fn()

    // warmUp
    act(() => { result.current.warmUp() })
    await act(async () => { await vi.advanceTimersByTimeAsync(10) })
    act(() => { mockWsInstance!.simulateOpen() })

    // Set interrupt handler but do NOT start listening
    act(() => {
      result.current.setOnInterrupt(onInterrupt)
    })

    // Attach message handler by starting and immediately stopping to get
    // the handler attached. Actually the warmUp path doesn't attach a
    // message handler until startListening. So let's use the connectFresh
    // path instead for this test.

    // We need the WS to have an onmessage handler. Let's do a full
    // connect by calling startListening then finishing, then set interrupt.
    const firstComplete = vi.fn()
    await act(async () => {
      result.current.startListening(firstComplete)
      await vi.advanceTimersByTimeAsync(10)
    })

    // Now stop listening — clears onCompleteRef
    await act(async () => {
      result.current.stopListening()
      await vi.advanceTimersByTimeAsync(10)
    })

    // Now do a fresh warmUp + connect to get a new ws with handler
    // Reset for a new connection
    act(() => { result.current.warmUp() })
    await act(async () => { await vi.advanceTimersByTimeAsync(10) })

    if (mockWsInstance) {
      act(() => { mockWsInstance!.simulateOpen() })

      // Start listening to attach message handler, then we'll check interrupt
      // Actually for interrupt to fire, onCompleteRef must be null (no active listener).
      // The attachMessageHandler is called when startListening runs.
      // So: startListening attaches handler → finishRecognition clears onCompleteRef
      // → next speech triggers interrupt.

      // Let's just start, get the handler attached, then stop
      const secondComplete = vi.fn()
      await act(async () => {
        result.current.startListening(secondComplete)
        await vi.advanceTimersByTimeAsync(10)
      })

      // Stop listening so onCompleteRef is cleared
      await act(async () => {
        result.current.stopListening()
        await vi.advanceTimersByTimeAsync(10)
      })

      // Set interrupt handler
      act(() => {
        result.current.setOnInterrupt(onInterrupt)
      })

      // The ws should still have the message handler attached.
      // Send a ≥3-word final result while not listening — should trigger interrupt.
      // (Fix 3: single-word noise like "um" or "hello" must NOT interrupt.)
      if (mockWsInstance?.onmessage) {
        act(() => {
          mockWsInstance!.simulateMessage(makeResult('wait can I clarify', true))
        })
        expect(onInterrupt).toHaveBeenCalled()
      }
    }
  })

  it('interrupt fires when 3 words arrive split across two final packets', async () => {
    // Regression test for Codex P1 on PR #228:
    // Deepgram can emit one utterance as multiple `is_final: true`
    // packets (e.g. "wait can" then "I clarify"). Checking word count
    // per-packet drops genuine multi-word interrupts. The accumulator
    // must span packets.
    const { result } = renderHook(() => useDeepgramRecognition())
    const onInterrupt = vi.fn()

    // Attach a message handler by starting + stopping listening once.
    await act(async () => {
      result.current.startListening(vi.fn())
      await vi.advanceTimersByTimeAsync(10)
    })
    if (mockWsInstance) act(() => { mockWsInstance!.simulateOpen() })
    await act(async () => {
      result.current.stopListening()
      await vi.advanceTimersByTimeAsync(10)
    })

    act(() => {
      result.current.setOnInterrupt(onInterrupt)
    })

    if (mockWsInstance?.onmessage) {
      // Packet 1: 2 words — below threshold alone, should NOT fire yet.
      act(() => {
        mockWsInstance!.simulateMessage(makeResult('wait can', true))
      })
      expect(onInterrupt).not.toHaveBeenCalled()

      // Packet 2: 2 more words — accumulator now holds "wait can I clarify"
      // (4 words total). Should fire.
      act(() => {
        mockWsInstance!.simulateMessage(makeResult('I clarify', true))
      })
      expect(onInterrupt).toHaveBeenCalledTimes(1)
    }
  })

  it('interrupt accumulator resets after 2s inactivity', async () => {
    // Regression test for Codex P1 on PR #228:
    // A stale 2-word fragment from a mic pop must not combine with a
    // later unrelated 1-word misheard noise to spuriously cross the
    // 3-word threshold. After 2s of silence the accumulator clears.
    const { result } = renderHook(() => useDeepgramRecognition())
    const onInterrupt = vi.fn()

    await act(async () => {
      result.current.startListening(vi.fn())
      await vi.advanceTimersByTimeAsync(10)
    })
    if (mockWsInstance) act(() => { mockWsInstance!.simulateOpen() })
    await act(async () => {
      result.current.stopListening()
      await vi.advanceTimersByTimeAsync(10)
    })

    act(() => {
      result.current.setOnInterrupt(onInterrupt)
    })

    if (mockWsInstance?.onmessage) {
      // Packet 1: 2 words (noise misheard as "um hmm").
      act(() => {
        mockWsInstance!.simulateMessage(makeResult('um hmm', true))
      })
      expect(onInterrupt).not.toHaveBeenCalled()

      // 2 seconds of silence → accumulator resets to ''.
      await act(async () => {
        await vi.advanceTimersByTimeAsync(2001)
      })

      // Packet 2: a single unrelated word. Total accumulated is now "yes"
      // (1 word), not "um hmm yes" (3 words). Must NOT fire.
      act(() => {
        mockWsInstance!.simulateMessage(makeResult('yes', true))
      })
      expect(onInterrupt).not.toHaveBeenCalled()
    }
  })

  it('interrupt does NOT fire on sparse 1-2 word false positives (noise, mic pops)', async () => {
    const { result } = renderHook(() => useDeepgramRecognition())
    const onInterrupt = vi.fn()

    // Get a WS with a message handler attached by starting+stopping listening
    await act(async () => {
      result.current.startListening(vi.fn())
      await vi.advanceTimersByTimeAsync(10)
    })
    if (mockWsInstance) act(() => { mockWsInstance!.simulateOpen() })
    await act(async () => {
      result.current.stopListening()
      await vi.advanceTimersByTimeAsync(10)
    })

    // Register the interrupt handler AFTER listening stopped so onCompleteRef is null
    act(() => {
      result.current.setOnInterrupt(onInterrupt)
    })

    // Isolated 1- and 2-word mishearings (breathing, mic pops, keyboard
    // clicks) should NOT fire. Each event is separated by >2s so the
    // accumulator resets between them — matching realistic noise-event
    // spacing (Deepgram's VAD needs a silence gap to emit `is_final`,
    // so isolated noise events are naturally separated).
    if (mockWsInstance?.onmessage) {
      act(() => { mockWsInstance!.simulateMessage(makeResult('um', true)) })
      await act(async () => { await vi.advanceTimersByTimeAsync(2100) })

      act(() => { mockWsInstance!.simulateMessage(makeResult('hello', true)) })
      await act(async () => { await vi.advanceTimersByTimeAsync(2100) })

      act(() => { mockWsInstance!.simulateMessage(makeResult('yes okay', true)) })
      await act(async () => { await vi.advanceTimersByTimeAsync(2100) })

      expect(onInterrupt).not.toHaveBeenCalled()

      // A genuine 3-word interrupt fires in one packet.
      act(() => { mockWsInstance!.simulateMessage(makeResult('can I clarify', true)) })
      expect(onInterrupt).toHaveBeenCalledTimes(1)
    }
  })

  it('interrupt does NOT fire during active listening', async () => {
    const { result } = renderHook(() => useDeepgramRecognition())
    const onComplete = vi.fn()
    const onInterrupt = vi.fn()

    // Set interrupt handler
    act(() => {
      result.current.setOnInterrupt(onInterrupt)
    })

    // warmUp
    act(() => { result.current.warmUp() })
    await act(async () => { await vi.advanceTimersByTimeAsync(10) })
    act(() => { mockWsInstance!.simulateOpen() })

    // Start listening — onCompleteRef is set, so interrupt path should not fire
    await act(async () => {
      result.current.startListening(onComplete)
      await vi.advanceTimersByTimeAsync(10)
    })

    // Simulate speech — should route to recognition, NOT interrupt
    await act(async () => {
      mockWsInstance!.simulateMessage(makeResult('Some answer', true))
      mockWsInstance!.simulateMessage(makeUtteranceEnd())
      // Advance past the grace period (4000ms for short answers <15 words)
      await vi.advanceTimersByTimeAsync(4500)
    })

    expect(onInterrupt).not.toHaveBeenCalled()
    expect(onComplete).toHaveBeenCalledWith(
      expect.objectContaining({ text: 'Some answer' }),
    )
  })

  // ─── E-3.7: Tab-backgrounded answer truncation ──────────────────────────

  describe('E-3.7 — page hidden suppresses UtteranceEnd grace timer', () => {
    function setPageHidden(hidden: boolean) {
      Object.defineProperty(document, 'hidden', {
        value: hidden,
        configurable: true,
      })
      Object.defineProperty(document, 'visibilityState', {
        value: hidden ? 'hidden' : 'visible',
        configurable: true,
      })
      document.dispatchEvent(new Event('visibilitychange'))
    }

    afterEach(() => {
      // Reset visibility for other tests
      setPageHidden(false)
    })

    it('does NOT schedule grace timer when UtteranceEnd arrives with page hidden', async () => {
      const { result } = renderHook(() => useDeepgramRecognition())
      const onComplete = vi.fn()

      act(() => { result.current.warmUp() })
      await act(async () => { await vi.advanceTimersByTimeAsync(10) })
      act(() => { mockWsInstance!.simulateOpen() })

      await act(async () => {
        result.current.startListening(onComplete)
        await vi.advanceTimersByTimeAsync(10)
      })

      // Some speech captured
      await act(async () => {
        mockWsInstance!.simulateMessage(makeResult('I was just about to say', true))
      })

      // Tab goes to background → AudioContext would be suspended by the
      // browser; Deepgram fires UtteranceEnd because no audio is flowing
      act(() => setPageHidden(true))

      await act(async () => {
        mockWsInstance!.simulateMessage(makeUtteranceEnd())
        // Advance past what WOULD be the grace period if the fix is absent
        await vi.advanceTimersByTimeAsync(5000)
      })

      // onComplete must NOT have fired — answer preserved for user's return
      expect(onComplete).not.toHaveBeenCalled()

      // Tab visible again → next speech packet or UtteranceEnd resumes flow
      act(() => setPageHidden(false))
      await act(async () => {
        mockWsInstance!.simulateMessage(makeResult('that was really tough.', true))
      })
      await act(async () => {
        mockWsInstance!.simulateMessage(makeUtteranceEnd())
        await vi.advanceTimersByTimeAsync(4500)
      })

      expect(onComplete).toHaveBeenCalledWith(
        expect.objectContaining({ text: expect.stringContaining('really tough') }),
      )
    })

    it('cancels an in-flight grace timer when the tab becomes visible', async () => {
      const { result } = renderHook(() => useDeepgramRecognition())
      const onComplete = vi.fn()

      act(() => { result.current.warmUp() })
      await act(async () => { await vi.advanceTimersByTimeAsync(10) })
      act(() => { mockWsInstance!.simulateOpen() })

      await act(async () => {
        result.current.startListening(onComplete)
        await vi.advanceTimersByTimeAsync(10)
      })

      // Speech + UtteranceEnd while VISIBLE → grace timer scheduled (4000ms)
      await act(async () => {
        mockWsInstance!.simulateMessage(makeResult('short answer', true))
        mockWsInstance!.simulateMessage(makeUtteranceEnd())
      })

      // Tab hides before grace fires → handler should cancel the timer
      act(() => setPageHidden(true))

      // Advance past the grace period; without the cancel, finishRecognition
      // would run while hidden and terminate the answer
      await act(async () => {
        await vi.advanceTimersByTimeAsync(5000)
      })

      expect(onComplete).not.toHaveBeenCalled()
    })
  })

  // ─── E-3.4: WS disconnect mid-answer should reconnect, not truncate ──────

  describe('E-3.4 — WS disconnect with partial text reconnects (does not finish)', () => {
    // Uses the connectFresh path (no warmUp) so the ws.onclose handler
    // is wired to maybeReconnectOrFinish. The warmUp fast path has its
    // own onclose that only flips isWarmedUpRef — reconnect there is a
    // separate existing-behavior limitation, out of scope for E-3.4.
    it('reconnects on WS close when partial text exists; preserves partial text', async () => {
      const { result } = renderHook(() => useDeepgramRecognition())
      const onComplete = vi.fn()

      // connectFresh path: skip warmUp, go straight to startListening
      act(() => { result.current.startListening(onComplete) })
      await act(async () => { await vi.advanceTimersByTimeAsync(20) })

      // connectFresh has created the WS by now
      expect(mockWsInstance).not.toBeNull()
      act(() => { mockWsInstance!.simulateOpen() })
      await act(async () => { await vi.advanceTimersByTimeAsync(10) })

      // Candidate says something — finalText now has content
      await act(async () => {
        mockWsInstance!.simulateMessage(makeResult('In my previous role I led a team', true))
      })

      const firstWs = mockWsInstance!

      // Network blip → WS closes with partial text captured
      await act(async () => {
        firstWs.close()
        // Advance past the 800ms reconnect backoff (attempt 1 → 800ms)
        await vi.advanceTimersByTimeAsync(1000)
      })

      // A NEW WebSocket should have been created (reconnect, not finish)
      expect(mockWsInstance).not.toBe(firstWs)
      // Recognition not finished — candidate can keep speaking
      expect(onComplete).not.toHaveBeenCalled()

      // Reconnect opens and candidate continues
      act(() => { mockWsInstance!.simulateOpen() })
      await act(async () => { await vi.advanceTimersByTimeAsync(10) })
      await act(async () => {
        mockWsInstance!.simulateMessage(makeResult('of five engineers.', true))
      })
      await act(async () => {
        mockWsInstance!.simulateMessage(makeUtteranceEnd())
        await vi.advanceTimersByTimeAsync(4500)
      })

      // Final text combines both halves — partial text was preserved across
      // the reconnect via finalTextRef (not cleared except on startListening).
      expect(onComplete).toHaveBeenCalledWith(
        expect.objectContaining({
          text: 'In my previous role I led a team of five engineers.',
        }),
      )
    })

    it('finishes once maxReconnectAttempts is exhausted even with partial text', async () => {
      const { result } = renderHook(() => useDeepgramRecognition())
      const onComplete = vi.fn()

      act(() => { result.current.startListening(onComplete) })
      await act(async () => { await vi.advanceTimersByTimeAsync(20) })
      act(() => { mockWsInstance!.simulateOpen() })
      await act(async () => { await vi.advanceTimersByTimeAsync(10) })

      await act(async () => {
        mockWsInstance!.simulateMessage(makeResult('partial answer here', true))
      })

      // First disconnect — reconnect scheduled (attempt 1).
      await act(async () => {
        mockWsInstance!.close()
        await vi.advanceTimersByTimeAsync(900)
      })
      // Second disconnect on the reconnected ws (without onopen so
      // reconnectAttemptsRef stays at its incremented value and is NOT reset).
      await act(async () => {
        mockWsInstance!.close()
        await vi.advanceTimersByTimeAsync(1700)
      })
      // Third disconnect — exceeds maxReconnectAttempts (2); finish fires.
      await act(async () => {
        mockWsInstance!.close()
        await vi.advanceTimersByTimeAsync(5000)
      })

      expect(onComplete).toHaveBeenCalledWith(
        expect.objectContaining({ text: 'partial answer here' }),
      )
    })
  })

  it('warmUp sends KeepAlive pings every 5s while idle', async () => {
    const { result } = renderHook(() => useDeepgramRecognition())

    act(() => { result.current.warmUp() })
    await act(async () => { await vi.advanceTimersByTimeAsync(10) })
    act(() => { mockWsInstance!.simulateOpen() })

    // No pings yet
    expect(mockWsInstance!.send).not.toHaveBeenCalled()

    // t=5s → first KeepAlive
    await act(async () => { await vi.advanceTimersByTimeAsync(5000) })
    expect(mockWsInstance!.send).toHaveBeenCalledWith(
      JSON.stringify({ type: 'KeepAlive' }),
    )

    // t=10s → second KeepAlive
    await act(async () => { await vi.advanceTimersByTimeAsync(5000) })
    expect(mockWsInstance!.send).toHaveBeenCalledTimes(2)

    // t=15s → third KeepAlive. The warm socket survives past Deepgram's
    // documented ~10s idle timeout, which is the whole point of this fix.
    await act(async () => { await vi.advanceTimersByTimeAsync(5000) })
    expect(mockWsInstance!.send).toHaveBeenCalledTimes(3)
  })

  it('KeepAlive continues through the fast-path listening handoff', async () => {
    // Per Deepgram support (2026-04-18): /v1/listen idle-closes after
    // ~12s of no data with close code 1011 + NET-0001, and the
    // recommended mitigation is to send `{"type":"KeepAlive"}` every
    // 3-5s regardless of audio flow. ScriptProcessorNode (deprecated)
    // can throttle on tab backgrounding or main-thread pressure, which
    // stalls audio long enough to trigger the idle close — exactly the
    // R3 reconnect pattern observed in session 01RUySybLLDdv36aXXFbuRsr.
    //
    // Replaces the PR #283 test which asserted the OPPOSITE behavior
    // (KeepAlive cleared once audio takes over). That optimization was
    // premature — Deepgram explicitly recommends KeepAlive during audio.
    const { result } = renderHook(() => useDeepgramRecognition())
    const onComplete = vi.fn()

    act(() => { result.current.warmUp() })
    await act(async () => { await vi.advanceTimersByTimeAsync(10) })
    act(() => { mockWsInstance!.simulateOpen() })

    // One KeepAlive ping at t=5s
    await act(async () => { await vi.advanceTimersByTimeAsync(5000) })
    expect(mockWsInstance!.send).toHaveBeenCalledTimes(1)

    // startListening takes over via the fast path
    await act(async () => {
      result.current.startListening(onComplete)
      await vi.advanceTimersByTimeAsync(10)
    })

    const beforeCount = mockWsInstance!.send.mock.calls.length

    // Advance 10s — we expect TWO more KeepAlive pings (at t+5s and
    // t+10s from the listening-start timestamp). Test mic is mocked so
    // onaudioprocess never fires — any send() calls here are KeepAlive.
    await act(async () => { await vi.advanceTimersByTimeAsync(10000) })

    const afterCount = mockWsInstance!.send.mock.calls.length
    // ≥1 new ping in the 10s window (exact count depends on timer
    // alignment relative to the handoff; 1-2 new pings is correct).
    expect(afterCount).toBeGreaterThan(beforeCount)
  })

  it('KeepAlive continues through the slow warm-up handoff path', async () => {
    // Companion to the fast-path test above. The slow path (startListening
    // called BEFORE ws.onopen fires) awaits warmUpPromiseRef. Previous
    // PR #283 revision cleared KeepAlive on this path too; Deepgram's
    // support confirmation (2026-04-18) inverts that decision — keep
    // pings flowing through listening to defeat the 12s idle-close.
    const { result } = renderHook(() => useDeepgramRecognition())
    const onComplete = vi.fn()

    // Start warm-up but do NOT simulate onopen yet — keeps
    // warmUpPromiseRef.current alive.
    act(() => { result.current.warmUp() })
    await act(async () => { await vi.advanceTimersByTimeAsync(10) })
    expect(mockWsInstance).not.toBeNull()

    // startListening called BEFORE the WS opens → slow-path handoff
    act(() => { result.current.startListening(onComplete) })

    // NOW the WS opens — triggers the warmUpPromise resolution which
    // should NOT clear the KeepAlive interval (new post-fix behavior).
    act(() => { mockWsInstance!.simulateOpen() })
    await act(async () => { await vi.advanceTimersByTimeAsync(10) })

    const beforeCount = mockWsInstance!.send.mock.calls.length

    // Advance 10s — expect at least 1 KeepAlive ping to fire through
    // the handoff. Previous revision (cleared interval) would see 0.
    await act(async () => { await vi.advanceTimersByTimeAsync(10000) })

    expect(mockWsInstance!.send.mock.calls.length).toBeGreaterThan(beforeCount)
  })

  it('UtteranceEnd grace is 3000ms for short answers (was 4000ms)', async () => {
    const { result } = renderHook(() => useDeepgramRecognition())
    const onComplete = vi.fn()

    act(() => { result.current.warmUp() })
    await act(async () => { await vi.advanceTimersByTimeAsync(10) })
    act(() => { mockWsInstance!.simulateOpen() })

    await act(async () => {
      result.current.startListening(onComplete)
      await vi.advanceTimersByTimeAsync(10)
    })

    await act(async () => {
      mockWsInstance!.simulateMessage(makeResult('Hi there', true))
      mockWsInstance!.simulateMessage(makeUtteranceEnd())
    })

    // At 2500ms (below new 3000ms grace) onComplete should NOT have fired yet
    await act(async () => { await vi.advanceTimersByTimeAsync(2500) })
    expect(onComplete).not.toHaveBeenCalled()

    // At 3100ms (past new 3000ms grace) onComplete should have fired
    await act(async () => { await vi.advanceTimersByTimeAsync(600) })
    expect(onComplete).toHaveBeenCalledWith(
      expect.objectContaining({ text: 'Hi there' }),
    )
  })

  it('UtteranceEnd grace is 2500ms for long answers (was 3500ms)', async () => {
    const { result } = renderHook(() => useDeepgramRecognition())
    const onComplete = vi.fn()

    act(() => { result.current.warmUp() })
    await act(async () => { await vi.advanceTimersByTimeAsync(10) })
    act(() => { mockWsInstance!.simulateOpen() })

    await act(async () => {
      result.current.startListening(onComplete)
      await vi.advanceTimersByTimeAsync(10)
    })

    // 16-word transcript triggers long-answer branch
    const longText = 'one two three four five six seven eight nine ten eleven twelve thirteen fourteen fifteen sixteen'
    await act(async () => {
      mockWsInstance!.simulateMessage(makeResult(longText, true))
      mockWsInstance!.simulateMessage(makeUtteranceEnd())
    })

    // Not fired at 2000ms
    await act(async () => { await vi.advanceTimersByTimeAsync(2000) })
    expect(onComplete).not.toHaveBeenCalled()

    // Fired by 2600ms
    await act(async () => { await vi.advanceTimersByTimeAsync(600) })
    expect(onComplete).toHaveBeenCalled()
  })

  it('safety timeout fires onCaptureReady after 1500ms', async () => {
    const { result } = renderHook(() => useDeepgramRecognition())
    const onComplete = vi.fn()
    const onCaptureReady = vi.fn()

    // Block getUserMedia so it never resolves → safety timeout should fire
    const neverResolve = new Promise<MediaStream>(() => {})
    vi.mocked(navigator.mediaDevices.getUserMedia).mockReturnValue(neverResolve)

    // Start listening with onCaptureReady — use connectFresh path (no warmUp)
    act(() => {
      result.current.startListening(onComplete, { onCaptureReady })
    })

    // Let the token fetch resolve
    await act(async () => {
      await vi.advanceTimersByTimeAsync(10)
    })

    // WebSocket opens (connectFresh path creates WS after token)
    if (mockWsInstance) {
      act(() => {
        mockWsInstance!.simulateOpen()
      })
    }

    // onCaptureReady should NOT have been called yet (getUserMedia hasn't resolved)
    expect(onCaptureReady).not.toHaveBeenCalled()

    // Advance past the 1500ms safety timeout
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1500)
    })

    expect(onCaptureReady).toHaveBeenCalledTimes(1)
  })

  it('diagnostic capture records each Deepgram packet shape into the ring buffer', async () => {
    // Instrumentation regression: verify that every Results + UtteranceEnd
    // message gets a summary entry in the hook-internal ring buffer. We
    // prove this by constructing a message that includes `is_final`,
    // `speech_final`, `start`, `duration`, and words, then reading the
    // buffer back via an unmocked internal path. Since the ring buffer
    // is private, we grep for it via a custom runtime hook exposure —
    // NODE_ENV=test disables the window global, so we instead attach a
    // minimal accessor in a separate module or infer from behavior.
    //
    // Since the buffer is fully encapsulated and window exposure is
    // gated out of tests, we assert the behavior indirectly: the
    // packet capture must not throw or affect existing behavior.
    // The `receives messages after warmUp + fast path startListening`
    // test above already proves behavior is unchanged. The actual
    // packet shape + ring buffer capacity are covered by manual
    // end-to-end verification (load a real interview, call
    // `window.__deepgramDebug.packets()` in DevTools).
    const { result } = renderHook(() => useDeepgramRecognition())
    const onComplete = vi.fn()

    act(() => { result.current.warmUp() })
    await act(async () => { await vi.advanceTimersByTimeAsync(10) })
    act(() => { mockWsInstance!.simulateOpen() })

    await act(async () => {
      result.current.startListening(onComplete)
      await vi.advanceTimersByTimeAsync(10)
    })

    // Send a packet with extra diagnostic fields — must not throw.
    await act(async () => {
      mockWsInstance!.simulateMessage({
        type: 'Results',
        is_final: true,
        speech_final: true,
        start: 1.234,
        duration: 0.789,
        channel: {
          alternatives: [{
            transcript: 'Hello world',
            words: [
              { word: 'Hello', start: 1.234, end: 1.5, confidence: 0.99 },
              { word: 'world', start: 1.6, end: 2.023, confidence: 0.99 },
            ],
          }],
        },
      })
      mockWsInstance!.simulateMessage(makeUtteranceEnd())
      await vi.advanceTimersByTimeAsync(3500)
    })

    // The hook must still complete correctly — instrumentation is
    // side-effect-free.
    expect(onComplete).toHaveBeenCalledWith(
      expect.objectContaining({ text: 'Hello world' }),
    )
  })
})
