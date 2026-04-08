'use client'

import { useCallback, useRef, useState } from 'react'
import type { AvatarEmotion } from '@shared/types'
import { useStreamingAudio } from './useStreamingAudio'
import { tapAudioElement } from '@interview/audio/voiceMixer'

interface UseAvatarSpeechOptions {
  interviewType?: string
  isMultimodalEnabled: boolean
}

export interface UseAvatarSpeechReturn {
  avatarEmotion: AvatarEmotion
  isAvatarTalking: boolean
  setAvatarEmotion: (emotion: AvatarEmotion) => void
  avatarSpeak: (text: string, emotion?: AvatarEmotion) => Promise<void>
  prefetchTTS: (text: string) => void
}

/**
 * Manages avatar TTS with streaming Deepgram Aura, buffered fallback,
 * and browser speechSynthesis as final fallback.
 */
export function useAvatarSpeech({
  interviewType = 'screening',
  isMultimodalEnabled,
}: UseAvatarSpeechOptions): UseAvatarSpeechReturn {
  const [avatarEmotion, setAvatarEmotion] = useState<AvatarEmotion>('friendly')
  const [isAvatarTalking, setIsAvatarTalking] = useState(false)
  // Cache for pre-fetched TTS audio blobs keyed by text
  const ttsCacheRef = useRef<Map<string, Promise<Blob | null>>>(new Map())
  // Streaming audio playback (MediaSource API)
  const { streamAndPlay, cancel: cancelStream, isSupported: isStreamingSupported } = useStreamingAudio()

  /** Pre-fetch TTS audio for a question so it's ready when needed (buffered). */
  const prefetchTTS = useCallback(
    (text: string) => {
      if (!isMultimodalEnabled || ttsCacheRef.current.has(text)) return
      // Evict oldest entry if cache exceeds 5 items
      if (ttsCacheRef.current.size >= 5) {
        const firstKey = ttsCacheRef.current.keys().next().value
        if (firstKey) ttsCacheRef.current.delete(firstKey)
      }
      const promise = fetch('/api/tts', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text }),
      })
        .then((res) => (res.ok ? res.blob() : null))
        .catch(() => null)
      ttsCacheRef.current.set(text, promise)
    },
    [isMultimodalEnabled]
  )

  /** Play a blob via Audio element (used for cached/prefetched audio). */
  function playBlob(blob: Blob): Promise<void> {
    return new Promise<void>((resolve) => {
      const url = URL.createObjectURL(blob)
      const audio = new Audio(url)
      // Route into the voice mixer so the AI's voice is captured by
      // MediaRecorder alongside the candidate's mic. Safe no-op when
      // the mixer isn't initialised.
      tapAudioElement(audio)
      audio.onended = () => {
        URL.revokeObjectURL(url)
        setIsAvatarTalking(false)
        resolve()
      }
      audio.onerror = () => {
        URL.revokeObjectURL(url)
        setIsAvatarTalking(false)
        resolve()
      }
      audio.play().catch(() => {
        URL.revokeObjectURL(url)
        setIsAvatarTalking(false)
        resolve()
      })
    })
  }

  /** Fallback: browser speechSynthesis. */
  function speakWithBrowser(text: string): Promise<void> {
    return new Promise((resolve) => {
      window.speechSynthesis.cancel()
      const utterance = new SpeechSynthesisUtterance(text)
      const voices = window.speechSynthesis.getVoices()
      const voicePreferences = [
        'Microsoft Neerja Online (Natural)',
        'Google US English',
        'Microsoft Neerja',
        'Google India English',
        'Samantha',
        'Google UK English Female',
        'Rishi',
        'Veena',
        'Karen',
        'Moira',
      ]
      const preferred = voicePreferences.reduce<SpeechSynthesisVoice | null>(
        (found, name) => found || voices.find((v) => v.name.includes(name)) || null,
        null
      )
      if (preferred) utterance.voice = preferred

      const ttsProfiles: Record<string, { rate: number; pitch: number }> = {
        screening: { rate: 1.08, pitch: 1.02 },
        behavioral: { rate: 1.0, pitch: 1.0 },
        technical: { rate: 1.1, pitch: 0.98 },
        'case-study': { rate: 0.98, pitch: 1.0 },
      }
      const tts = ttsProfiles[interviewType] || ttsProfiles.screening
      utterance.rate = tts.rate
      utterance.pitch = tts.pitch
      utterance.volume = 1

      utterance.onend = () => {
        setIsAvatarTalking(false)
        resolve()
      }
      utterance.onerror = () => {
        setIsAvatarTalking(false)
        resolve()
      }
      window.speechSynthesis.speak(utterance)
    })
  }

  const avatarSpeak = useCallback(
    async (text: string, emotion: AvatarEmotion = 'friendly'): Promise<void> => {
      setAvatarEmotion(emotion)
      setIsAvatarTalking(true)
      cancelStream() // Cancel any in-progress stream

      if (isMultimodalEnabled) {
        try {
          // Priority 1: Use pre-fetched audio if available (instant playback)
          const cached = ttsCacheRef.current.get(text)
          if (cached) {
            const blob = await cached
            ttsCacheRef.current.delete(text)
            if (blob) {
              await playBlob(blob)
              return
            }
          }

          // Priority 2: Streaming playback via MediaSource (low latency)
          if (isStreamingSupported) {
            try {
              const res = await fetch('/api/tts/stream', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ text }),
              })
              if (res.ok && res.body) {
                await streamAndPlay(res, () => {
                  // Called when first chunk starts playing
                })
                setIsAvatarTalking(false)
                return
              }
            } catch {
              // Streaming failed — fall through to buffered
            }
          }

          // Priority 3: Buffered fetch (for browsers without MediaSource)
          const res = await fetch('/api/tts', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ text }),
          })
          if (res.ok) {
            const blob = await res.blob()
            await playBlob(blob)
            return
          }
        } catch {
          // Fall through to browser TTS
        }
      }

      // Priority 4: Browser speechSynthesis fallback
      await speakWithBrowser(text)
    },
    [interviewType, isMultimodalEnabled, isStreamingSupported, streamAndPlay, cancelStream] // eslint-disable-line react-hooks/exhaustive-deps
  )

  return { avatarEmotion, isAvatarTalking, setAvatarEmotion, avatarSpeak, prefetchTTS }
}
