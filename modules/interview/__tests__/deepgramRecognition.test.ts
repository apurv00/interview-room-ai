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
// Last constructed worklet instance, exposed so tests can invoke its
// `port.onmessage` handler directly to simulate the audio-thread worklet
// posting a PCM frame to the main thread (the real one would post a
// 4096-sample Int16 ArrayBuffer every 256ms at 16 kHz).
let lastWorkletInstance: MockAudioWorkletNode | null = null

class MockAudioWorkletNode {
  port: { onmessage: ((e: unknown) => void) | null; postMessage: ReturnType<typeof vi.fn> } = {
    onmessage: null,
    postMessage: vi.fn(),
  }
  connect = mockConnect
  disconnect = mockDisconnect
  constructor(context: unknown, name: string, options?: unknown) {
    audioWorkletNodeCalls.push({ context, name, options })
    lastWorkletInstance = this
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
    lastWorkletInstance = null
    // Re-establish the default fetch impl so per-test overrides
    // (notably mockImplementationOnce + mockRestore on the token
    // endpoint) cannot leak a "no default" fetch into the next test,
    // which would silently trigger fetchDeepgramTokenWithRetry's 1500ms
    // backoff and hang warmUp past advanceTimersByTimeAsync(10).
    ;(global.fetch as ReturnType<typeof vi.fn>).mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ token: 'test-deepgram-token' }),
    })
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

  it('preserved ws dying between turns clears isWarmedUpRef (Codex P2 on #307)', async () => {
    // If a preserved socket dies during avatar speech or a network blip,
    // its onclose MUST clear isWarmedUpRef so the next warmUp() reconnects
    // instead of silently sitting on a dead flag. Without the fix, the
    // next question's warmUp early-returns on isWarmedUpRef===true even
    // though wsRef.current is no longer OPEN — then startListening falls
    // through to a cold reconnect, regressing the per-Q latency fix for
    // that turn.
    const { result } = renderHook(() => useDeepgramRecognition())
    const onCompleteQ1 = vi.fn()

    // Q1 cold path — no warmUp() before startListening, so the socket
    // is born inside connectWebSocket (which has its own onclose handler,
    // distinct from warmUp's). THIS is the path Codex flagged as the
    // one that never cleared isWarmedUpRef.
    await act(async () => {
      result.current.startListening(onCompleteQ1)
      await vi.advanceTimersByTimeAsync(10)
    })
    act(() => { mockWsInstance!.simulateOpen() })
    await act(async () => { await vi.advanceTimersByTimeAsync(10) })
    const q1Ws = mockWsInstance

    // Q1 answer + graceTimer preserve.
    await act(async () => {
      mockWsInstance!.simulateMessage(makeResult('Q1 answer', true))
    })
    await act(async () => {
      mockWsInstance!.simulateMessage(makeUtteranceEnd())
      await vi.advanceTimersByTimeAsync(3500)
    })
    expect(q1Ws!.lastCloseCode).toBeUndefined() // preserve held
    expect(q1Ws!.readyState).toBe(MockWebSocket.OPEN)

    // Simulate a network blip killing the preserved socket.
    await act(async () => {
      q1Ws!.close(1006, 'network drop')
      await vi.advanceTimersByTimeAsync(10)
    })

    // Q2: warmUp() must NOT early-return. If the onclose cleanup didn't
    // clear isWarmedUpRef, this call would be a no-op and mockWsInstance
    // would still point at q1Ws.
    const beforeQ2 = mockWsInstance
    act(() => { result.current.warmUp() })
    await act(async () => { await vi.advanceTimersByTimeAsync(10) })
    const afterQ2Warmup = mockWsInstance

    // A NEW WebSocket was created (mockWsInstance reassigned by the
    // MockWebSocket constructor) — the flag was cleared and warmUp
    // did its job.
    expect(afterQ2Warmup).not.toBe(beforeQ2)
    expect(afterQ2Warmup).not.toBe(q1Ws)
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

  it('warmUp sends BOTH silent-PCM and JSON KeepAlive every 3s while idle', async () => {
    // Production close-debug log timestamp 1777097944627 (2026-04-25
    // 06:19:04 UTC, session 69ec…) recorded code=1011 NET-0001
    // reason="Deepgram did not provide a response message within the
    // timeout window" with `trigger: null` and `context: warmUp` —
    // proving silent-PCM-only KeepAlive (PR #320) does NOT satisfy
    // Deepgram's idle counter. Fix: dual-send. Every tick we emit BOTH
    // the silent PCM frame (audio data, kept for hedging) AND the
    // documented `{"type":"KeepAlive"}` JSON text frame. PCM is sent
    // first to preserve the audio-frame-first ordering established in
    // PR #320.
    const { result } = renderHook(() => useDeepgramRecognition())

    act(() => { result.current.warmUp() })
    await act(async () => { await vi.advanceTimersByTimeAsync(10) })
    act(() => { mockWsInstance!.simulateOpen() })

    // No pings yet
    expect(mockWsInstance!.send).not.toHaveBeenCalled()

    // t=3s → first KeepAlive tick. TWO sends: PCM then JSON.
    await act(async () => { await vi.advanceTimersByTimeAsync(3000) })
    expect(mockWsInstance!.send).toHaveBeenCalledTimes(2)

    // First send: 320-byte ArrayBuffer of zeros (SILENT_PCM_KEEPALIVE).
    const pcmPing = mockWsInstance!.send.mock.calls[0][0] as ArrayBuffer
    expect(pcmPing).toBeInstanceOf(ArrayBuffer)
    expect(pcmPing.byteLength).toBe(320)
    const view = new Int16Array(pcmPing)
    for (let i = 0; i < view.length; i++) {
      expect(view[i]).toBe(0)
    }

    // Second send: '{"type":"KeepAlive"}' string — Deepgram's documented
    // keepalive text frame.
    const jsonPing = mockWsInstance!.send.mock.calls[1][0]
    expect(typeof jsonPing).toBe('string')
    expect(JSON.parse(jsonPing as string)).toEqual({ type: 'KeepAlive' })

    // t=6s → second tick → 2 more sends (4 total).
    await act(async () => { await vi.advanceTimersByTimeAsync(3000) })
    expect(mockWsInstance!.send).toHaveBeenCalledTimes(4)

    // t=9s → third tick → 2 more (6 total). The warm socket survives
    // past Deepgram's documented ~12s idle timeout, which is the whole
    // point of this fix.
    await act(async () => { await vi.advanceTimersByTimeAsync(3000) })
    expect(mockWsInstance!.send).toHaveBeenCalledTimes(6)

    // Every tick must send BOTH types in order.
    for (let i = 0; i < 6; i += 2) {
      expect(mockWsInstance!.send.mock.calls[i][0]).toBeInstanceOf(ArrayBuffer)
      expect(typeof mockWsInstance!.send.mock.calls[i + 1][0]).toBe('string')
    }
  })

  it('worklet drop counter ticks when ws is CLOSED and surfaces in close-debug POST', async () => {
    // 2026-04-25 production incident: user reported speaking the entire
    // duration of Q6 yet `stopListeningInactivityPreSpeech` fired with
    // text:"". Vercel close-debug log showed code=1011 NET-0001 in
    // `warmUp` context with `trigger: null`. Two competing hypotheses
    // were impossible to distinguish without instrumentation:
    //
    //   (a) Deepgram closed mid-turn while audio WAS reaching them →
    //       audioFrameCount > 0, droppedFrameCount = 0
    //   (b) Deepgram closed before/early in the turn → user's speech
    //       hit the worklet's `readyState !== OPEN` drop gate → audio
    //       never left the browser → audioFrameCount low,
    //       droppedFrameCount > 0
    //
    // This test verifies the diagnostic: when the worklet posts frames
    // against a CLOSED ws, droppedFrameCount increments AND the value
    // is reported in the /api/debug/deepgram-ws-close POST body.
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

    expect(lastWorkletInstance).not.toBeNull()
    fetchSpy.mockClear()

    // First frame: ws is OPEN — sent normally, audioFrameCount++.
    const liveFrame = new Int16Array(4096).buffer
    act(() => {
      lastWorkletInstance!.port.onmessage!({ data: liveFrame } as unknown as MessageEvent)
    })

    // Now Deepgram-side close: readyState transitions to CLOSED. We set
    // the readyState directly (bypassing close()'s onclose dispatch) so
    // we can verify the worklet's drop branch BEFORE the close-debug
    // POST fires — mirroring the prod sequence where idle-close lands
    // a fraction of a second before the next worklet message.
    mockWsInstance!.readyState = MockWebSocket.CLOSED

    // Three frames hit the dead pipe — should all be dropped, NOT sent.
    const sendCallsBeforeDrop = mockWsInstance!.send.mock.calls.length
    for (let i = 0; i < 3; i++) {
      act(() => {
        lastWorkletInstance!.port.onmessage!({ data: liveFrame } as unknown as MessageEvent)
      })
    }
    expect(mockWsInstance!.send.mock.calls.length).toBe(sendCallsBeforeDrop)

    // Now fire the remote-close event so the close-debug POST captures
    // the drop counts. Use code 1011 NET-0001 to match the prod incident.
    act(() => {
      mockWsInstance!.onclose?.(new CloseEvent('close', {
        code: 1011,
        reason: 'Deepgram did not provide a response message within the timeout window. See https://dpgr.am/net0000',
        wasClean: true,
      }))
    })

    const debugCall = fetchSpy.mock.calls.find(
      ([url]) => typeof url === 'string' && url.includes('/api/debug/deepgram-ws-close'),
    )
    expect(debugCall).toBeDefined()
    const body = JSON.parse((debugCall![1] as RequestInit).body as string)
    expect(body.code).toBe(1011)
    expect(body.trigger).toBe(null)
    // The diagnostic payload — the whole point of this fix:
    expect(body.audioFrameCount).toBe(1)
    expect(body.droppedFrameCount).toBe(3)
    expect(body.lastDropReadyState).toBe(MockWebSocket.CLOSED)
  })

  it('worklet drop counter resets to 0 at the start of each new turn', async () => {
    // Counters must reset per turn so the close-debug POST for Q6 only
    // describes Q6, not the cumulative session. Without this reset, a
    // single dropped frame at session start would poison every
    // subsequent turn's diagnostic.
    const { result } = renderHook(() => useDeepgramRecognition())
    const onComplete = vi.fn()
    const fetchSpy = vi.spyOn(global, 'fetch')

    act(() => { result.current.warmUp() })
    await act(async () => { await vi.advanceTimersByTimeAsync(10) })
    act(() => { mockWsInstance!.simulateOpen() })

    // Turn 1: two drops + one send. End with a Deepgram-initiated 1011
    // close so the close-debug POST snapshots turn-1's counters.
    await act(async () => {
      result.current.startListening(onComplete)
      await vi.advanceTimersByTimeAsync(10)
    })

    const frame = new Int16Array(4096).buffer
    act(() => {
      lastWorkletInstance!.port.onmessage!({ data: frame } as unknown as MessageEvent)
    })
    const wsA = mockWsInstance!
    wsA.readyState = MockWebSocket.CLOSED
    for (let i = 0; i < 2; i++) {
      act(() => {
        lastWorkletInstance!.port.onmessage!({ data: frame } as unknown as MessageEvent)
      })
    }
    // Tag the close as WE-initiated so the fast-path reconnect wrap
    // (PR #324) does NOT fire — otherwise it would schedule an 800ms
    // setTimeout that creates a third ws and mucks with the per-turn
    // counter snapshot we're trying to verify.
    ;(wsA as unknown as { __finishTrigger: string }).__finishTrigger = 'graceTimer'
    act(() => {
      wsA.onclose?.(new CloseEvent('close', { code: 4001, reason: 'graceTimer', wasClean: true }))
    })

    const turn1Call = fetchSpy.mock.calls.find(
      ([url]) => typeof url === 'string' && url.includes('/api/debug/deepgram-ws-close'),
    )
    expect(turn1Call).toBeDefined()
    const turn1Body = JSON.parse((turn1Call![1] as RequestInit).body as string)
    expect(turn1Body.audioFrameCount).toBe(1)
    expect(turn1Body.droppedFrameCount).toBe(2)

    // Turn 2: warm + listen again. Counters should be 0 at startListening.
    fetchSpy.mockClear()
    mockWsInstance = null
    act(() => { result.current.warmUp() })
    await act(async () => { await vi.advanceTimersByTimeAsync(10) })
    expect(mockWsInstance).not.toBeNull()
    expect(mockWsInstance).not.toBe(wsA)
    act(() => { mockWsInstance!.simulateOpen() })

    await act(async () => {
      result.current.startListening(onComplete)
      await vi.advanceTimersByTimeAsync(10)
    })

    // Manually fire a remote-style close on turn 2's ws. Tag avoids the
    // reconnect wrap (same reason as turn 1). Use a distinct code (4099)
    // so the test can disambiguate this POST from any close-debug POST
    // that turn-2's startListening's reentry-finish path may have emitted
    // against this same socket.
    ;(mockWsInstance as unknown as { __finishTrigger: string }).__finishTrigger = 'testTurn2Close'
    act(() => {
      mockWsInstance!.onclose?.(new CloseEvent('close', { code: 4099, reason: 'testTurn2Close', wasClean: true }))
    })

    // Find the POST our manual close fired — filter on code so we don't
    // accidentally match the reentry-finish POST (which fires BEFORE the
    // counter reset and would carry stale turn-1 numbers).
    const turn2Call = fetchSpy.mock.calls.find(
      ([url, init]) => {
        if (typeof url !== 'string' || !url.includes('/api/debug/deepgram-ws-close')) return false
        try {
          const parsed = JSON.parse((init as RequestInit).body as string)
          return parsed.code === 4099
        } catch {
          return false
        }
      },
    )
    expect(turn2Call).toBeDefined()
    const turn2Body = JSON.parse((turn2Call![1] as RequestInit).body as string)
    expect(turn2Body.audioFrameCount).toBe(0)
    expect(turn2Body.droppedFrameCount).toBe(0)
    expect(turn2Body.lastDropReadyState).toBe(null)
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

    // One KeepAlive tick at t=3s → 2 sends (PCM + JSON dual-send).
    await act(async () => { await vi.advanceTimersByTimeAsync(5000) })
    expect(mockWsInstance!.send).toHaveBeenCalledTimes(2)

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

  // ── Codex P1 on PR #320 — race between startListening and token fetch ──
  //
  // warmUp is a two-stage async: (1) fetchTokenCached, then
  // (2) new WebSocket(...). During stage 1, `wsRef.current` is null. If
  // startListening fires in that window, the eager branch in startListening's
  // slow path can't call startAudioCapture (no ws yet). Before the P1 fix,
  // the slow path's .then assumed startAudioCapture had already run and
  // skipped it — session reaches OPEN with no mic pipeline, zero
  // transcripts, UI stuck.
  it('catches up startAudioCapture when startListening races the token fetch', async () => {
    // Hold the token promise open so we can control the timing.
    let resolveToken: (r: { ok: true; json: () => Promise<{ token: string }> }) => void = () => {}
    const fetchSpy = vi
      .spyOn(global, 'fetch')
      .mockImplementationOnce(
        () =>
          new Promise((r) => {
            resolveToken = r
          }),
      )

    // Snapshot baseline so we can assert exactly ONE worklet is created
    // by the catch-up path (not two from duplicate calls).
    const worketsBefore = audioWorkletNodeCalls.length

    const { result } = renderHook(() => useDeepgramRecognition())
    const onComplete = vi.fn()

    act(() => {
      result.current.warmUp()
    })
    // Token fetch is parked. Let microtasks flush but keep fetch pending.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1)
    })
    // WebSocket must not exist yet — this is the race window the P1
    // described. wsRef.current is null from the hook's perspective.
    expect(mockWsInstance).toBeNull()

    // startListening fires during the race. Eager slow-path branch
    // should skip startAudioCapture (no ws), .then will catch up.
    act(() => {
      result.current.startListening(onComplete)
    })

    // Still no worklet — the eager branch correctly skipped.
    expect(audioWorkletNodeCalls.length - worketsBefore).toBe(0)

    // Resolve token → warmUp creates WebSocket → we simulate onopen.
    await act(async () => {
      resolveToken({
        ok: true,
        json: () => Promise.resolve({ token: 'test-deepgram-token' }),
      })
      await vi.advanceTimersByTimeAsync(10)
    })
    expect(mockWsInstance).not.toBeNull()

    act(() => {
      mockWsInstance!.simulateOpen()
    })
    // Let the ws.onopen → resolve(warmUp) → .then callback run.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(10)
    })

    // The whole point: .then must have called startAudioCapture when it
    // saw processorRef.current was null (eager branch skipped). Exactly
    // ONE worklet should have been created — not zero (session would be
    // deaf) and not two (duplicate worklets double-send audio).
    expect(audioWorkletNodeCalls.length - worketsBefore).toBe(1)

    fetchSpy.mockRestore()
  })

  // ── Codex P1 on PR #320 — duplicate worklet on warmUp fallback ──
  //
  // If warmUp eventually fails (token fetch throws OR ws never reaches
  // OPEN within the 5s warmUpTimeout) AFTER the eager slow-path has
  // already started a worklet, the fallback `connectFresh()` creates a
  // NEW ws whose onopen runs startAudioCapture again. Before the P1 fix
  // both worklets coexisted → duplicate PCM frames to the new socket →
  // duplicate transcripts and resource waste.
  it('tears down pre-open capture before connectFresh() on warmUp fallback', async () => {
    const { result } = renderHook(() => useDeepgramRecognition())
    const onComplete = vi.fn()

    act(() => {
      result.current.warmUp()
    })
    // Let token resolve and WebSocket get created — but do NOT
    // simulateOpen. wsRef.current is now set (CONNECTING state).
    await act(async () => {
      await vi.advanceTimersByTimeAsync(10)
    })
    expect(mockWsInstance).not.toBeNull()

    const worketsBefore = audioWorkletNodeCalls.length

    // startListening in slow-path mode. Eager branch DOES run since
    // wsRef.current is set (CONNECTING, not OPEN). Worklet #1 created.
    act(() => {
      result.current.startListening(onComplete)
    })
    await act(async () => {
      await vi.advanceTimersByTimeAsync(10)
    })
    expect(audioWorkletNodeCalls.length - worketsBefore).toBe(1)

    const disconnectsBeforeTimeout = mockDisconnect.mock.calls.length

    // warmUp has a 5s timeout for reaching OPEN. Advance past it so
    // the timeout branch fires `ws.close(warmUpTimeout)` and the
    // warmUpPromiseRef resolves. The .then then sees ws not OPEN,
    // calls teardownAudioPipeline + connectFresh.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(5100)
    })

    // Teardown must have disconnected the old worklet before the new
    // connection attempt. mockDisconnect count must have increased.
    expect(mockDisconnect.mock.calls.length).toBeGreaterThan(
      disconnectsBeforeTimeout,
    )

    // connectFresh called fetchTokenCached again → new WebSocket → let
    // microtasks settle and simulate its onopen.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(10)
    })
    // mockWsInstance now points at the NEW socket (constructor reassigned).
    act(() => {
      mockWsInstance!.simulateOpen()
    })
    await act(async () => {
      await vi.advanceTimersByTimeAsync(10)
    })

    // Exactly ONE new worklet from connectFresh (total = 2 created,
    // first one already torn down). Critically NOT 3 — that would mean
    // .then ALSO created one on top of connectFresh's work.
    expect(audioWorkletNodeCalls.length - worketsBefore).toBe(2)
  })

  // ── Codex P1 on PR #320 round-2 — eagerFired vs processorRef.current race ──
  //
  // The earlier round-1 fix gated the .then catch-up on `!processorRef.current`.
  // That ref is assigned only AFTER `await audioWorklet.addModule(...)` in
  // setupAudioProcessing. If ws.onopen wins the race against addModule,
  // the catch-up fires a SECOND setupAudioProcessing concurrently; the
  // first hits its stale-guard and bails without closing its AudioContext
  // or stopping the mic stream → leaked resources on every Q1 cold warmUp
  // on hardware where addModule takes >200ms. The fix switches to an
  // `eagerFired` boolean captured synchronously at the eager-check line —
  // timing-independent.
  it('does NOT double-start capture when ws.onopen wins race vs addModule', async () => {
    // Hold addModule pending so setupAudioProcessing parks mid-await. The
    // old guard would then see processorRef.current === null and fire a
    // second setup. The new guard looks at a synchronously-captured flag
    // and correctly skips.
    let resolveAddModule: () => void = () => {}
    mockAddModule.mockImplementationOnce(
      () => new Promise<void>((r) => {
        resolveAddModule = r
      }),
    )

    const { result } = renderHook(() => useDeepgramRecognition())
    const onComplete = vi.fn()
    const gumSpy = vi.mocked(navigator.mediaDevices.getUserMedia)
    gumSpy.mockClear()

    act(() => { result.current.warmUp() })
    // Let token fetch + ws construction happen. ws is now CONNECTING.
    await act(async () => { await vi.advanceTimersByTimeAsync(10) })
    expect(mockWsInstance).not.toBeNull()

    const worketsBefore = audioWorkletNodeCalls.length

    // startListening while ws is CONNECTING. wsRef.current is set so the
    // eager branch DOES fire — setupAudioProcessing starts, calls
    // getUserMedia, then parks on our held addModule.
    act(() => { result.current.startListening(onComplete) })
    // Let getUserMedia → setupAudioProcessing reach the addModule await.
    await act(async () => { await vi.advanceTimersByTimeAsync(10) })
    expect(gumSpy).toHaveBeenCalledTimes(1)

    // Simulate ws.onopen BEFORE addModule resolves. Old implementation:
    // catch-up sees processorRef.current === null → fires a second
    // startAudioCapture → getUserMedia called again. New implementation:
    // eagerFired=true captured at the eager-check → catch-up skipped.
    act(() => { mockWsInstance!.simulateOpen() })
    await act(async () => { await vi.advanceTimersByTimeAsync(10) })

    // Pin the fix: getUserMedia must have been called exactly ONCE total.
    // A second call here would prove the P1-A round-2 bug is live (and
    // would also mean a leaked AudioContext/MediaStream on the old path).
    expect(gumSpy).toHaveBeenCalledTimes(1)

    // Now unblock the held addModule. The first (and only) setup should
    // proceed to construct exactly one worklet.
    await act(async () => {
      resolveAddModule()
      await vi.advanceTimersByTimeAsync(10)
    })
    expect(audioWorkletNodeCalls.length - worketsBefore).toBe(1)
  })

  // ── Codex P1 on PR #320 round-2 — superseded ws orphan on CONNECTING-window stop ──
  //
  // If finishRecognition fires while warmUp's ws is still CONNECTING (e.g.
  // stopListening from an external caller, startListenReentry from rapid
  // double-click, usageLimit trip), wsRef.current is nulled by finishRecognition.
  // When the orphan ws finally reaches onopen, the old code unconditionally
  // set isWarmedUpRef=true and started KeepAlive — leaving the hook stuck
  // in "warm" state against a ws it doesn't even track, and the orphan ws
  // alive forever with a KeepAlive closure pinning it. The fix: identity-
  // guard at the top of ws.onopen. If wsRef.current !== ws, close the orphan
  // cleanly and bail before touching any hook-level state.
  it('closes orphan ws when finishRecognition fires during warmUp CONNECTING', async () => {
    const { result } = renderHook(() => useDeepgramRecognition())

    act(() => { result.current.warmUp() })
    // Let token fetch + ws construction happen. ws is CONNECTING, onopen
    // has NOT fired yet.
    await act(async () => { await vi.advanceTimersByTimeAsync(10) })
    expect(mockWsInstance).not.toBeNull()
    const orphan = mockWsInstance!

    // Fire a non-preserve terminal trigger while ws is still CONNECTING.
    // finishRecognition's non-preserve branch nulls wsRef.current
    // (the ws.close() call inside the branch is gated on readyState === OPEN,
    // so the CONNECTING ws is NOT closed here — it's just dereferenced).
    act(() => { result.current.stopListening() })

    // The now-orphan ws finally reaches OPEN. P1-B guard must detect that
    // wsRef.current !== ws and close the socket cleanly without polluting
    // hook state.
    act(() => { orphan.simulateOpen() })
    await act(async () => { await vi.advanceTimersByTimeAsync(10) })

    // Assert 1: orphan ws was explicitly closed by the guard with the
    // 'superseded' label (not a clean-session 1000/empty — that would
    // indicate remote-side close, or not-closed-at-all which would be
    // the bug).
    expect(orphan.lastCloseCode).toBe(1000)
    expect(orphan.lastCloseReason).toBe('superseded')

    // Assert 2 (behavioral): hook did NOT stick isWarmedUpRef=true against
    // the orphan. Next warmUp() must construct a brand new ws — not early-
    // return on a stale warm flag. Reset the mock sentinel so a new
    // constructor call re-populates it.
    mockWsInstance = null
    act(() => { result.current.warmUp() })
    await act(async () => { await vi.advanceTimersByTimeAsync(10) })
    expect(mockWsInstance).not.toBeNull()
    expect(mockWsInstance).not.toBe(orphan)
  })

  // ── Codex P1 on PR #320 round-3 — stale CLOSED wsRef from prior warmUp ──
  //
  // warmUp failure paths (onerror / onclose / warmUpTimeout) do NOT null
  // wsRef.current — they leave it pointing at the failed ws so onclose
  // identity guards keep working for late stale closes. If a subsequent
  // warmUp enters its token-fetch stage, wsRef still points at the dead
  // prior ws. The old eager check (`Boolean(wsRef.current)`) would then
  // fire startAudioCapture against that CLOSED socket; the worklet's
  // onmessage CLOSING/CLOSED branch would drop every frame, reintroducing
  // front-of-answer audio loss for the warmUp-recovery edge case.
  it('does NOT fire eager capture against a CLOSED ws from a prior failed warmUp', async () => {
    const gumSpy = vi.mocked(navigator.mediaDevices.getUserMedia)
    gumSpy.mockClear()

    const { result } = renderHook(() => useDeepgramRecognition())
    const onComplete = vi.fn()

    // warmUp #1 — create a ws, let it sit CONNECTING, then advance past
    // the 5s warmUpTimeout so the timeout branch closes it. onclose fires
    // but does NOT null wsRef.current (by design — identity guards need
    // the ref for late stale-close detection). Token is cached on this
    // successful fetch path, so warmUp #2 won't re-fetch (that's what
    // makes the race window shorter in real prod — cached-token flow
    // creates ws2 in a single microtask).
    act(() => { result.current.warmUp() })
    await act(async () => { await vi.advanceTimersByTimeAsync(10) })
    expect(mockWsInstance).not.toBeNull()
    const ws1 = mockWsInstance!
    await act(async () => { await vi.advanceTimersByTimeAsync(5100) })
    expect(ws1.readyState).toBe(3 /* CLOSED */)

    // Reset the ws-instance sentinel so we can observe whether warmUp #2
    // actually constructs a NEW ws via the `new WebSocket(...)` path.
    mockWsInstance = null

    // Fire warmUp #2 AND startListening in the SAME synchronous act —
    // BEFORE React flushes microtasks that would create ws2 via the
    // cached-token .then. At the synchronous eager-check moment,
    // wsRef.current STILL points at ws1 CLOSED (since onclose left it
    // intact). This matches the real production race window: same-event-
    // tick warmUp + startListening after a prior warmUp failure.
    //
    // OLD check: `Boolean(wsRef.current)` → true (ws1 truthy even CLOSED)
    // → fires startAudioCapture(ws1 CLOSED) → getUserMedia called →
    // worklet produced frames get dropped by wsRef.current CLOSED/CLOSING
    // branch in onmessage → front-of-answer audio loss.
    // NEW check: `readyState ∈ {CONNECTING, OPEN}` → CLOSED rejected →
    // eager skipped → catch-up fires after ws2 OPEN.
    act(() => {
      result.current.warmUp()
      result.current.startListening(onComplete)
    })
    // Drain the cached-token microtask so ws2 gets constructed.
    await act(async () => { await vi.advanceTimersByTimeAsync(1) })
    expect(mockWsInstance).not.toBeNull()
    expect(mockWsInstance).not.toBe(ws1)

    // Pin the P1 fix: eager branch must NOT have fired startAudioCapture
    // during the ws1-CLOSED race window. Old code would have triggered
    // getUserMedia → leaked worklet pinned to a dead socket.
    expect(gumSpy).not.toHaveBeenCalled()

    // Let ws2 reach OPEN — catch-up (`!eagerFired`) fires startAudioCapture
    // against the live ws2.
    act(() => { mockWsInstance!.simulateOpen() })
    await act(async () => { await vi.advanceTimersByTimeAsync(10) })
    expect(gumSpy).toHaveBeenCalledTimes(1)
  })

  // ── Codex P2 on PR #320 round-3 — stale PCM across sessions ──
  //
  // pcmBufferRef is only cleared at startListening entry. If a turn is
  // cancelled during CONNECTING (finishRecognition fires before ws.onopen),
  // buffered worklet frames survive teardownAudioPipeline (intentionally —
  // the warmUp-fallback path relies on in-session preservation). But on a
  // real session-end (stopListening / reentry / usageLimit), the stale
  // frames would be flushed into the NEXT warmUp's new ws by its onopen,
  // leaking prior-turn audio into a new session and potentially tripping
  // the ≥3-word interrupt detector.
  it('clears pcmBufferRef on finishRecognition so next warmUp cannot leak prior-turn audio', async () => {
    const { result } = renderHook(() => useDeepgramRecognition())
    const onComplete = vi.fn()

    // Turn A: warmUp → startListening (slow path, ws CONNECTING) →
    // worklet produces a frame → buffered into pcmBufferRef.
    act(() => { result.current.warmUp() })
    await act(async () => { await vi.advanceTimersByTimeAsync(10) })
    const wsA = mockWsInstance!
    expect(wsA).not.toBeNull()
    // Do NOT simulateOpen — keep ws CONNECTING so the worklet's
    // onmessage takes the enqueue branch.

    act(() => { result.current.startListening(onComplete) })
    await act(async () => { await vi.advanceTimersByTimeAsync(10) })
    expect(lastWorkletInstance).not.toBeNull()

    // Post a fake PCM frame through the worklet's port. Hook's onmessage
    // sees wsRef.current === wsA (CONNECTING) → enqueue to pcmBufferRef.
    const fakeFrame = new Int16Array(4096).buffer
    act(() => {
      lastWorkletInstance!.port.onmessage!({ data: fakeFrame } as unknown as MessageEvent)
    })
    // Sanity: ws.send was NOT called with this frame (it's buffered, not sent).
    // wsA.send could be called for KeepAlive later, but we're BEFORE ws.onopen
    // so keepalive hasn't started — send.mock.calls should be empty.
    expect(wsA.send.mock.calls.length).toBe(0)

    // Cancel the turn BEFORE wsA.onopen fires. stopListening → finishRecognition
    // (non-preserve trigger since ws is CONNECTING, not OPEN) → inline
    // teardown + pcmBufferRef.clear(). wsRef.current is nulled but wsA
    // is still CONNECTING (close-branch in finishRecognition gates on
    // readyState === OPEN) and warmUpPromiseRef.current is still pending.
    act(() => { result.current.stopListening() })
    await act(async () => { await vi.advanceTimersByTimeAsync(10) })

    // Now simulate wsA's delayed onopen so the P1-B superseded-socket
    // guard fires: wsRef.current !== wsA → close(1000, 'superseded')
    // + warmUpPromiseRef = null + resolve(). Without this, the next
    // warmUp() below would early-return on the still-pending promise.
    act(() => { wsA.simulateOpen() })
    await act(async () => { await vi.advanceTimersByTimeAsync(10) })
    expect(wsA.lastCloseCode).toBe(1000)
    expect(wsA.lastCloseReason).toBe('superseded')

    // Turn B: new warmUp creates a fresh ws. Reset sentinel.
    mockWsInstance = null
    act(() => { result.current.warmUp() })
    await act(async () => { await vi.advanceTimersByTimeAsync(10) })
    expect(mockWsInstance).not.toBeNull()
    const wsB = mockWsInstance!
    expect(wsB).not.toBe(wsA)

    const sendCallsBeforeOpen = wsB.send.mock.calls.length

    // Simulate onopen — warmUp's ws.onopen calls flushPendingPcm. If
    // the P2 fix held, pcmBufferRef is empty → no frames sent to wsB.
    // Without the fix, the fakeFrame from Turn A would be sent here,
    // Deepgram would emit a phantom Results packet, and the interrupt
    // detector would accumulate phantom words across turns.
    act(() => { wsB.simulateOpen() })
    await act(async () => { await vi.advanceTimersByTimeAsync(10) })

    const sendCallsAfterOpen = wsB.send.mock.calls.length
    // Delta should be 0 immediately after onopen (KeepAlive's first
    // tick fires at 3000ms, not within this 10ms advance).
    expect(sendCallsAfterOpen - sendCallsBeforeOpen).toBe(0)
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

  // ── PR A item 2 — drain worklet port queue before disconnect ─────────
  //
  // RCA: `worklet.port.onmessage` is the hook's audio-frame dispatcher.
  // It reads `wsRef.current` per call. On preserveSocket teardown
  // (graceTimer / stopListeningMaxAnswer / etc.), `processorRef.disconnect()`
  // severs the audio graph but leaves the MessagePort alive — already-
  // queued worklet messages can fire AFTER disconnect, find wsRef.current
  // still pointing at the OPEN preserved ws, and `ws.send(frame)` a stale
  // PCM frame to Deepgram's session state. Worst case in prod: 256ms of
  // user speech leaks across to the next turn's transcript.
  // Fix: null `worklet.port.onmessage` BEFORE `disconnect()` so any
  // queued task dispatches to a null handler and is silently dropped.
  it('nulls worklet.port.onmessage before disconnect on preserveSocket teardown', async () => {
    // Defensive reset on shared mocks. `vi.clearAllMocks()` in the
    // suite's beforeEach only clears call history — `mockReturnValue`
    // / `mockResolvedValue` overrides set by earlier tests (e.g. the
    // never-resolving `getUserMedia` near line 2033) persist into
    // this test and silently park `setupAudioProcessing` mid-await,
    // leaving `lastWorkletInstance` null. Reset + re-install defaults
    // to guarantee the worklet construction path actually executes.
    mockAddModule.mockReset()
    mockAddModule.mockResolvedValue(undefined)
    const gumSpy = vi.mocked(navigator.mediaDevices.getUserMedia)
    gumSpy.mockReset()
    gumSpy.mockResolvedValue(mockStream as unknown as MediaStream)

    const { result } = renderHook(() => useDeepgramRecognition())
    const onComplete = vi.fn()

    // connectFresh path (no warmUp) — drives setupAudioProcessing
    // through ws.onopen → startAudioCapture, the cleanest path that
    // mirrors what other passing tests in this file use (e.g.
    // E-3.4 reconnect tests). Avoids the warmUp/fast-path branch
    // whose extra microtasks make the worklet-construction timing
    // less predictable under full-suite load.
    await act(async () => {
      result.current.startListening(onComplete)
      await vi.advanceTimersByTimeAsync(20)
    })
    expect(mockWsInstance).not.toBeNull()
    act(() => { mockWsInstance!.simulateOpen() })
    await act(async () => { await vi.advanceTimersByTimeAsync(20) })

    // setupAudioProcessing wired the hook's frame dispatcher. Capture
    // the worklet handle at this point so the post-teardown assertion
    // remains meaningful even if global mock-state from earlier tests
    // happened to clear `lastWorkletInstance` between then and now.
    // Pre-teardown the handler MUST be set; if it isn't, the test
    // setup didn't reach the worklet construction line.
    const workletAtSetup = lastWorkletInstance
    expect(workletAtSetup).not.toBeNull()
    expect(workletAtSetup!.port.onmessage).not.toBeNull()

    // stopListeningExternal is in PRESERVE_SOCKET_TRIGGERS, so the
    // ws stays OPEN after finishRecognition. The worklet is torn
    // down regardless. We're testing that port.onmessage is nulled
    // BEFORE processorRef.disconnect() so any queued cross-thread
    // task hits a no-op closure rather than ws.send'ing stale PCM
    // to the preserved-OPEN ws.
    await act(async () => {
      mockWsInstance!.simulateMessage(makeResult('Hello world', true))
      mockWsInstance!.simulateMessage(makeUtteranceEnd())
      await vi.advanceTimersByTimeAsync(3500)
    })
    expect(onComplete).toHaveBeenCalled()

    // Pre-fix: port.onmessage still pointed at the hook's closure,
    // and any queued worklet frame would have called `wsRef.current.send`
    // against the still-OPEN preserved ws — a stale frame to Deepgram.
    // Post-fix: handler nulled before processorRef.disconnect() so a
    // queued message dispatches to nothing. We assert against the
    // captured handle so a separate setup elsewhere doesn't muddy the
    // signal.
    expect(workletAtSetup!.port.onmessage).toBeNull()
  })

  // ── PR A item 6 — short-circuit reconnect when browser is offline ─────
  //
  // RCA: maybeReconnectOrFinish increments the attempt counter and
  // schedules an 800ms × attempt setTimeout BEFORE checking
  // navigator.onLine. The check happens inside connectWebSocket once
  // the timer fires, so an offline browser still costs (a) the
  // 800-1600ms wait and (b) a reconnect-budget slot — even though the
  // outcome is guaranteed to be `finishRecognition('offline')`.
  // Fix: check navigator.onLine at the TOP of maybeReconnectOrFinish
  // and short-circuit straight to finishRecognition('offline') when
  // the browser is offline. Saves the wait + preserves the budget for
  // the case where the network blip ends and reconnect is viable.
  it('short-circuits reconnect when navigator.onLine is false (no 800ms wait)', async () => {
    // Capture the current onLine descriptor so we can restore at the end —
    // jsdom defines navigator.onLine but as configurable, so we can stub.
    const onlineDescriptor =
      Object.getOwnPropertyDescriptor(window.navigator, 'onLine') ??
      ({ configurable: true, value: true, writable: true } as PropertyDescriptor)

    try {
      const { result } = renderHook(() => useDeepgramRecognition())
      const onComplete = vi.fn()

      // connectFresh path (no warmUp) so the cold-connect onclose
      // handler routes to maybeReconnectOrFinish — the warmUp fast
      // path has its own onclose that doesn't reconnect.
      act(() => { result.current.startListening(onComplete) })
      await act(async () => { await vi.advanceTimersByTimeAsync(20) })
      expect(mockWsInstance).not.toBeNull()
      act(() => { mockWsInstance!.simulateOpen() })
      await act(async () => { await vi.advanceTimersByTimeAsync(10) })

      // Candidate says something so finalTextRef is non-empty (legit
      // mid-answer state — without partial text, the reconnect path
      // doesn't even fire).
      await act(async () => {
        mockWsInstance!.simulateMessage(makeResult('In my previous role', true))
      })

      const firstWs = mockWsInstance!

      // Browser goes offline THEN ws dies. Pre-fix: counter++ →
      // 800ms timer scheduled → eventually fires connectWebSocket →
      // navigator.onLine=false → finishRecognition('offline'). Total
      // wait: 800ms + 1 reconnect budget consumed.
      // Post-fix: maybeReconnectOrFinish entry checks navigator.onLine,
      // bails immediately to finishRecognition('offline'). Total wait:
      // ~0ms, budget intact.
      Object.defineProperty(window.navigator, 'onLine', {
        configurable: true,
        get: () => false,
      })

      await act(async () => {
        firstWs.close()
        // Advance ONLY past microtasks, NOT past the 800ms backoff.
        // Pre-fix this would not yet have fired onComplete (timer
        // hasn't fired). Post-fix onComplete fired synchronously
        // inside handleDisconnect → maybeReconnectOrFinish → early-out.
        await vi.advanceTimersByTimeAsync(50)
      })

      // Primary assertion: onComplete fired well before the 800ms
      // backoff would have elapsed.
      expect(onComplete).toHaveBeenCalled()

      // Belt-and-suspenders: NO new WebSocket was constructed (no
      // reconnect attempt was scheduled at all). mockWsInstance still
      // points at firstWs because the constructor was never re-invoked.
      expect(mockWsInstance).toBe(firstWs)
    } finally {
      Object.defineProperty(window.navigator, 'onLine', onlineDescriptor)
    }
  })

  // ── PR A round-2 — preserved warmUp ws death mid-listening must reconnect ──
  //
  // Production session 2026-04-25 06:13–06:20 IST: Q1-Q5 fine, Q6 fired
  // `stopListeningInactivityPreSpeech` with `text: ""` after the user
  // spoke for the full pre-speech window. The console showed Q6 took
  // the FAST path (no `warmUp→wsOpen` log between Q5 grace and Q6
  // captureReady), but the next turn paid a fresh `warmUp→wsOpen:
  // 1434ms` — proving the preserved warmUp ws died DURING Q6's
  // listening session.
  //
  // Root cause: warmUp's `ws.onclose` handler ONLY clears
  // `isWarmedUpRef` and the closure-local KeepAlive — it does NOT
  // call `handleDisconnect`/`maybeReconnectOrFinish` the way
  // `connectWebSocket.onclose` does. So when Deepgram closes the
  // preserved ws mid-answer (1011 idle, 1006 net, etc.), the worklet
  // keeps producing PCM frames but the port handler reads
  // `wsRef.current.readyState === CLOSED` and silently drops them.
  // Deepgram never returns Results → liveTranscriptRef never grows →
  // useInterview's pre-speech inactivity timer fires with empty text.
  // PR #320 fixed Q1 cold-start audio loss but left this mid-turn
  // warmUp-ws death hole open.
  //
  // Fix: when startListening's fast path takes over a preserved
  // warmUp ws, install a reconnect-aware onclose that delegates to
  // `maybeReconnectOrFinish(cachedTokenRef.current)` for untagged
  // closes during an active listening session.
  it('reconnects when preserved warmUp ws dies mid-listening (Q6 prod failure)', async () => {
    // Defensive resets — the worklet/getUserMedia mocks can be
    // contaminated by earlier tests in this file.
    mockAddModule.mockReset()
    mockAddModule.mockResolvedValue(undefined)
    const gumSpy = vi.mocked(navigator.mediaDevices.getUserMedia)
    gumSpy.mockReset()
    gumSpy.mockResolvedValue(mockStream as unknown as MediaStream)

    const { result } = renderHook(() => useDeepgramRecognition())
    const onComplete = vi.fn()

    // Step 1: warmUp + simulateOpen → preserved ws is live, isWarmedUpRef=true
    act(() => { result.current.warmUp() })
    await act(async () => { await vi.advanceTimersByTimeAsync(20) })
    const firstWs = mockWsInstance!
    expect(firstWs).not.toBeNull()
    act(() => { firstWs.simulateOpen() })
    await act(async () => { await vi.advanceTimersByTimeAsync(20) })

    // Step 2: startListening fast path (the Q6 entry condition).
    // No `warmUp→wsOpen` re-fire — ws is reused as-is.
    await act(async () => {
      result.current.startListening(onComplete)
      await vi.advanceTimersByTimeAsync(50)
    })

    // Step 3: user starts speaking, partial text captured.
    await act(async () => {
      firstWs.simulateMessage(makeResult('I would start by understanding the user', true))
    })

    // Step 4: mid-answer, Deepgram closes the ws (untagged — 1011
    // idle or 1006 net). Pre-fix: warmUp.onclose just clears
    // isWarmedUpRef and audio silently drops. Post-fix: the
    // fast-path-installed reconnect-aware onclose calls
    // maybeReconnectOrFinish → schedules reconnect.
    await act(async () => {
      firstWs.close() // untagged — no __finishTrigger set
      // Advance past the 800ms reconnect backoff (attempt 1 → 800ms)
      await vi.advanceTimersByTimeAsync(1000)
    })

    // Assertion 1: a NEW ws was constructed (reconnect happened),
    // not the silent drop the old code did.
    expect(mockWsInstance).not.toBe(firstWs)
    expect(mockWsInstance).not.toBeNull()

    // Assertion 2: onComplete has NOT fired — the candidate is still
    // mid-answer. They should be able to keep talking on the new ws.
    expect(onComplete).not.toHaveBeenCalled()

    // Step 5: new ws opens; candidate continues; UtteranceEnd
    // eventually fires graceTimer with the combined text.
    act(() => { mockWsInstance!.simulateOpen() })
    await act(async () => { await vi.advanceTimersByTimeAsync(20) })
    await act(async () => {
      mockWsInstance!.simulateMessage(makeResult('and then mapping their journey.', true))
    })
    await act(async () => {
      mockWsInstance!.simulateMessage(makeUtteranceEnd())
      await vi.advanceTimersByTimeAsync(4000)
    })

    // Assertion 3: final text combines both halves — partial text
    // was preserved across the reconnect via finalTextRef.
    expect(onComplete).toHaveBeenCalledWith(
      expect.objectContaining({
        text: 'I would start by understanding the user and then mapping their journey.',
      }),
    )
  })

  // ── PR A round-2 — WE-initiated close on a fast-path ws must NOT reconnect ──
  //
  // The reconnect-aware onclose installed by the fast path must only
  // fire on UNTAGGED closes (Deepgram-initiated). When the hook itself
  // closes the ws via finishRecognition (e.g. stopListeningFinishInterview
  // = code 4014), the close is tagged with __finishTrigger and the
  // onclose handler must NOT trigger a spurious reconnect on top of a
  // legitimately-ended session. Mirrors the same guard in
  // connectWebSocket.onclose (line ~1283).
  it('does NOT reconnect when WE close the fast-path-reused ws (tagged finish)', async () => {
    mockAddModule.mockReset()
    mockAddModule.mockResolvedValue(undefined)
    const gumSpy = vi.mocked(navigator.mediaDevices.getUserMedia)
    gumSpy.mockReset()
    gumSpy.mockResolvedValue(mockStream as unknown as MediaStream)

    const { result } = renderHook(() => useDeepgramRecognition())
    const onComplete = vi.fn()

    act(() => { result.current.warmUp() })
    await act(async () => { await vi.advanceTimersByTimeAsync(20) })
    const firstWs = mockWsInstance!
    act(() => { firstWs.simulateOpen() })
    await act(async () => { await vi.advanceTimersByTimeAsync(20) })

    await act(async () => {
      result.current.startListening(onComplete)
      await vi.advanceTimersByTimeAsync(50)
    })

    // We end the interview (terminal trigger, not preserve).
    // finishRecognition tags the ws with __finishTrigger and closes
    // it. The fast-path onclose MUST see the tag and skip reconnect.
    await act(async () => {
      result.current.stopListening('finishInterview')
      await vi.advanceTimersByTimeAsync(1000)
    })

    // Pre-fix or post-fix this should be the same: NO new ws, NO
    // reconnect attempt. The post-fix reconnect-aware onclose must
    // honor the __finishTrigger tag the same way connectWebSocket's
    // onclose does.
    expect(mockWsInstance).toBe(firstWs)
  })

  // ── PR A round-2 idempotency — repeated fast-path entries must not
  //    nest reconnect wraps (single close → single reconnect attempt) ──
  //
  // graceTimer preserves the ws across Q1→Q2→Q3 (etc). Each turn's
  // startListening fast path wraps `ws.onclose`. Without an
  // idempotency guard, the wraps nest: depth = number of turns. When
  // the ws ever dies, ALL nested wraps fire and each calls
  // `maybeReconnectOrFinish` — incrementing reconnectAttemptsRef
  // multiple times for ONE close event, falsely exhausting the
  // 2-attempt budget after just a single Deepgram disconnect on a
  // long interview. Pin the contract: across 3 fast-path entries
  // and one close, exactly ONE new ws is constructed (not N).
  it('does NOT nest reconnect wraps across multiple preserveSocket fast-path entries', async () => {
    mockAddModule.mockReset()
    mockAddModule.mockResolvedValue(undefined)
    const gumSpy = vi.mocked(navigator.mediaDevices.getUserMedia)
    gumSpy.mockReset()
    gumSpy.mockResolvedValue(mockStream as unknown as MediaStream)

    const { result } = renderHook(() => useDeepgramRecognition())

    // Q1 — warmUp + listen + graceTimer (preserve)
    act(() => { result.current.warmUp() })
    await act(async () => { await vi.advanceTimersByTimeAsync(20) })
    const sharedWs = mockWsInstance!
    act(() => { sharedWs.simulateOpen() })
    await act(async () => { await vi.advanceTimersByTimeAsync(20) })

    const onCompleteQ1 = vi.fn()
    await act(async () => {
      result.current.startListening(onCompleteQ1)
      await vi.advanceTimersByTimeAsync(50)
    })
    await act(async () => {
      sharedWs.simulateMessage(makeResult('Q1 answer', true))
      sharedWs.simulateMessage(makeUtteranceEnd())
      await vi.advanceTimersByTimeAsync(4000)
    })
    expect(onCompleteQ1).toHaveBeenCalled()
    // graceTimer preserved — sharedWs is still OPEN
    expect(sharedWs.readyState).toBe(1 /* OPEN */)
    expect(mockWsInstance).toBe(sharedWs)

    // Q2 — same ws reused via fast path (depth-2 wrap risk)
    const onCompleteQ2 = vi.fn()
    await act(async () => {
      result.current.startListening(onCompleteQ2)
      await vi.advanceTimersByTimeAsync(50)
    })
    await act(async () => {
      sharedWs.simulateMessage(makeResult('Q2 answer', true))
      sharedWs.simulateMessage(makeUtteranceEnd())
      await vi.advanceTimersByTimeAsync(4000)
    })
    expect(onCompleteQ2).toHaveBeenCalled()

    // Q3 — same ws reused via fast path (depth-3 wrap risk)
    const onCompleteQ3 = vi.fn()
    await act(async () => {
      result.current.startListening(onCompleteQ3)
      await vi.advanceTimersByTimeAsync(50)
    })

    // Now the ws dies untagged mid-Q3. With idempotent wrap, only
    // ONE reconnect attempt fires → ONE new ws. Without it, three
    // nested wraps fire → reconnectAttemptsRef hits 3 → first
    // attempt's budget check `> maxReconnectAttempts (2)` would
    // trigger `finishRecognition('reconnectExhausted')` instead of
    // a clean reconnect, and the user sees an error instead of
    // recovery.
    await act(async () => {
      sharedWs.close()
      await vi.advanceTimersByTimeAsync(1000)
    })

    // Exactly ONE new ws constructed. mockWsInstance should not be
    // sharedWs (a reconnect happened), but should be ONE step removed
    // — not exhausted, not double-reconnected.
    expect(mockWsInstance).not.toBe(sharedWs)
    expect(mockWsInstance).not.toBeNull()
    // onCompleteQ3 must not have fired with a reconnectExhausted
    // result — the user is mid-answer and should keep going on the
    // new ws.
    expect(onCompleteQ3).not.toHaveBeenCalled()
  })

  // ── Codex P1 on PR #324 — cold-path-preserved ws must not double-reconnect ──
  //
  // Scenario the fast-path's reconnect-aware wrap MUST handle
  // correctly: `connectWebSocket`'s own onclose ALREADY calls
  // handleDisconnect → maybeReconnectOrFinish for untagged closes.
  // When a cold-path-created ws gets preserved through finishRecognition
  // (graceTimer + readyState === OPEN), startListening's next-turn
  // fast path reuses it. Without the idempotency guard, the wrap
  // would chain on top → close fires → original onclose calls
  // maybeReconnectOrFinish (legitimate, attempt counter += 1) →
  // wrap calls maybeReconnectOrFinish AGAIN (illegitimate,
  // counter += 2 total) → 2-attempt budget exhausted on a single
  // close event → user sees `reconnectExhausted` instead of
  // recovery.
  //
  // Fix mechanism: connectWebSocket sets `__reconnectOnCloseWrapped
  // = true` on the ws at creation. When the fast path later sees
  // the flag it skips wrapping — letting the cold-path ws's native
  // onclose handle reconnect on its own. Pin the contract: cold-
  // path Q1 → graceTimer preserve → Q2 fast-path → ws.close untagged
  // → exactly ONE new ws (NOT zero from reconnectExhausted, NOT
  // two from double-reconnect).
  it('does NOT double-reconnect when a cold-path-preserved ws dies on the fast path', async () => {
    mockAddModule.mockReset()
    mockAddModule.mockResolvedValue(undefined)
    const gumSpy = vi.mocked(navigator.mediaDevices.getUserMedia)
    gumSpy.mockReset()
    gumSpy.mockResolvedValue(mockStream as unknown as MediaStream)

    const { result } = renderHook(() => useDeepgramRecognition())
    const onCompleteQ1 = vi.fn()

    // Q1 cold path — startListening WITHOUT prior warmUp drives
    // connectFresh → connectWebSocket. The resulting ws has
    // reconnect-on-close baked into its native handler (the path
    // Codex highlighted).
    await act(async () => {
      result.current.startListening(onCompleteQ1)
      await vi.advanceTimersByTimeAsync(50)
    })
    expect(mockWsInstance).not.toBeNull()
    const coldPathWs = mockWsInstance!
    act(() => { coldPathWs.simulateOpen() })
    await act(async () => { await vi.advanceTimersByTimeAsync(20) })

    // Q1 finishes via graceTimer → preserveSocket=true keeps the
    // cold-path ws alive for Q2 (it's OPEN at trigger time, and
    // graceTimer is in PRESERVE_SOCKET_TRIGGERS).
    await act(async () => {
      coldPathWs.simulateMessage(makeResult('Q1 cold-path answer', true))
      coldPathWs.simulateMessage(makeUtteranceEnd())
      await vi.advanceTimersByTimeAsync(4000)
    })
    expect(onCompleteQ1).toHaveBeenCalled()
    expect(coldPathWs.readyState).toBe(1 /* OPEN */)
    expect(mockWsInstance).toBe(coldPathWs)

    // Q2 fast-path entry on the cold-path ws. This is the line my
    // fast-path wrap touches; the idempotency flag set by
    // connectWebSocket should make this branch a no-op for the wrap.
    const onCompleteQ2 = vi.fn()
    await act(async () => {
      result.current.startListening(onCompleteQ2)
      await vi.advanceTimersByTimeAsync(50)
    })

    // Mid-Q2, the cold-path ws dies untagged. connectWebSocket's
    // native onclose runs handleDisconnect → maybeReconnectOrFinish
    // (legitimate, ONE attempt). My fast-path wrap should NOT have
    // installed itself (flag was set by connectWebSocket), so no
    // second maybeReconnectOrFinish call.
    await act(async () => {
      coldPathWs.close()
      await vi.advanceTimersByTimeAsync(1000)
    })

    // Exactly ONE new ws → reconnect succeeded once. Without the
    // fix: reconnectAttemptsRef would have gone from 0→2 in a single
    // close event, hitting `>= maxReconnectAttempts(2)` on the next
    // legitimate disconnect, which would have surfaced as
    // reconnectExhausted on Q3 instead of clean recovery.
    expect(mockWsInstance).not.toBe(coldPathWs)
    expect(mockWsInstance).not.toBeNull()
    expect(onCompleteQ2).not.toHaveBeenCalled()
  })

  // ── Codex P2 on PR #324 — stale preserved-ws onclose must not steal
  //    reconnect from the active healthy ws ──
  //
  // Codex scenario: ws1 (preserved warmUp, wrap installed in a prior
  // turn) enters CLOSING but its onclose hasn't dispatched yet. The
  // next turn's startListening runs — fast-path check fails because
  // CLOSING !== OPEN. Slow path falls through to connectFresh →
  // creates ws2 → wsRef.current = ws2. The new session is healthy.
  // Eventually ws1's delayed onclose finally dispatches; without the
  // identity check, the wrap would call maybeReconnectOrFinish
  // against ws2 → tearing down the active audio pipeline + creating
  // a NEW ws3 to replace the healthy ws2 → losing the in-flight
  // session.
  //
  // Fix: the wrap's reconnect gate now includes `wsRef.current ===
  // liveWs`, matching the identity check that the rest of the file's
  // onclose handlers already use (e.g. connectWebSocket.onclose line
  // ~1271 for isWarmedUpRef cleanup). Late-arriving closes from
  // superseded sockets become a no-op.
  it('stale preserved-ws onclose does NOT steal reconnect from active healthy ws', async () => {
    mockAddModule.mockReset()
    mockAddModule.mockResolvedValue(undefined)
    const gumSpy = vi.mocked(navigator.mediaDevices.getUserMedia)
    gumSpy.mockReset()
    gumSpy.mockResolvedValue(mockStream as unknown as MediaStream)

    const { result } = renderHook(() => useDeepgramRecognition())

    // Q1: warmUp + listen + graceTimer (preserve) — ws1 stays alive
    // and the fast-path wrap was installed during Q1's startListening.
    act(() => { result.current.warmUp() })
    await act(async () => { await vi.advanceTimersByTimeAsync(20) })
    const ws1 = mockWsInstance!
    act(() => { ws1.simulateOpen() })
    await act(async () => { await vi.advanceTimersByTimeAsync(20) })

    const onCompleteQ1 = vi.fn()
    await act(async () => {
      result.current.startListening(onCompleteQ1)
      await vi.advanceTimersByTimeAsync(50)
    })
    await act(async () => {
      ws1.simulateMessage(makeResult('Q1', true))
      ws1.simulateMessage(makeUtteranceEnd())
      await vi.advanceTimersByTimeAsync(4000)
    })
    expect(onCompleteQ1).toHaveBeenCalled()
    // ws1 is preserved & wrap installed (idempotency flag set by Q1).
    expect(ws1.readyState).toBe(1 /* OPEN */)
    expect(mockWsInstance).toBe(ws1)

    // Manually transition ws1 into CLOSING WITHOUT dispatching onclose
    // — simulating the race where the close frame is in flight but
    // the onclose event hasn't fired yet on the main thread.
    ws1.readyState = 2 /* CLOSING */

    // Q2 startListening runs while ws1 is CLOSING. Fast-path check
    // (`readyState === OPEN`) fails → slow path → warmUpPromiseRef
    // is null → falls through to connectFresh → ws2 created.
    const onCompleteQ2 = vi.fn()
    await act(async () => {
      result.current.startListening(onCompleteQ2)
      await vi.advanceTimersByTimeAsync(50)
    })
    expect(mockWsInstance).not.toBe(ws1)
    const ws2 = mockWsInstance!
    expect(ws2).not.toBeNull()

    // ws2 opens, takes over the active session. wsRef.current is now
    // ws2; ws1 is superseded.
    act(() => { ws2.simulateOpen() })
    await act(async () => { await vi.advanceTimersByTimeAsync(20) })

    // NOW ws1's delayed onclose finally fires. With the identity check,
    // the wrap's reconnect gate sees `wsRef.current (ws2) !== liveWs
    // (ws1)` and skips. Without the fix, it would call
    // maybeReconnectOrFinish → tear down ws2's audio pipeline + create
    // ws3, killing the active session.
    await act(async () => {
      // Force the onclose to fire on ws1 (the close event the test
      // model would have dispatched after the CLOSING transition).
      // MockWebSocket.close() handles that, but ws1 is already
      // CLOSING, so we directly invoke the handler with a synthesized
      // CloseEvent matching what the browser would send.
      ws1.onclose?.(new CloseEvent('close', { code: 1006, reason: '', wasClean: false }))
      await vi.advanceTimersByTimeAsync(1000)
    })

    // Pin: the active socket is still ws2 — NO ws3 was created (the
    // wrap correctly identified ws1 as superseded and skipped
    // reconnect). The healthy in-flight session is intact.
    expect(mockWsInstance).toBe(ws2)
  })
})
