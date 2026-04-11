'use client'

import { useCallback, useRef, useState } from 'react'
import { analyzeSpeech } from '@interview/config/speechMetrics'
import type { SpeechMetrics } from '@shared/types'

/** A single word with audio-timeline-relative timestamps (seconds from the
 *  start of the recording). Shape matches Whisper's WhisperWord so the
 *  multimodal pipeline can consume either source transparently. */
export interface LiveTranscriptWord {
  word: string
  /** Seconds from the start of the *recording* (not the STT session). */
  start: number
  end: number
  confidence: number
}

export interface SpeechRecognitionResult {
  text: string
  durationMinutes: number
  metrics: SpeechMetrics | null
  /** Word-level timestamps captured by streaming STT (Deepgram). Empty
   *  for the Web Speech API fallback, which doesn't expose per-word data. */
  words?: LiveTranscriptWord[]
}

export interface UseSpeechRecognitionReturn {
  isListening: boolean
  liveTranscript: string
  startListening: (onComplete: (result: SpeechRecognitionResult) => void) => void
  stopListening: () => void
}

export function useSpeechRecognition(): UseSpeechRecognitionReturn {
  const [isListening, setIsListening] = useState(false)
  const [liveTranscript, setLiveTranscript] = useState('')

  const recognitionRef = useRef<SpeechRecognition | null>(null)
  const silenceTimerRef = useRef<ReturnType<typeof setTimeout>>()
  const answerStartRef = useRef(0)
  const liveAnswerRef = useRef('')
  const rafPendingRef = useRef(false)

  const stopListening = useCallback(() => {
    const current = recognitionRef.current
    if (current) {
      try {
        current.abort()
      } catch {
        /* ignore */
      }
    }
  }, [])

  const startListening = useCallback(
    (onComplete: (result: SpeechRecognitionResult) => void) => {
      const SR = window.SpeechRecognition || window.webkitSpeechRecognition
      if (!SR) {
        onComplete({ text: '', durationMinutes: 0, metrics: null })
        return
      }

      // Clean up any previous instance — null handlers first so late-firing
      // onend/onerror events from the stale instance are silently dropped.
      const stale = recognitionRef.current
      if (stale) {
        stale.onresult = null
        stale.onend = null
        stale.onerror = null
        try { stale.abort() } catch { /* ignore */ }
      }

      const recognition = new SR()
      recognition.continuous = true
      recognition.interimResults = true
      recognition.lang = 'en-IN'

      let finalText = ''
      answerStartRef.current = Date.now()
      liveAnswerRef.current = ''
      setLiveTranscript('')
      recognitionRef.current = recognition

      const buildResult = (): SpeechRecognitionResult => {
        const text = finalText.trim() || liveAnswerRef.current.trim()
        const durationMinutes = (Date.now() - answerStartRef.current) / 1000 / 60
        const metrics = text ? analyzeSpeech(text, durationMinutes) : null
        return { text, durationMinutes, metrics }
      }

      // Prevent double-invocation: abort() fires onerror('aborted') then onend
      let completed = false
      const complete = (result: SpeechRecognitionResult) => {
        if (completed) return
        completed = true
        setIsListening(false)
        onComplete(result)
      }

      // Capture for stale-instance guard in onend/onerror
      const thisRecognition = recognition

      recognition.onresult = (event: SpeechRecognitionEvent) => {
        clearTimeout(silenceTimerRef.current)

        let interim = ''
        for (let i = event.resultIndex; i < event.results.length; i++) {
          const r = event.results[i]
          if (r.isFinal) {
            finalText += r[0].transcript + ' '
          } else {
            interim += r[0].transcript
          }
        }

        const combined = (finalText + interim).trim()
        liveAnswerRef.current = combined

        // Throttle React state updates to ~60fps via requestAnimationFrame
        if (!rafPendingRef.current) {
          rafPendingRef.current = true
          requestAnimationFrame(() => {
            setLiveTranscript(liveAnswerRef.current)
            rafPendingRef.current = false
          })
        }

        // Silence detection: 2s after last word
        silenceTimerRef.current = setTimeout(() => {
          if (finalText.trim()) {
            recognition.stop()
          }
        }, 2000)
      }

      recognition.onend = () => {
        if (recognitionRef.current !== thisRecognition) return // stale instance — ignore
        clearTimeout(silenceTimerRef.current)
        complete(buildResult())
      }

      recognition.onerror = (e: SpeechRecognitionErrorEvent) => {
        if (recognitionRef.current !== thisRecognition) return // stale instance — ignore
        if (e.error !== 'no-speech' && e.error !== 'aborted') {
          console.error('SR error:', e.error)
        }
        clearTimeout(silenceTimerRef.current)
        complete(buildResult())
      }

      recognition.start()
      setIsListening(true)
    },
    []
  )

  return { isListening, liveTranscript, startListening, stopListening }
}
