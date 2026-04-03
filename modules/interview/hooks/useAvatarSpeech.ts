'use client'

import { useCallback, useState } from 'react'
import type { AvatarEmotion } from '@shared/types'

interface UseAvatarSpeechOptions {
  interviewType?: string
  isMultimodalEnabled: boolean
}

export interface UseAvatarSpeechReturn {
  avatarEmotion: AvatarEmotion
  isAvatarTalking: boolean
  setAvatarEmotion: (emotion: AvatarEmotion) => void
  avatarSpeak: (text: string, emotion?: AvatarEmotion) => Promise<void>
}

/**
 * Manages avatar TTS with Deepgram Aura fallback to browser speechSynthesis.
 */
export function useAvatarSpeech({
  interviewType = 'screening',
  isMultimodalEnabled,
}: UseAvatarSpeechOptions): UseAvatarSpeechReturn {
  const [avatarEmotion, setAvatarEmotion] = useState<AvatarEmotion>('friendly')
  const [isAvatarTalking, setIsAvatarTalking] = useState(false)

  const avatarSpeak = useCallback(
    async (text: string, emotion: AvatarEmotion = 'friendly'): Promise<void> => {
      setAvatarEmotion(emotion)
      setIsAvatarTalking(true)

      // Try Deepgram Aura TTS first (natural AI voice)
      if (isMultimodalEnabled) {
        try {
          const res = await fetch('/api/tts', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ text }),
          })

          if (res.ok) {
            const blob = await res.blob()
            const url = URL.createObjectURL(blob)
            await new Promise<void>((resolve) => {
              const audio = new Audio(url)
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
            return
          }
        } catch {
          // Fall through to browser TTS
        }
      }

      // Fallback: browser speechSynthesis
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
    },
    [interviewType, isMultimodalEnabled]
  )

  return { avatarEmotion, isAvatarTalking, setAvatarEmotion, avatarSpeak }
}
