'use client'

import { useSpeechRecognition } from './useSpeechRecognition'
import { useDeepgramRecognition } from './useDeepgramRecognition'

// NEXT_PUBLIC_ env vars are inlined at build time, so this is a static constant.
// Conditional hook calls are safe when the condition never changes between renders.
const USE_DEEPGRAM = process.env.NEXT_PUBLIC_FEATURE_MULTIMODAL === 'true'

/**
 * Adapter that uses Deepgram streaming STT when multimodal is enabled,
 * falling back to Web Speech API otherwise.
 */
export function useSpeechRecognitionAdapter() {
  if (USE_DEEPGRAM) {
    // eslint-disable-next-line react-hooks/rules-of-hooks
    return useDeepgramRecognition()
  }
  // eslint-disable-next-line react-hooks/rules-of-hooks
  const base = useSpeechRecognition()
  // Provide no-op stubs for warmUp/setExternalStream when using Web Speech API
  return { ...base, warmUp: () => {}, setExternalStream: (_s: MediaStream) => {}, setOnInterrupt: (_cb: (() => void) | null) => {}, setSuppressInterrupt: (_s: boolean) => {}, getAndClearInterruptAccum: () => '' }
}
