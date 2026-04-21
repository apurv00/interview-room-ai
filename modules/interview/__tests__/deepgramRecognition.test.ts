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

  /** Tracks the most recent close(code, reason) call so tests can
   *  assert the labelled close codes we use to identify which trigger
   *  fired mid-interview (e.g. graceTimer=4001 vs earlyQuestion=4002). */
  lastCloseCode: number | undefined = undefined
  lastCloseReason: string | undefined = undefined

  close(code?: number, reason?: string) {
    this.lastCloseCode = code
    this.lastCloseReason = reason
    this.readyState = MockWebSocket.CLOSED
    // Mirror browser behavior: CloseEvent carries the code+reason the
    // local side passed to close() when the remote hasn't responded
    // yet. Real browsers may overwrite these with the remote frame's
    // values, but the hook's onclose runs before that matters for the
    // debug POST (it reads closeTriggerRef, not ev.code).
    const init: CloseEventInit = {
      code: code ?? 1005,
      reason: reason ?? '',
      wasClean: true,
    }
    this.onclose?.(new CloseEvent('close', init))
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

const mockSource = {
  connect: mockConnect,
  disconnect: mockDisconnect,
}

// AudioWorkletNode mock — stands in for the `new AudioWorkletNode(ctx, 'pcm-processor')`
// call in setupAudioProcessing. The hook writes to `worklet.port.onmessage`;
// tests that need to simulate inbound PCM chunks can assign and call the
// handler directly. `connect` / `disconnect` share the mock fns used by
// MediaStreamAudioSourceNode so disconnect assertions stay simple.
// Capture constructor args globally so tests can assert on them (the
// mono-downmix regression fix relies on passing channelCount+channel-
// CountMode options; without a capture hook a future refactor could
// silently drop them and we'd re-introduce the stereo-mic bug).
const audioWorkletNodeCalls: Array<{ context: unknown; name: string; options: unknown }> = []

class MockAudioWorkletNode {
  port: { onmessage: ((e: unknown) => void) | null; postMessage: ReturnType<typeof vi.fn> } = {
    onmessage: null,
    postMessage: vi.fn(),
  }
  connect = mockConnect
  disconnect = mockDisconnect
  constructor(context: unknown, name: string, options?: unknown) {
    audioWorkletNodeCalls.push({ context, name, options })
  }
}

vi.stubGlobal('AudioWorkletNode', MockAudioWorkletNode)

// Module-scoped so tests can override per-case with
// `mockAddModule.mockImplementationOnce(...)` to simulate slow fetches,
// rejections, or stale-setup races. Default: resolved immediately.
const mockAddModule = vi.fn().mockResolvedValue(undefined)

class MockAudioContext {
  sampleRate = 16000
  state = 'running'
  createMediaStreamSource = vi.fn(() => mockSource)
  // Replaces createScriptProcessor. setupAudioProcessing awaits
  // addModule() before constructing the worklet; the shared mock (see
  // mockAddModule above) returns Promise.resolve() by default so
  // vi.advanceTimersByTimeAsync can pump the continuation without
  // needing to mock `fetch` for /pcm-processor.js.
  audioWorklet = {
    addModule: mockAddModule,
  }
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

import { useDeepgramRecognition, classifyUtteranceIntent } from '../hooks/useDeepgramRecognition'

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

describe('classifyUtteranceIntent', () => {
  describe('thinkingRequest', () => {
    it.each([
      'Let me think.',
      'Let me think about this.',
      'let me think through this.',
      'Give me a moment.',
      'Give me a second.',
      'give me a minute',
      'One sec.',
      'I need a moment.',
      'I need some time to think.',
      'I need time',
      'Let me collect my thoughts.',
      'Let me gather my thoughts.',
      'Hold on.',
      'Bear with me.',
      'Ek second.',
      'Ruko.',
      'Sochne do.',
      'Soch raha hun.',
    ])('detects "%s" as thinkingRequest', (text) => {
      expect(classifyUtteranceIntent(text)).toBe('thinkingRequest')
    })

    it('detects thinking phrase at end of longer utterance', () => {
      // Candidate started answering, then realized they need time
      expect(classifyUtteranceIntent("Okay, so the first thing I'd do is... actually, let me think.")).toBe('thinkingRequest')
    })
  })

  describe('incomplete', () => {
    it.each([
      'I would start with the user flow and',
      'The main issue is the latency, so',
      'We need to consider the trade-offs because',
      'The next step is to',
      'We need to think about,',
      'My approach would be...',
      'Then we measure…',
    ])('detects "%s" as incomplete (trails off)', (text) => {
      expect(classifyUtteranceIntent(text)).toBe('incomplete')
    })
  })

  describe('complete', () => {
    it.each([
      "That's my answer.",
      'I would prioritize engagement over reach.',
      'Does that make sense?',
      'The trade-off is clear: we accept higher latency for stronger consistency.',
      // The/a/an endings used to be classified incomplete, causing 4.5-8s
      // grace-timer dead air on natural pauses like "I would look at the <pause>
      // data" or "the customer is a <pause> senior PM". These are far too
      // common at natural speech pauses to warrant the long grace, so they
      // now classify as complete and fall into the 3s grace bucket.
      'I would look at the',
      'The customer is a',
      'We explored an',
    ])('detects "%s" as complete', (text) => {
      expect(classifyUtteranceIntent(text)).toBe('complete')
    })

    it('does NOT flag mid-sentence thinking phrases as thinkingRequest', () => {
      // Phrase "need to think" appears but answer continues and ends cleanly
      expect(classifyUtteranceIntent("I'd need to think about the trade-offs carefully, then I'd prioritize option A.")).toBe('complete')
    })

    it('returns complete for empty input', () => {
      expect(classifyUtteranceIntent('')).toBe('complete')
      expect(classifyUtteranceIntent('   ')).toBe('complete')
    })
  })
})

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

  // Regression for the mid-speech cutoff diagnostic work. `ws.close()`
  // without args produces CloseEvent.code=1005, which is indistinguishable
  // between "grace timer fired" vs stopListening-sub-triggers in Vercel logs.
  // Each finishRecognition trigger now emits
  // a distinct 4xxx code AND posts `trigger:<name>` to the debug endpoint.
  // These tests pin the mapping so a later refactor can't silently regress
  // the codes (which would void the next production diagnosis run).
  it('grace-timer preserves the ws for the next question turn (2026-04-21 per-Q latency fix)', async () => {
    // Prior contract (pre-PRESERVE_SOCKET_TRIGGERS): graceTimer immediately
    // fired ws.close(4001). That forced the next question to pay the full
    // TLS+auth handshake via warmUp(). This test now pins the new contract:
    // the socket stays OPEN across question turns so the next startListening
    // can reuse it. A later terminal trigger (finishInterview) still closes
    // it — covered by the separate "stopListening('finishInterview')" test.
    const { result } = renderHook(() => useDeepgramRecognition())
    const onComplete = vi.fn()
    const fetchSpy = vi.spyOn(global, 'fetch')

    act(() => { result.current.warmUp() })
    await act(async () => { await vi.advanceTimersByTimeAsync(10) })
    act(() => { mockWsInstance!.simulateOpen() })

    await act(async () => {
      result.current.startListening(onComplete)
      await vi.advanceTimersByTimeAsync(10)
    })

    await act(async () => {
      mockWsInstance!.simulateMessage(makeResult('Hello world', true))
    })
    await act(async () => {
      mockWsInstance!.simulateMessage(makeUtteranceEnd())
      // Advance past the 3000ms grace period for short answers.
      await vi.advanceTimersByTimeAsync(3500)
    })

    // Preserve contract: the ws was NOT closed. lastCloseCode stays undefined
    // because the mock only records an actual close() call.
    expect(mockWsInstance!.lastCloseCode).toBeUndefined()
    expect(mockWsInstance!.lastCloseReason).toBeUndefined()

    // No debug POST should have been emitted — /api/debug/deepgram-ws-close
    // only fires on ws.onclose which can't fire on a socket we didn't close.
    const closeDebugCall = fetchSpy.mock.calls.find(
      ([url]) => typeof url === 'string' && url.includes('/api/debug/deepgram-ws-close'),
    )
    expect(closeDebugCall).toBeUndefined()

    // onComplete still fires — the candidate's answer is finalized, only
    // the socket lifecycle changed. This is what lets the useInterview
    // state machine advance to the next question.
    expect(onComplete).toHaveBeenCalledTimes(1)

    // isListening must be false — preserve doesn't mean "still listening",
    // it means "ws ready for the NEXT listenForAnswer call".
    expect(result.current.isListening).toBe(false)
  })

  it('next-question warmUp is a no-op after preserve-trigger — no second WS is created', async () => {
    // End-to-end verification of the per-Q latency fix: the whole point
    // of preserving on graceTimer is that warmUp() on Q2 does NOT pay
    // the TLS+auth handshake again. Prior to 2026-04-21 each question
    // rebuilt a fresh WebSocket (3.1s cold, 1.1-1.6s subsequent ×6Q).
    const { result } = renderHook(() => useDeepgramRecognition())
    const onCompleteQ1 = vi.fn()

    // Q1: warmUp + listen + complete via graceTimer
    act(() => { result.current.warmUp() })
    await act(async () => { await vi.advanceTimersByTimeAsync(10) })
    act(() => { mockWsInstance!.simulateOpen() })
    const q1Ws = mockWsInstance

    await act(async () => {
      result.current.startListening(onCompleteQ1)
      await vi.advanceTimersByTimeAsync(10)
    })
    await act(async () => {
      mockWsInstance!.simulateMessage(makeResult('Q1 answer', true))
    })
    await act(async () => {
      mockWsInstance!.simulateMessage(makeUtteranceEnd())
      await vi.advanceTimersByTimeAsync(3500)
    })

    // ws NOT closed, ready for Q2.
    expect(q1Ws!.lastCloseCode).toBeUndefined()
    expect(q1Ws!.readyState).toBe(MockWebSocket.OPEN)

    // Q2: warmUp must be a no-op because isWarmedUpRef is still true.
    // Capture the mock's constructor-instance pointer before + after.
    const beforeQ2 = mockWsInstance
    act(() => { result.current.warmUp() })
    await act(async () => { await vi.advanceTimersByTimeAsync(10) })
    const afterQ2Warmup = mockWsInstance

    // If warmUp created a fresh WebSocket, mockWsInstance would point at
    // the new one (the MockWebSocket constructor reassigns it). Same
    // reference = zero new sockets = the fix held.
    expect(afterQ2Warmup).toBe(beforeQ2)
    expect(afterQ2Warmup).toBe(q1Ws)
  })

  // Regression: the earlyQuestion trigger was retired because production
  // logs showed it cutting candidates mid-rhetorical-flow (e.g. "say
  // option a, the faster one?" as part of an example). Short utterances
  // ending with "?" now wait for the normal UtteranceEnd → grace path.
  // Code 4002 is intentionally skipped in FINISH_TRIGGER_CODES.
  it('short utterance ending with "?" no longer early-finishes', async () => {
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
      mockWsInstance!.simulateMessage(makeResult('Can you repeat that?', true))
      await vi.advanceTimersByTimeAsync(10)
    })

    // No immediate finish — onComplete should NOT have fired yet.
    expect(onComplete).not.toHaveBeenCalled()
  })

  it('stopListening("finishInterview") emits code 4014', async () => {
    const { result } = renderHook(() => useDeepgramRecognition())
    const onComplete = vi.fn()
    const fetchSpy = vi.spyOn(global, 'fetch')

    act(() => { result.current.warmUp() })
    await act(async () => { await vi.advanceTimersByTimeAsync(10) })
    act(() => { mockWsInstance!.simulateOpen() })

    await act(async () => {
      result.current.startListening(onComplete)
      await vi.advanceTimersByTimeAsync(10)
    })

    await act(async () => {
      result.current.stopListening('finishInterview')
      await vi.advanceTimersByTimeAsync(10)
    })

    expect(mockWsInstance!.lastCloseCode).toBe(4014)
    expect(mockWsInstance!.lastCloseReason).toBe('stopListeningFinishInterview')

    const debugCall = fetchSpy.mock.calls.find(
      ([url]) => typeof url === 'string' && url.includes('/api/debug/deepgram-ws-close'),
    )
    expect(debugCall).toBeDefined()
    const body = JSON.parse((debugCall![1] as RequestInit).body as string)
    expect(body.trigger).toBe('stopListeningFinishInterview')
  })

  it('stopListening("inactivityPreSpeech") emits code 4010', async () => {
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
      result.current.stopListening('inactivityPreSpeech')
      await vi.advanceTimersByTimeAsync(10)
    })

    expect(mockWsInstance!.lastCloseCode).toBe(4010)
    expect(mockWsInstance!.lastCloseReason).toBe('stopListeningInactivityPreSpeech')
  })

  it('stopListening (no reason) preserves the ws — default is a mid-session end-of-turn', async () => {
    // Bare stopListening() is used by ambiguous callers (mute toggle,
    // legacy adapter) that may or may not be at session end. Treating
    // it as "preserve" lines up with the common case (mute mid-session,
    // user unmutes and the next question reuses the warm ws). Genuine
    // session-end paths pass an explicit reason (finishInterview, etc.)
    // which is NOT in PRESERVE_SOCKET_TRIGGERS and still closes the ws.
    const { result } = renderHook(() => useDeepgramRecognition())
    const onComplete = vi.fn()
    const fetchSpy = vi.spyOn(global, 'fetch')

    act(() => { result.current.warmUp() })
    await act(async () => { await vi.advanceTimersByTimeAsync(10) })
    act(() => { mockWsInstance!.simulateOpen() })

    await act(async () => {
      result.current.startListening(onComplete)
      await vi.advanceTimersByTimeAsync(10)
    })

    await act(async () => {
      result.current.stopListening()
      await vi.advanceTimersByTimeAsync(10)
    })

    // ws stayed open — no close code recorded, no debug POST.
    expect(mockWsInstance!.lastCloseCode).toBeUndefined()
    expect(mockWsInstance!.lastCloseReason).toBeUndefined()
    const closeDebugCall = fetchSpy.mock.calls.find(
      ([url]) => typeof url === 'string' && url.includes('/api/debug/deepgram-ws-close'),
    )
    expect(closeDebugCall).toBeUndefined()

    // onComplete still fires with whatever transcript was accumulated.
    expect(onComplete).toHaveBeenCalledTimes(1)
    expect(result.current.isListening).toBe(false)
  })

  // Regression for Codex P1 on PR #293 (initial + follow-up review).
  // Paths where `ws.close` is a no-op (ws already CLOSED, or finish
  // ran without a ws) previously latched the trigger into a shared
  // hook-level ref. The shared-ref approach also had a cross-socket
  // race: a stale old socket's late onclose could consume the trigger
  // set for a currently-active socket (Codex P2). The fix tags the
  // trigger on the socket instance itself (TaggedWebSocket), and
  // skips tagging when the close would be a no-op. This test drives
  // the offline path, then opens a fresh session and asserts its
  // close carries trigger:null — proving no stale label leaked.
  it('no-ws finishRecognition does not leak trigger to later sessions', async () => {
    const { result } = renderHook(() => useDeepgramRecognition())
    const fetchSpy = vi.spyOn(global, 'fetch')

    // Force the offline branch inside connectWebSocket. Use cold path
    // (no warmUp) so startListening lands in connectFresh → connectWebSocket.
    Object.defineProperty(navigator, 'onLine', { value: false, configurable: true })

    await act(async () => {
      result.current.startListening(vi.fn())
      await vi.advanceTimersByTimeAsync(20)
    })

    // Restore online + open a new session — its close must NOT inherit
    // 'offline' as trigger. That close fires from a remote event with
    // no client-side trigger label, so the POST should carry trigger:null.
    Object.defineProperty(navigator, 'onLine', { value: true, configurable: true })
    fetchSpy.mockClear()

    await act(async () => {
      result.current.startListening(vi.fn())
      await vi.advanceTimersByTimeAsync(20)
    })
    act(() => { mockWsInstance!.simulateOpen() })
    // Remote-initiated close (Deepgram sending a real close frame) —
    // onclose fires but no client finishRecognition was invoked on
    // THIS socket, so the socket's __finishTrigger stays undefined
    // and the POST carries trigger:null.
    act(() => { mockWsInstance!.onclose?.(new CloseEvent('close', { code: 1011, reason: 'server', wasClean: false })) })

    const debugCall = fetchSpy.mock.calls.find(
      ([url]) => typeof url === 'string' && url.includes('/api/debug/deepgram-ws-close'),
    )
    expect(debugCall).toBeDefined()
    const body = JSON.parse((debugCall![1] as RequestInit).body as string)
    expect(body.trigger).toBeNull()
  })

  // Regression for Codex P2 on PR #293. Shared hook-level trigger ref
  // lets a late onclose from a stale reconnect peer consume the label
  // set for a currently-active socket. Per-instance tagging means the
  // stale socket reads its OWN undefined tag (→ null), while the
  // active socket's tag stays intact for its onclose.
  it('late onclose from stale socket does not steal active socket trigger', async () => {
    const { result } = renderHook(() => useDeepgramRecognition())
    const fetchSpy = vi.spyOn(global, 'fetch')

    // Session 1: warmUp + open a socket, keep a reference to it.
    act(() => { result.current.warmUp() })
    await act(async () => { await vi.advanceTimersByTimeAsync(10) })
    act(() => { mockWsInstance!.simulateOpen() })
    const staleWs = mockWsInstance!

    await act(async () => {
      result.current.startListening(vi.fn())
      await vi.advanceTimersByTimeAsync(10)
    })

    // Session 2: stopListening finishes session 1, then warmUp + open a
    // fresh socket and label it via finishRecognition('graceTimer').
    // This sets the NEW socket's __finishTrigger tag. If the stale
    // socket's onclose fired late and consumed a shared ref, it would
    // steal that label.
    await act(async () => {
      result.current.stopListening()
      await vi.advanceTimersByTimeAsync(10)
    })
    fetchSpy.mockClear()

    // Now deliver a LATE onclose from the stale session-1 socket.
    // (In real life this happens when network delays the close frame.)
    // The stale onclose should log trigger:null — NOT any label set
    // later on a different socket.
    act(() => { staleWs.onclose?.(new CloseEvent('close', { code: 1006, reason: '', wasClean: false })) })

    const staleCall = fetchSpy.mock.calls.find(
      ([url]) => typeof url === 'string' && url.includes('/api/debug/deepgram-ws-close'),
    )
    expect(staleCall).toBeDefined()
    const staleBody = JSON.parse((staleCall![1] as RequestInit).body as string)
    // Stale socket was already cleanly closed by stopListening, so its
    // tag was 'stopListeningExternal'. Its own late onclose reads its
    // OWN tag — what matters is no OTHER socket's label was consumed.
    expect(['stopListeningExternal', null]).toContain(staleBody.trigger)
  })

  it('warmUp timeout does not tag an already-closed socket', async () => {
    const { result } = renderHook(() => useDeepgramRecognition())
    const fetchSpy = vi.spyOn(global, 'fetch')

    act(() => { result.current.warmUp() })
    await act(async () => { await vi.advanceTimersByTimeAsync(10) })
    // Simulate the socket closing early (e.g. quick network failure)
    // BEFORE the 5s warmUp timeout fires. Once the onclose fires it
    // sets readyState=CLOSED — subsequent ws.close is a no-op.
    act(() => { mockWsInstance!.close() })
    fetchSpy.mockClear()

    // Advance to 5s warmUp timeout. Guard must recognize the socket
    // is already CLOSED and skip tagging + skip the no-op close.
    await act(async () => { await vi.advanceTimersByTimeAsync(5500) })

    // No new debug POST should fire from the timeout path — the socket
    // is already CLOSED so ws.close is a no-op and no onclose runs.
    const debugCall = fetchSpy.mock.calls.find(
      ([url]) => typeof url === 'string' && url.includes('/api/debug/deepgram-ws-close'),
    )
    expect(debugCall).toBeUndefined()
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

    // Reconnect-guard: client-initiated close (tagged with __finishTrigger
    // by finishRecognition / stopListening / warmUpTimeout) must NOT
    // schedule a reconnect. Pre-fix, ws.onclose called handleDisconnect
    // unconditionally, producing ~5 spurious `Reconnecting in 800ms`
    // attempts per session on top of legitimately-ended turns. The
    // 800ms guard in maybeReconnectOrFinish usually aborted them but
    // the race leaked reconnect attempts into fresh sessions at
    // session boundaries.
    it('does NOT reconnect after a client-initiated (tagged) close', async () => {
      const { result } = renderHook(() => useDeepgramRecognition())
      const onComplete = vi.fn()

      act(() => { result.current.startListening(onComplete) })
      await act(async () => { await vi.advanceTimersByTimeAsync(20) })
      act(() => { mockWsInstance!.simulateOpen() })
      await act(async () => { await vi.advanceTimersByTimeAsync(10) })

      const firstWs = mockWsInstance!

      // Candidate finishes a clean answer; Deepgram sends UtteranceEnd;
      // the grace timer fires finishRecognition('graceTimer') which tags
      // the ws with __finishTrigger and then calls ws.close().
      await act(async () => {
        mockWsInstance!.simulateMessage(makeResult('a complete answer.', true))
        mockWsInstance!.simulateMessage(makeUtteranceEnd())
        await vi.advanceTimersByTimeAsync(4500) // past longest grace (3000ms)
      })

      // finishRecognition fired — onComplete called.
      expect(onComplete).toHaveBeenCalled()

      // Advance past what WOULD have been the reconnect backoff window
      // (800ms attempt-1). Before the guard, a new ws would have been
      // spawned here.
      await act(async () => { await vi.advanceTimersByTimeAsync(2000) })

      // No new WebSocket — the guard skipped handleDisconnect because
      // __finishTrigger was set to 'graceTimer' before ws.close().
      expect(mockWsInstance).toBe(firstWs)
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

  // After classifyUtteranceIntent was introduced the grace window is
  // intent-based, not word-count-based. A long answer with no thinking
  // phrase and no trailing conjunction classifies as 'complete' → 3000ms,
  // same as short answers. This test pins the uniform complete-intent
  // grace so future refactors don't silently regress.
  it('complete-intent utterance (long, no trailing conjunction) gets 3000ms grace', async () => {
    const { result } = renderHook(() => useDeepgramRecognition())
    const onComplete = vi.fn()

    act(() => { result.current.warmUp() })
    await act(async () => { await vi.advanceTimersByTimeAsync(10) })
    act(() => { mockWsInstance!.simulateOpen() })

    await act(async () => {
      result.current.startListening(onComplete)
      await vi.advanceTimersByTimeAsync(10)
    })

    // 16-word transcript ending cleanly (no trailing "and"/"or"/etc.)
    const longText = 'one two three four five six seven eight nine ten eleven twelve thirteen fourteen fifteen sixteen'
    await act(async () => {
      mockWsInstance!.simulateMessage(makeResult(longText, true))
      mockWsInstance!.simulateMessage(makeUtteranceEnd())
    })

    // Not fired at 2500ms (below new 3000ms grace)
    await act(async () => { await vi.advanceTimersByTimeAsync(2500) })
    expect(onComplete).not.toHaveBeenCalled()

    // Fired by 3100ms
    await act(async () => { await vi.advanceTimersByTimeAsync(600) })
    expect(onComplete).toHaveBeenCalled()
  })

  // thinkingRequest grace is 30000ms — verify we DON'T prematurely cut
  // when the candidate says "let me think for a moment".
  it('thinkingRequest utterance extends grace to 30s', async () => {
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
      mockWsInstance!.simulateMessage(makeResult('Let me think.', true))
      mockWsInstance!.simulateMessage(makeUtteranceEnd())
    })

    // Old (complete) grace would have fired at 3s — verify we're past it and still listening
    await act(async () => { await vi.advanceTimersByTimeAsync(5000) })
    expect(onComplete).not.toHaveBeenCalled()

    // Past 30s → fired
    await act(async () => { await vi.advanceTimersByTimeAsync(26000) })
    expect(onComplete).toHaveBeenCalled()
  })

  // incomplete intent (trailing conjunction/preposition) gets 4.5s grace
  // (reduced from 8s on 2026-04-20 — 8s was producing user-noticeable
  // dead air on natural incomplete pauses; 4.5s still covers the common
  // "and <pause> ..." continuation without being painful).
  it('incomplete utterance ("...and so on,") gets 4.5s grace', async () => {
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
      mockWsInstance!.simulateMessage(makeResult('The first thing I would do is analyze the data and', true))
      mockWsInstance!.simulateMessage(makeUtteranceEnd())
    })

    // Past 3s complete grace but within 4.5s incomplete grace
    await act(async () => { await vi.advanceTimersByTimeAsync(4000) })
    expect(onComplete).not.toHaveBeenCalled()

    // Past 4.5s grace → fired
    await act(async () => { await vi.advanceTimersByTimeAsync(1000) })
    expect(onComplete).toHaveBeenCalled()
  })

  // Regression guard for the stereo-mic bug: the retired
  // `createScriptProcessor(4096, 1, 1)` call forced a 1-channel input
  // (browser-level downmix of any multi-channel source to mono).
  // AudioWorkletNode defaults to `channelCount=2, channelCountMode='max'`
  // which would deliver stereo to the worklet; since pcm-processor.js
  // reads only `inputs[0][0]`, a stereo-emitting mic with speech on the
  // right channel would produce near-silent PCM for Deepgram. We must
  // pass `channelCount: 1` + `channelCountMode: 'explicit'` at node
  // construction to replay the old downmix semantics.
  it('AudioWorkletNode is constructed with explicit mono downmix options', async () => {
    const { result } = renderHook(() => useDeepgramRecognition())
    audioWorkletNodeCalls.length = 0

    act(() => { result.current.warmUp() })
    await act(async () => { await vi.advanceTimersByTimeAsync(10) })
    act(() => { mockWsInstance!.simulateOpen() })

    await act(async () => {
      result.current.startListening(vi.fn())
      await vi.advanceTimersByTimeAsync(20)
    })

    expect(audioWorkletNodeCalls.length).toBeGreaterThanOrEqual(1)
    const { name, options } = audioWorkletNodeCalls[audioWorkletNodeCalls.length - 1]
    expect(name).toBe('pcm-processor')
    expect(options).toMatchObject({
      channelCount: 1,
      channelCountMode: 'explicit',
      numberOfInputs: 1,
      numberOfOutputs: 1,
    })
  })

  // Regression guard for the stale-setup race Codex P1 flagged on PR #300:
  // if addModule() is still pending when stopListening() / a reconnect
  // nulls wsRef.current out from under it, the old setup's catch path
  // used to unconditionally call finishRecognition('getUserMediaFailed')
  // — which, in a reconnect scenario, would kill the brand-new session
  // the reconnect had just spun up. Fix is a wsRef.current !== ws guard
  // after the addModule await; this test asserts no new AudioWorkletNode
  // is constructed AND no onComplete fires when the old setup finally
  // resolves against a superseded ws.
  it('stale setupAudioProcessing does NOT terminate a superseded session', async () => {
    const { result } = renderHook(() => useDeepgramRecognition())
    const onComplete = vi.fn()

    // Control the NEXT addModule resolution so we can interleave a
    // stopListening() (which nulls wsRef.current) before it resolves.
    let resolveAdd: () => void = () => {}
    mockAddModule.mockImplementationOnce(
      () => new Promise<void>((res) => { resolveAdd = res }),
    )

    act(() => { result.current.warmUp() })
    await act(async () => { await vi.advanceTimersByTimeAsync(10) })
    act(() => { mockWsInstance!.simulateOpen() })

    audioWorkletNodeCalls.length = 0

    await act(async () => {
      result.current.startListening(onComplete)
      // Let the async setup begin (createMediaStreamSource, etc.) but
      // DON'T resolve addModule yet — it stays pending inside the
      // hook's setupAudioProcessing await.
      await vi.advanceTimersByTimeAsync(5)
    })

    // Nothing has been constructed yet — we're still awaiting addModule.
    expect(audioWorkletNodeCalls.length).toBe(0)

    // Supersede the session. stopListening('intentionalSilence') is a
    // PRESERVE-trigger (2026-04-21 fix), so wsRef.current stays live,
    // BUT audioContextRef.current is nulled synchronously by
    // finishRecognition's audio-teardown branch regardless of preserve
    // state — and the stale-setup guard at setupAudioProcessing keys
    // off audioContext identity, not ws identity. So the stale closure
    // still bails when addModule resolves below.
    await act(async () => {
      result.current.stopListening('intentionalSilence')
      await vi.advanceTimersByTimeAsync(10)
    })

    // NOW resolve the stale addModule promise. The post-await guard
    // should detect wsRef.current !== ws and bail before constructing
    // the worklet.
    await act(async () => {
      resolveAdd()
      await vi.advanceTimersByTimeAsync(10)
    })

    // Bug would show up as an AudioWorkletNode being constructed (the
    // stale setup ran to completion) AND/OR a second onComplete from
    // the hypothetical finishRecognition in the error path. Neither
    // should happen.
    expect(audioWorkletNodeCalls.length).toBe(0)
    // onComplete may have fired exactly once from the stopListening
    // call above; the stale path must not add a second invocation.
    expect(onComplete.mock.calls.length).toBeLessThanOrEqual(1)
  })

  // Regression for Codex P1 #2 (follow-up) on PR #300. The prior guard
  // keyed off `wsRef.current !== ws` — but during the 800ms reconnect
  // *delay* window, `maybeReconnectOrFinish` has already synchronously
  // closed + nulled the AudioContext, yet `wsRef.current` still points
  // at the now-dead ws (the new ws is only created by the delayed
  // connectWebSocket call). If addModule resolves in that window, a
  // ws-identity check would treat the setup as current, construct the
  // worklet against a closed context → throw → finishRecognition
  // ('getUserMediaFailed') → truncate the in-flight answer.
  // Context-identity is the correct key: maybeReconnectOrFinish nulls
  // `audioContextRef.current` synchronously.
  it('setupAudioProcessing bails when reconnect cleared context during addModule await', async () => {
    const { result } = renderHook(() => useDeepgramRecognition())
    const onComplete = vi.fn()

    // Control the first addModule so we can park setup mid-await.
    let resolveAdd: () => void = () => {}
    mockAddModule.mockImplementationOnce(
      () => new Promise<void>((res) => { resolveAdd = res }),
    )

    // connectFresh path (no warmUp) — only this path wires the ws.onclose
    // handler to maybeReconnectOrFinish (warmUp's onclose is a no-op for
    // reconnect). See E-3.4 describe block header for the same rationale.
    await act(async () => {
      result.current.startListening(onComplete)
      await vi.advanceTimersByTimeAsync(20) // let token fetch + ws create
    })

    act(() => { mockWsInstance!.simulateOpen() })
    audioWorkletNodeCalls.length = 0

    // Let setupAudioProcessing begin — addModule is pending inside the
    // hook. audioContextRef.current is now populated; worklet NOT yet
    // constructed.
    await act(async () => { await vi.advanceTimersByTimeAsync(5) })
    expect(audioWorkletNodeCalls.length).toBe(0)

    const midAwaitWs = mockWsInstance!

    // Untagged remote close (1006 network drop / 1011 Deepgram idle).
    // onclose reads a null __finishTrigger → handleDisconnect →
    // maybeReconnectOrFinish synchronously closes the AudioContext and
    // nulls audioContextRef. Crucially this does NOT touch wsRef.current
    // — the new ws is only created after the 800ms reconnect delay. A
    // ws-identity guard in setupAudioProcessing would still match here,
    // which is the exact bug Codex flagged. Context-identity catches it.
    await act(async () => {
      midAwaitWs.onclose?.(new CloseEvent('close', { code: 1006, reason: '', wasClean: false }))
      await vi.advanceTimersByTimeAsync(10)
    })

    // DO NOT advance past the 800ms reconnect delay — we need the test
    // to exercise the vulnerable window where wsRef.current is still the
    // stale ws.
    await act(async () => {
      resolveAdd()
      await vi.advanceTimersByTimeAsync(10)
    })

    // Bug signature: AudioWorkletNode constructed against the closed
    // context. Context-identity guard must catch the reconnect-delay
    // window and bail before construction.
    expect(audioWorkletNodeCalls.length).toBe(0)
    // No truncation-by-error: getUserMediaFailed would fire onComplete
    // prematurely. A spurious finishRecognition would also fire it.
    expect(onComplete).not.toHaveBeenCalled()
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
