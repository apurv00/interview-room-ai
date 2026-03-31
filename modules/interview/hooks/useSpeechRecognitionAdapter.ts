'use client'

import { useSpeechRecognition } from './useSpeechRecognition'
import { useDeepgramRecognition } from './useDeepgramRecognition'

/**
 * Adapter that uses Deepgram streaming STT when multimodal is enabled,
 * falling back to Web Speech API otherwise.
 */
export function useSpeechRecognitionAdapter() {
  const isMultimodalEnabled = process.env.NEXT_PUBLIC_FEATURE_MULTIMODAL === 'true'

  const webSpeech = useSpeechRecognition()
  const deepgram = useDeepgramRecognition()

  // When multimodal is enabled, prefer Deepgram
  if (isMultimodalEnabled) {
    return deepgram
  }

  return webSpeech
}
