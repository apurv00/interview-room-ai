'use client'

import { useCallback, useRef } from 'react'

export interface UseDeepgramTTSReturn {
  speak: (text: string) => Promise<void>
  cancel: () => void
}

/**
 * Deepgram Aura TTS hook — fetches natural AI speech from /api/tts,
 * plays via Audio element. Falls back to browser speechSynthesis on error.
 */
export function useDeepgramTTS(): UseDeepgramTTSReturn {
  const audioRef = useRef<HTMLAudioElement | null>(null)
  const objectUrlRef = useRef<string | null>(null)

  const cleanup = useCallback(() => {
    if (audioRef.current) {
      audioRef.current.pause()
      audioRef.current.removeAttribute('src')
      audioRef.current = null
    }
    if (objectUrlRef.current) {
      URL.revokeObjectURL(objectUrlRef.current)
      objectUrlRef.current = null
    }
  }, [])

  const speak = useCallback(async (text: string): Promise<void> => {
    cleanup()

    try {
      const res = await fetch('/api/tts', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text }),
      })

      if (!res.ok) {
        throw new Error(`TTS API returned ${res.status}`)
      }

      const blob = await res.blob()
      const url = URL.createObjectURL(blob)
      objectUrlRef.current = url

      return new Promise<void>((resolve) => {
        const audio = new Audio(url)
        audioRef.current = audio

        audio.onended = () => {
          cleanup()
          resolve()
        }

        audio.onerror = () => {
          cleanup()
          // Fallback to browser TTS
          fallbackSpeak(text).then(resolve)
        }

        audio.play().catch(() => {
          cleanup()
          fallbackSpeak(text).then(resolve)
        })
      })
    } catch {
      // Fallback to browser TTS on any error
      return fallbackSpeak(text)
    }
  }, [cleanup])

  const cancel = useCallback(() => {
    cleanup()
    window.speechSynthesis?.cancel()
  }, [cleanup])

  return { speak, cancel }
}

/** Browser speechSynthesis fallback */
function fallbackSpeak(text: string): Promise<void> {
  return new Promise((resolve) => {
    if (!window.speechSynthesis) {
      resolve()
      return
    }

    window.speechSynthesis.cancel()
    const utterance = new SpeechSynthesisUtterance(text)
    utterance.rate = 1.08
    utterance.pitch = 1.02
    utterance.onend = () => resolve()
    utterance.onerror = () => resolve()
    window.speechSynthesis.speak(utterance)
  })
}
