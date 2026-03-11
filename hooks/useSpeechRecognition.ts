'use client'

import { useCallback, useRef, useState } from 'react'
import { analyzeSpeech } from '@/lib/speechMetrics'
import type { SpeechMetrics } from '@/lib/types'

export interface SpeechRecognitionResult {
  text: string
  durationMinutes: number
  metrics: SpeechMetrics | null
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
    if (recognitionRef.current) {
      try {
        recognitionRef.current.stop()
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

      // Clean up any previous instance
      if (recognitionRef.current) {
        try {
          recognitionRef.current.stop()
        } catch {
          /* ignore */
        }
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
        clearTimeout(silenceTimerRef.current)
        setIsListening(false)
        onComplete(buildResult())
      }

      recognition.onerror = (e: SpeechRecognitionErrorEvent) => {
        if (e.error !== 'no-speech' && e.error !== 'aborted') {
          console.error('SR error:', e.error)
        }
        clearTimeout(silenceTimerRef.current)
        setIsListening(false)
        onComplete(buildResult())
      }

      recognition.start()
      setIsListening(true)
    },
    []
  )

  return { isListening, liveTranscript, startListening, stopListening }
}
