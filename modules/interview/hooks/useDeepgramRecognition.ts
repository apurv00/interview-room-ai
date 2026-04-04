'use client'

import { useCallback, useRef, useState } from 'react'

interface SpeechRecognitionResult {
  text: string
  durationMinutes: number
  metrics: import('@shared/types').SpeechMetrics
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

  const startListening = useCallback(
    (onComplete: (result: SpeechRecognitionResult) => void) => {
      onCompleteRef.current = onComplete
      finalTextRef.current = ''
      lastTranscriptRef.current = ''
      startTimeRef.current = Date.now()
      setLiveTranscript('')

      // Fetch short-lived Deepgram token then connect
      fetchDeepgramToken()
        .then((token) => connectWebSocket(token))
        .catch((err) => {
          console.error('Deepgram token fetch failed:', err)
          // Call finishRecognition to resolve the listenForAnswer() promise.
          // Without this, the interview hangs in LISTENING forever.
          finishRecognition()
        })
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    []
  )

  async function fetchDeepgramToken(): Promise<string> {
    const res = await fetch('/api/transcribe/token', { method: 'POST' })
    const data = await res.json()
    if (!data.token) throw new Error('No token returned')
    return data.token
  }

  function connectWebSocket(token: string) {
    const ws = new WebSocket(
      `wss://api.deepgram.com/v1/listen?token=${token}&model=nova-2&smart_format=true&filler_words=true&utterance_end_ms=2000&interim_results=true&language=en&encoding=linear16&sample_rate=16000`
    )

    wsRef.current = ws

    ws.onopen = () => {
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

        // UtteranceEnd = 2s silence detected by Deepgram
        if (data.type === 'UtteranceEnd') {
          finishRecognition()
        }
      } catch {
        // Skip malformed messages
      }
    }

    ws.onerror = () => {
      finishRecognition()
    }

    ws.onclose = () => {
      // If still listening when connection closes, finish
      if (onCompleteRef.current) {
        finishRecognition()
      }
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
    setIsListening(false)

    // Cleanup audio processing
    processorRef.current?.disconnect()
    sourceRef.current?.disconnect()
    audioContextRef.current?.close().catch(() => {})
    processorRef.current = null
    sourceRef.current = null
    audioContextRef.current = null

    // Stop the Deepgram-specific audio stream tracks (separate from page video stream)
    if (audioStreamRef.current) {
      audioStreamRef.current.getTracks().forEach(t => t.stop())
      audioStreamRef.current = null
    }

    // Close WebSocket
    if (wsRef.current && wsRef.current.readyState === WebSocket.OPEN) {
      wsRef.current.close()
    }
    wsRef.current = null

    // Build result
    const text = finalTextRef.current.trim()
    const durationMinutes = (Date.now() - startTimeRef.current) / 60000

    // Import analyzeSpeech dynamically to avoid circular deps
    import('@interview/config/speechMetrics').then(({ analyzeSpeech }) => {
      const metrics = analyzeSpeech(text, durationMinutes)
      onCompleteRef.current?.({ text, durationMinutes, metrics })
      onCompleteRef.current = null
    })
  }

  const stopListening = useCallback(() => {
    finishRecognition()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  return { isListening, liveTranscript, startListening, stopListening }
}
