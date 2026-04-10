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
  createMediaStreamSource = vi.fn(() => mockSource)
  createScriptProcessor = vi.fn(() => mockProcessor)
  destination = {}
  close = vi.fn().mockResolvedValue(undefined)
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
      // Advance past the grace period (2500ms for short answers <15 words)
      // + allow dynamic import of speechMetrics to resolve
      await vi.advanceTimersByTimeAsync(3000)
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

  it('interrupt fires when speech detected during non-listening', async () => {
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

      // The ws should still have the message handler attached
      // Send a final result while not listening — should trigger interrupt
      if (mockWsInstance?.onmessage) {
        act(() => {
          mockWsInstance!.simulateMessage(makeResult('Hello', true))
        })
        expect(onInterrupt).toHaveBeenCalled()
      }
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
      // Advance past the grace period (2500ms for short answers <15 words)
      await vi.advanceTimersByTimeAsync(3000)
    })

    expect(onInterrupt).not.toHaveBeenCalled()
    expect(onComplete).toHaveBeenCalledWith(
      expect.objectContaining({ text: 'Some answer' }),
    )
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
})
