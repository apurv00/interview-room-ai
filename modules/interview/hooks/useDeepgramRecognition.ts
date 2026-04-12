'use client'

import { useCallback, useRef, useState } from 'react'
import { wallClockMsToAudioSeconds } from '@interview/audio/recordingClock'
import type {
  SpeechRecognitionResult,
  LiveTranscriptWord,
} from './useSpeechRecognition'

export interface StartListeningOptions {
  /** Called once audio capture is actually running (mic open, ScriptProcessor connected).
   *  Use this to flip UI state — avoids the "Listening…" label appearing before audio flows. */
  onCaptureReady?: () => void
}

export interface UseDeepgramRecognitionReturn {
  isListening: boolean
  liveTranscript: string
  startListening: (onComplete: (result: SpeechRecognitionResult) => void, options?: StartListeningOptions) => void
  stopListening: () => void
  /** Pre-warm: fetch token + connect WebSocket so startListening is instant. */
  warmUp: () => void
  /** Provide an existing audio stream to avoid redundant getUserMedia calls. */
  setExternalStream: (stream: MediaStream) => void
  /** Suppress interrupt detection (e.g. during TTS playback to prevent
   *  speaker-to-mic feedback from triggering false interrupts). */
  setSuppressInterrupt: (suppress: boolean) => void
  /** Set a callback that fires when speech is detected while no active listening session.
   *  Used to detect candidate interrupting TTS playback. */
  setOnInterrupt: (cb: (() => void) | null) => void
}

/**
 * Deepgram Nova-2 streaming speech recognition via WebSocket.
 * Same interface as useSpeechRecognition for drop-in replacement.
 *
 * Supports pre-warming: call warmUp() during avatar speech so the
 * WebSocket is connected before the user starts answering.
 */
export function useDeepgramRecognition(): UseDeepgramRecognitionReturn {
  const [isListening, setIsListening] = useState(false)
  const [liveTranscript, setLiveTranscript] = useState('')

  const wsRef = useRef<WebSocket | null>(null)
  const audioContextRef = useRef<AudioContext | null>(null)
  const processorRef = useRef<ScriptProcessorNode | null>(null)
  const sourceRef = useRef<MediaStreamAudioSourceNode | null>(null)
  const audioStreamRef = useRef<MediaStream | null>(null)
  const externalStreamRef = useRef<MediaStream | null>(null)
  const finalTextRef = useRef('')
  /** Audio-timeline-relative words accumulated across all finalised
   *  results for the current turn. Translated from Deepgram's
   *  session-relative offsets via the recording clock. */
  const wordsRef = useRef<LiveTranscriptWord[]>([])
  const onCompleteRef = useRef<((result: SpeechRecognitionResult) => void) | null>(null)
  const startTimeRef = useRef(0)
  const rafRef = useRef<number>(0)
  const lastTranscriptRef = useRef('')
  const reconnectAttemptsRef = useRef(0)
  const reconnectTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const isFinishingRef = useRef(false)
  const fallbackFinishTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  /** Grace period timer — delays finalization after UtteranceEnd to allow
   *  users with natural thinking pauses to continue speaking. */
  const graceTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  /** Capture-ready callback — fired once after audio processing starts. */
  const onCaptureReadyRef = useRef<(() => void) | null>(null)
  /** Interrupt callback — fired when speech is detected while avatar is speaking. */
  const onInterruptRef = useRef<(() => void) | null>(null)
  /** When true, suppress interrupt detection. Used during TTS playback to prevent
   *  the AI's own speech (picked up by the mic) from triggering false interrupts. */
  const suppressInterruptRef = useRef(false)
  /** Accumulated final-packet transcript for the current interrupt window.
   *  Deepgram can emit a single utterance as multiple `is_final: true`
   *  packets (e.g. "wait can" then "I clarify"). If we checked the
   *  3-word threshold per packet, a genuine 4-word interrupt split
   *  across two 2-word packets would never fire. Instead we accumulate
   *  across packets while the avatar is speaking and reset on (a) the
   *  interrupt actually firing, (b) `startListening` (a fresh session),
   *  or (c) an inactivity timeout (see `interruptAccumTimerRef`).
   *  Reported by Codex review on PR #228. */
  const interruptAccumRef = useRef<string>('')
  /** Inactivity reset timer for `interruptAccumRef`. Prevents stale
   *  fragments from a prior utterance leaking into the next one. */
  const interruptAccumTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  // Token cache — avoids re-fetching for each question
  const cachedTokenRef = useRef<string | null>(null)
  // Whether warmUp() has been called and WebSocket is ready
  const isWarmedUpRef = useRef(false)
  const warmUpPromiseRef = useRef<Promise<void> | null>(null)

  /** Provide an existing media stream (from page-level getUserMedia). */
  const setExternalStream = useCallback((stream: MediaStream) => {
    externalStreamRef.current = stream
  }, [])

  const startListening = useCallback(
    (onComplete: (result: SpeechRecognitionResult) => void, options?: StartListeningOptions) => {
      // Guard: if already listening (e.g. called twice in rapid succession),
      // finish the current session before starting a new one. Without this,
      // both sessions share the same WebSocket and the second call overwrites
      // the first's callbacks, causing spurious interrupts. See Issue #2.
      // finishRecognition snapshots onCompleteRef synchronously, so the old
      // session's async callback won't alias with the new one set below.
      if (onCompleteRef.current && !isFinishingRef.current) {
        finishRecognition()
      }

      onCompleteRef.current = onComplete
      onCaptureReadyRef.current = options?.onCaptureReady ?? null
      finalTextRef.current = ''
      wordsRef.current = []
      lastTranscriptRef.current = ''
      reconnectAttemptsRef.current = 0
      isFinishingRef.current = false
      startTimeRef.current = Date.now()
      setLiveTranscript('')

      // Fresh listening session — drop any stale interrupt-accumulator
      // fragments so a prior almost-interrupt doesn't combine with this
      // session's early words to spuriously cross the ≥3-word threshold.
      interruptAccumRef.current = ''
      if (interruptAccumTimerRef.current) {
        clearTimeout(interruptAccumTimerRef.current)
        interruptAccumTimerRef.current = null
      }

      // Safety timeout: if capture-ready never fires (e.g. getUserMedia rejected),
      // fire the callback anyway after 1500ms so the UI doesn't stall.
      // 1500ms accounts for first-call getUserMedia latency (400-800ms) + AudioContext init.
      const captureReadySafety = options?.onCaptureReady
        ? setTimeout(() => {
            if (onCaptureReadyRef.current) {
              onCaptureReadyRef.current()
              onCaptureReadyRef.current = null
            }
          }, 1500)
        : undefined

      // Wrap the original onCaptureReady to also clear the safety timeout
      const originalOnCaptureReady = onCaptureReadyRef.current
      if (originalOnCaptureReady && captureReadySafety) {
        onCaptureReadyRef.current = () => {
          clearTimeout(captureReadySafety)
          originalOnCaptureReady()
          onCaptureReadyRef.current = null
        }
      }

      // If warmed up and WebSocket is already connected, start capture immediately
      if (isWarmedUpRef.current && wsRef.current?.readyState === WebSocket.OPEN) {
        setIsListening(true)
        // The warmUp WebSocket was created without an onmessage handler —
        // attach it now so Deepgram results are actually received.
        attachMessageHandler(wsRef.current)
        startAudioCapture(wsRef.current)
        isWarmedUpRef.current = false
        return
      }

      // If warmUp is in progress, wait for it then start capture
      if (warmUpPromiseRef.current) {
        warmUpPromiseRef.current
          .then(() => {
            if (wsRef.current?.readyState === WebSocket.OPEN) {
              setIsListening(true)
              attachMessageHandler(wsRef.current)
              startAudioCapture(wsRef.current)
              isWarmedUpRef.current = false
            } else {
              // Warm-up WebSocket failed, fall back to full connection
              connectFresh()
            }
          })
          .catch(() => connectFresh())
        return
      }

      // No warm-up — do full connection (original path)
      connectFresh()

      function connectFresh() {
        fetchTokenCached()
          .then((token) => connectWebSocket(token))
          .catch((err) => {
            console.error('Deepgram token fetch failed after retries:', err)
            setIsListening(false)
            fallbackFinishTimerRef.current = setTimeout(() => {
              if (onCompleteRef.current) {
                finishRecognition()
              }
            }, 30000)
          })
      }
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    []
  )

  /**
   * Pre-warm: fetch token and connect WebSocket ahead of time.
   * Call this during avatar speech so recognition starts instantly.
   */
  const warmUp = useCallback(() => {
    // Skip if already warmed up or connecting
    if (isWarmedUpRef.current || warmUpPromiseRef.current) return
    if (wsRef.current?.readyState === WebSocket.OPEN) return

    const promise = fetchTokenCached()
      .then((token) => {
        return new Promise<void>((resolve) => {
          const wsUrl = 'wss://api.deepgram.com/v1/listen?model=nova-2&smart_format=true&filler_words=true&utterance_end_ms=2500&interim_results=true&language=en&encoding=linear16&sample_rate=16000'
          const ws = new WebSocket(wsUrl, ['token', token])

          ws.onopen = () => {
            wsRef.current = ws
            isWarmedUpRef.current = true
            warmUpPromiseRef.current = null
            resolve()
          }
          ws.onerror = () => {
            warmUpPromiseRef.current = null
            resolve() // Don't reject — startListening will fall back
          }
          ws.onclose = () => {
            if (isWarmedUpRef.current) {
              isWarmedUpRef.current = false
            }
          }

          // Timeout: if WebSocket doesn't connect within 5s, give up
          setTimeout(() => {
            if (ws.readyState !== WebSocket.OPEN) {
              ws.close()
              warmUpPromiseRef.current = null
              resolve()
            }
          }, 5000)
        })
      })
      .catch(() => {
        warmUpPromiseRef.current = null
      })

    warmUpPromiseRef.current = promise
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  /** Fetch token with caching — reuses token across questions. */
  async function fetchTokenCached(): Promise<string> {
    if (cachedTokenRef.current) return cachedTokenRef.current
    const token = await fetchDeepgramTokenWithRetry()
    cachedTokenRef.current = token
    return token
  }

  async function fetchDeepgramTokenWithRetry(retries = 2): Promise<string> {
    for (let attempt = 0; attempt < retries; attempt++) {
      try {
        return await fetchDeepgramToken()
      } catch (err) {
        if (attempt < retries - 1) {
          console.warn(`Deepgram token fetch attempt ${attempt + 1} failed, retrying...`)
          await new Promise(r => setTimeout(r, 1500))
        } else {
          throw err
        }
      }
    }
    throw new Error('All token fetch attempts failed')
  }

  async function fetchDeepgramToken(): Promise<string> {
    const res = await fetch('/api/transcribe/token', { method: 'POST' })
    if (!res.ok) {
      throw new Error(`Token request failed with ${res.status}`)
    }
    const data = await res.json()
    if (!data.token) {
      console.error('[Deepgram] Token endpoint returned no token:', data)
      throw new Error('No token returned')
    }
    return data.token
  }

  /** Attach the Deepgram message handler to a WebSocket.
   *  Called from both connectWebSocket (cold path) and the fast warmUp path.
   *  Without this, the warmed-up WS has no onmessage → transcripts are never received. */
  function attachMessageHandler(ws: WebSocket) {
    ws.onmessage = (event) => {
      try {
        const data = JSON.parse(event.data)

        if (data.type === 'Results') {
          const transcript = data.channel?.alternatives?.[0]?.transcript || ''
          const isFinal = data.is_final

          // Interrupt detection: speech detected while no active listening session.
          // Require ≥3 words to avoid false positives from breaths, mic pops,
          // keyboard clicks, or 1-word mishearings like "uh" / "mm". Real
          // candidate interrupts ("wait, can I clarify", "I'd like to restart")
          // are always multi-word.
          //
          // Deepgram can split one utterance into multiple `is_final` packets
          // (e.g. "wait can" then "I clarify"), so checking per-packet misses
          // genuine multi-word interrupts. Accumulate across packets and check
          // the running total. See INTERVIEW_FLOW.md §8 (Codex P1).
          if (isFinal && transcript && !onCompleteRef.current && onInterruptRef.current && !suppressInterruptRef.current) {
            interruptAccumRef.current = interruptAccumRef.current
              ? `${interruptAccumRef.current} ${transcript}`
              : transcript

            // Reset the accumulator after 2s of silence so fragments from
            // one mic blip don't linger and combine with unrelated later
            // noise to cross the threshold.
            if (interruptAccumTimerRef.current) {
              clearTimeout(interruptAccumTimerRef.current)
            }
            interruptAccumTimerRef.current = setTimeout(() => {
              interruptAccumRef.current = ''
              interruptAccumTimerRef.current = null
            }, 2000)

            const wordCount = interruptAccumRef.current
              .trim()
              .split(/\s+/)
              .filter(Boolean).length
            if (wordCount >= 3) {
              // Clear the accumulator so subsequent packets don't re-fire.
              interruptAccumRef.current = ''
              if (interruptAccumTimerRef.current) {
                clearTimeout(interruptAccumTimerRef.current)
                interruptAccumTimerRef.current = null
              }
              onInterruptRef.current()
              return
            }
          }

          if (isFinal && transcript) {
            // New speech arrived — cancel any pending grace period timer.
            // The user is still talking; don't finalize yet.
            if (graceTimerRef.current) {
              clearTimeout(graceTimerRef.current)
              graceTimerRef.current = null
            }

            finalTextRef.current = finalTextRef.current
              ? `${finalTextRef.current} ${transcript}`
              : transcript

            const rawWords = data.channel?.alternatives?.[0]?.words as
              | Array<{ word: string; start: number; end: number; confidence?: number }>
              | undefined
            if (rawWords?.length) {
              const turnStartAudioSec = wallClockMsToAudioSeconds(startTimeRef.current)
              for (const w of rawWords) {
                wordsRef.current.push({
                  word: w.word,
                  start: turnStartAudioSec + w.start,
                  end: turnStartAudioSec + w.end,
                  confidence: typeof w.confidence === 'number' ? w.confidence : 1,
                })
              }
            }

            // Early question detection: short utterances ending with "?" →
            // respond immediately instead of waiting for UtteranceEnd
            const accumulated = finalTextRef.current.trim()
            const wordCount = accumulated.split(/\s+/).length
            if (accumulated.endsWith('?') && wordCount < 20) {
              finishRecognition()
              return
            }
          }

          // Update live transcript (RAF-throttled)
          const combined = finalTextRef.current + (isFinal ? '' : ` ${transcript}`)
          if (combined !== lastTranscriptRef.current) {
            lastTranscriptRef.current = combined
            cancelAnimationFrame(rafRef.current)
            rafRef.current = requestAnimationFrame(() => {
              setLiveTranscript(combined.trim())
            })
          }
        }

        // ── Adaptive grace period on UtteranceEnd ──
        // Instead of immediately finalizing when Deepgram detects silence,
        // start a grace period. If the user resumes speaking, the timer is
        // cancelled (above). This prevents cutting off users who pause
        // naturally while thinking. Short answers get a longer grace period
        // since the user likely isn't done yet.
        if (data.type === 'UtteranceEnd') {
          if (finalTextRef.current.trim().length > 0) {
            // Clear any existing grace timer (e.g., from a previous UtteranceEnd)
            if (graceTimerRef.current) {
              clearTimeout(graceTimerRef.current)
            }
            const wordCount = finalTextRef.current.trim().split(/\s+/).length
            // Short answers (<15 words) get longer grace — user probably isn't done
            const graceMs = wordCount < 15 ? 2500 : 1500
            graceTimerRef.current = setTimeout(() => {
              graceTimerRef.current = null
              finishRecognition()
            }, graceMs)
          }
        }
      } catch {
        // Ignore JSON parse errors from Deepgram metadata messages
      }
    }
  }

  function connectWebSocket(token: string) {
    if (!navigator.onLine) {
      console.warn('[Deepgram] Browser is offline, skipping WebSocket connect')
      finishRecognition()
      return
    }

    const wsUrl = 'wss://api.deepgram.com/v1/listen?model=nova-2&smart_format=true&filler_words=true&utterance_end_ms=2500&interim_results=true&language=en&encoding=linear16&sample_rate=16000'
    // Use auth via websocket subprotocol so transient token is not logged in the URL.
    const ws = new WebSocket(wsUrl, ['token', token])
    let disconnectHandled = false

    wsRef.current = ws

    const handleDisconnect = () => {
      if (disconnectHandled) return
      disconnectHandled = true
      maybeReconnectOrFinish(token)
    }

    ws.onopen = () => {
      console.log('[Deepgram] WebSocket connected')
      setIsListening(true)
      startAudioCapture(ws)
    }

    attachMessageHandler(ws)

    ws.onerror = (err) => {
      console.error('[Deepgram] WebSocket error:', err)
      handleDisconnect()
    }

    ws.onclose = () => {
      handleDisconnect()
    }
  }

  function maybeReconnectOrFinish(token: string) {
    const maxReconnectAttempts = 2
    reconnectAttemptsRef.current++

    if (reconnectAttemptsRef.current > maxReconnectAttempts) {
      console.warn('[Deepgram] Max reconnect attempts reached, finishing')
      finishRecognition()
      return
    }

    if (finalTextRef.current.trim().length > 0) {
      finishRecognition()
      return
    }

    const delay = 800 * reconnectAttemptsRef.current
    console.log(`[Deepgram] Reconnecting in ${delay}ms (attempt ${reconnectAttemptsRef.current})`)
    reconnectTimerRef.current = setTimeout(() => {
      reconnectTimerRef.current = null
      if (onCompleteRef.current && !isFinishingRef.current) {
        connectWebSocket(token)
      }
    }, delay)
  }

  function startAudioCapture(ws: WebSocket) {
    // Reuse external stream (from page-level getUserMedia) if available
    const existingStream = externalStreamRef.current
    if (existingStream) {
      setupAudioProcessing(existingStream, ws, false)
      return
    }

    // Fallback: request audio-only stream
    navigator.mediaDevices
      .getUserMedia({ audio: true, video: false })
      .then((stream) => {
        setupAudioProcessing(stream, ws, true)
      })
      .catch((err) => {
        console.error('Audio capture failed:', err)
        finishRecognition()
      })
  }

  function setupAudioProcessing(stream: MediaStream, ws: WebSocket, ownStream: boolean) {
    if (ownStream) {
      audioStreamRef.current = stream
    }
    const audioContext = new AudioContext({ sampleRate: 16000 })
    audioContextRef.current = audioContext

    const source = audioContext.createMediaStreamSource(stream)
    sourceRef.current = source

    // Use ScriptProcessorNode (deprecated but widely supported)
    const processor = audioContext.createScriptProcessor(4096, 1, 1)
    processorRef.current = processor

    processor.onaudioprocess = (e) => {
      if (ws.readyState !== WebSocket.OPEN) return
      const inputData = e.inputBuffer.getChannelData(0)
      // Convert Float32 to Int16 PCM
      const pcm = new Int16Array(inputData.length)
      for (let i = 0; i < inputData.length; i++) {
        const s = Math.max(-1, Math.min(1, inputData[i]))
        pcm[i] = s < 0 ? s * 0x8000 : s * 0x7fff
      }
      ws.send(pcm.buffer)
    }

    source.connect(processor)
    processor.connect(audioContext.destination)

    // Audio is now flowing — notify the caller so UI can flip to LISTENING
    if (onCaptureReadyRef.current) {
      onCaptureReadyRef.current()
      onCaptureReadyRef.current = null
    }
  }

  function finishRecognition() {
    if (isFinishingRef.current) return
    isFinishingRef.current = true
    console.log('[Deepgram] finishRecognition called, text:', finalTextRef.current.slice(0, 100))
    setIsListening(false)
    isWarmedUpRef.current = false

    if (fallbackFinishTimerRef.current) {
      clearTimeout(fallbackFinishTimerRef.current)
      fallbackFinishTimerRef.current = null
    }
    if (reconnectTimerRef.current) {
      clearTimeout(reconnectTimerRef.current)
      reconnectTimerRef.current = null
    }
    if (graceTimerRef.current) {
      clearTimeout(graceTimerRef.current)
      graceTimerRef.current = null
    }

    // Cleanup audio processing
    processorRef.current?.disconnect()
    sourceRef.current?.disconnect()
    audioContextRef.current?.close().catch(() => {})
    processorRef.current = null
    sourceRef.current = null
    audioContextRef.current = null

    // Stop the Deepgram-specific audio stream tracks (NOT the external/page stream)
    if (audioStreamRef.current) {
      audioStreamRef.current.getTracks().forEach(t => t.stop())
      audioStreamRef.current = null
    }

    // Close WebSocket
    if (wsRef.current && wsRef.current.readyState === WebSocket.OPEN) {
      wsRef.current.close()
    }
    wsRef.current = null

    // Build result.
    // Fall back to lastTranscriptRef (FINAL + INTERIM combined) when finalTextRef
    // is empty — this captures answers where the user spoke in one continuous run
    // without any sentence-boundary pauses that trigger Deepgram is_final commits.
    const text = finalTextRef.current.trim() || lastTranscriptRef.current.trim()
    const durationMinutes = (Date.now() - startTimeRef.current) / 60000
    // Snapshot the accumulated words before we clear the ref — these
    // flow into the multimodal analysis pipeline so it can skip the
    // post-interview Whisper call entirely.
    const turnWords = wordsRef.current
    wordsRef.current = []

    // Snapshot the callback NOW (synchronously) so the async .then() below
    // fires the correct handler even if startListening is called again before
    // the dynamic import resolves. Without this, a rapid double-call to
    // startListening would overwrite onCompleteRef.current and the old
    // session's result would be delivered to the new session's callback.
    const onComplete = onCompleteRef.current
    onCompleteRef.current = null

    // Import analyzeSpeech dynamically to avoid circular deps
    import('@interview/config/speechMetrics')
      .then(({ analyzeSpeech }) => {
        const metrics = analyzeSpeech(text, durationMinutes)
        onComplete?.({ text, durationMinutes, metrics, words: turnWords })
      })
      .catch(() => {
        onComplete?.({
          text,
          durationMinutes,
          metrics: {
            wpm: 0,
            fillerRate: 0,
            pauseScore: 0,
            ramblingIndex: 0,
            totalWords: 0,
            fillerWordCount: 0,
            durationMinutes,
          },
          words: turnWords,
        })
      })
      .finally(() => {
        isFinishingRef.current = false
      })
  }

  const stopListening = useCallback(() => {
    finishRecognition()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const setOnInterrupt = useCallback((cb: (() => void) | null) => { onInterruptRef.current = cb }, [])
  const setSuppressInterrupt = useCallback((suppress: boolean) => {
    suppressInterruptRef.current = suppress
    // When suppressing, also clear any accumulated fragments so stale
    // TTS-feedback words don't combine with real speech later.
    if (suppress) {
      interruptAccumRef.current = ''
      if (interruptAccumTimerRef.current) {
        clearTimeout(interruptAccumTimerRef.current)
        interruptAccumTimerRef.current = null
      }
    }
  }, [])

  return { isListening, liveTranscript, startListening, stopListening, warmUp, setExternalStream, setOnInterrupt, setSuppressInterrupt }
}
