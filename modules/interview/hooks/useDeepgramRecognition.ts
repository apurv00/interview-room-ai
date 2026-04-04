'use client'

import { useCallback, useRef, useState } from 'react'

interface SpeechRecognitionResult {
  text: string
  durationMinutes: number
  metrics: import('@shared/types').SpeechMetrics
}

interface TranscribeTokenResponse {
  token?: string
  expiresIn?: number
}

interface ActiveToken {
  value: string
  expiresAtMs: number
}

export interface UseDeepgramRecognitionReturn {
  isListening: boolean
  liveTranscript: string
  startListening: (onComplete: (result: SpeechRecognitionResult) => void) => void
  stopListening: () => void
}

/**
 * Deepgram Nova-2 streaming speech recognition via WebSocket.
 * Same interface as useSpeechRecognition for drop-in replacement.
 */
export function useDeepgramRecognition(): UseDeepgramRecognitionReturn {
  const [isListening, setIsListening] = useState(false)
  const [liveTranscript, setLiveTranscript] = useState('')

  const wsRef = useRef<WebSocket | null>(null)
  const audioContextRef = useRef<AudioContext | null>(null)
  const processorRef = useRef<ScriptProcessorNode | null>(null)
  const sourceRef = useRef<MediaStreamAudioSourceNode | null>(null)
  const audioStreamRef = useRef<MediaStream | null>(null)
  const finalTextRef = useRef('')
  const onCompleteRef = useRef<((result: SpeechRecognitionResult) => void) | null>(null)
  const startTimeRef = useRef(0)
  const rafRef = useRef<number>(0)
  const lastTranscriptRef = useRef('')
  const reconnectAttemptsRef = useRef(0)
  const reconnectTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const isFinishingRef = useRef(false)
  const fallbackFinishTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const isReconnectScheduledRef = useRef(false)
  const activeTokenRef = useRef<ActiveToken | null>(null)

  const startListening = useCallback(
    (onComplete: (result: SpeechRecognitionResult) => void) => {
      onCompleteRef.current = onComplete
      finalTextRef.current = ''
      lastTranscriptRef.current = ''
      reconnectAttemptsRef.current = 0
      isFinishingRef.current = false
      if (reconnectTimerRef.current) {
        clearTimeout(reconnectTimerRef.current)
        reconnectTimerRef.current = null
      }
      teardownCurrentCapture('finish')
      startTimeRef.current = Date.now()
      setLiveTranscript('')

      // Fetch Deepgram token with retry, then connect WebSocket
      getUsableTokenWithRetry()
        .then((token) => connectWebSocket(token))
        .catch((err) => {
          console.error('Deepgram token fetch failed after retries:', err)
          // Don't call finishRecognition() immediately — that resolves with empty
          // text and causes the interview to skip questions. Instead, set isListening
          // false and let the UtteranceEnd timeout or manual stopListening handle it.
          setIsListening(false)
          // Resolve with empty text after a long delay (30s) so the interview
          // doesn't hang forever, but gives user time to notice the issue
          fallbackFinishTimerRef.current = setTimeout(() => {
            if (onCompleteRef.current) {
              finishRecognition()
            }
          }, 30000)
        })
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    []
  )

  async function getUsableTokenWithRetry(maxAttempts = 3): Promise<string> {
    const existingToken = activeTokenRef.current
    if (existingToken && existingToken.expiresAtMs > Date.now() + 15_000) {
      return existingToken.value
    }

    for (let attempt = 0; attempt < maxAttempts; attempt++) {
      try {
        return await fetchDeepgramToken()
      } catch (err) {
        if (attempt < maxAttempts - 1) {
          const backoff = 500 * (2 ** attempt) + Math.floor(Math.random() * 250)
          console.warn(`Deepgram token fetch attempt ${attempt + 1} failed, retrying in ${backoff}ms...`)
          await new Promise(r => setTimeout(r, backoff))
        } else {
          throw err
        }
      }
    }
    throw new Error('All token fetch attempts failed')
  }

  async function fetchDeepgramToken(): Promise<string> {
    const res = await fetch('/api/transcribe/token', { method: 'POST', cache: 'no-store' })
    if (!res.ok) {
      throw new Error(`Token request failed with ${res.status}`)
    }
    const data = (await res.json()) as TranscribeTokenResponse
    if (!data.token) {
      console.error('[Deepgram] Token endpoint returned no token:', data)
      throw new Error('No token returned')
    }
    const expiresIn = typeof data.expiresIn === 'number' ? data.expiresIn : 120
    activeTokenRef.current = {
      value: data.token,
      expiresAtMs: Date.now() + Math.max(30, expiresIn) * 1000,
    }
    return data.token
  }

  function connectWebSocket(token: string) {
    if (!navigator.onLine) {
      console.warn('[Deepgram] Browser is offline, skipping WebSocket connect')
      finishRecognition()
      return
    }

    const wsUrl = 'wss://api.deepgram.com/v1/listen?model=nova-2&smart_format=true&filler_words=true&utterance_end_ms=3500&interim_results=true&language=en&encoding=linear16&sample_rate=16000'
    // Use auth via websocket subprotocol so transient token is not logged in the URL.
    const ws = new WebSocket(wsUrl, ['token', token])
    let disconnectHandled = false

    wsRef.current = ws

    ws.onopen = () => {
      console.log('[Deepgram] WebSocket connected')
      setIsListening(true)
      startAudioCapture(ws)
    }

    ws.onmessage = (event) => {
      try {
        const data = JSON.parse(event.data)

        if (data.type === 'Results') {
          const transcript = data.channel?.alternatives?.[0]?.transcript || ''
          const isFinal = data.is_final

          if (isFinal && transcript) {
            finalTextRef.current = finalTextRef.current
              ? `${finalTextRef.current} ${transcript}`
              : transcript
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

        // UtteranceEnd = 3.5s silence detected by Deepgram
        // Only finish if we have actual text (ignore false triggers on silence)
        if (data.type === 'UtteranceEnd') {
          if (finalTextRef.current.trim().length > 0) {
            finishRecognition()
          }
        }
      } catch {
        // Skip malformed messages
      }
    }

    ws.onerror = (ev) => {
      console.error('[Deepgram] WebSocket error', ev)
      if (!disconnectHandled) {
        disconnectHandled = true
        maybeReconnectOrFinish(token)
      }
    }

    ws.onclose = (ev) => {
      console.warn('[Deepgram] WebSocket closed', { code: ev.code, reason: ev.reason, hadText: finalTextRef.current.length > 0 })
      // Only resolve if we have captured text OR if the connection was intentionally closed.
      // If connection closed with no text (e.g., token rejected), DON'T immediately finish —
      // let the 30s timeout in startListening handle it instead.
      if (onCompleteRef.current && finalTextRef.current.trim().length > 0) {
        finishRecognition()
      } else if (ev.code !== 1000) {
        if (!disconnectHandled) {
          disconnectHandled = true
          maybeReconnectOrFinish(token, ev.code)
        }
      }
    }
  }

  function maybeReconnectOrFinish(token: string, closeCode?: number) {
    if (isReconnectScheduledRef.current) return
    const maxReconnectAttempts = 2
    if (reconnectAttemptsRef.current >= maxReconnectAttempts) {
      finishRecognition()
      return
    }

    isReconnectScheduledRef.current = true
    reconnectAttemptsRef.current += 1
    const delay = 800 * reconnectAttemptsRef.current
    reconnectTimerRef.current = setTimeout(() => {
      reconnectTimerRef.current = null
      isReconnectScheduledRef.current = false
      if (onCompleteRef.current && !isFinishingRef.current) {
        teardownCurrentCapture('reconnect')
        const authFailure = closeCode === 1008 || closeCode === 1011 || closeCode === 4401 || closeCode === 4403
        const reconnectPromise = authFailure ? getUsableTokenWithRetry() : Promise.resolve(token)
        reconnectPromise
          .then(freshToken => connectWebSocket(freshToken))
          .catch(() => finishRecognition())
      }
    }, delay)
  }

  function teardownCurrentCapture(closeReason: 'reconnect' | 'finish') {
    processorRef.current?.disconnect()
    sourceRef.current?.disconnect()
    audioContextRef.current?.close().catch(() => {})
    processorRef.current = null
    sourceRef.current = null
    audioContextRef.current = null

    if (audioStreamRef.current) {
      audioStreamRef.current.getTracks().forEach(t => t.stop())
      audioStreamRef.current = null
    }

    if (wsRef.current) {
      wsRef.current.onopen = null
      wsRef.current.onmessage = null
      wsRef.current.onerror = null
      wsRef.current.onclose = null
      if (
        wsRef.current.readyState === WebSocket.OPEN ||
        wsRef.current.readyState === WebSocket.CONNECTING
      ) {
        wsRef.current.close(1000, closeReason)
      }
      wsRef.current = null
    }
  }

  function startAudioCapture(ws: WebSocket) {
    // Request audio-only stream. Avoid specifying sampleRate in getUserMedia
    // constraints — it can conflict with existing video+audio streams on some
    // browsers, causing the video track to freeze. The AudioContext handles
    // resampling to 16kHz instead.
    navigator.mediaDevices
      .getUserMedia({ audio: true, video: false })
      .then((stream) => {
        audioStreamRef.current = stream
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
      })
      .catch((err) => {
        console.error('Audio capture failed:', err)
        finishRecognition()
      })
  }

  function finishRecognition() {
    if (isFinishingRef.current) return
    isFinishingRef.current = true
    console.log('[Deepgram] finishRecognition called, text:', finalTextRef.current.slice(0, 100))
    setIsListening(false)

    if (fallbackFinishTimerRef.current) {
      clearTimeout(fallbackFinishTimerRef.current)
      fallbackFinishTimerRef.current = null
    }

    if (reconnectTimerRef.current) {
      clearTimeout(reconnectTimerRef.current)
      reconnectTimerRef.current = null
    }
    isReconnectScheduledRef.current = false

    teardownCurrentCapture('finish')

    // Build result
    const text = finalTextRef.current.trim()
    const durationMinutes = (Date.now() - startTimeRef.current) / 60000

    // Import analyzeSpeech dynamically to avoid circular deps
    import('@interview/config/speechMetrics')
      .then(({ analyzeSpeech }) => {
        const metrics = analyzeSpeech(text, durationMinutes)
        onCompleteRef.current?.({ text, durationMinutes, metrics })
      })
      .catch(() => {
        onCompleteRef.current?.({
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
        })
      })
      .finally(() => {
        onCompleteRef.current = null
        isFinishingRef.current = false
      })
  }

  const stopListening = useCallback(() => {
    finishRecognition()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  return { isListening, liveTranscript, startListening, stopListening }
}
