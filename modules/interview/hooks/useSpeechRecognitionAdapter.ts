'use client'

import { useSpeechRecognition } from './useSpeechRecognition'
import { useDeepgramRecognition, type StopListeningReason } from './useDeepgramRecognition'

// NEXT_PUBLIC_ env vars are inlined at build time, so this is a static constant.
// Conditional hook calls are safe when the condition never changes between renders.
const USE_DEEPGRAM = process.env.NEXT_PUBLIC_FEATURE_MULTIMODAL === 'true'

/**
 * Adapter that uses Deepgram streaming STT when multimodal is enabled,
 * falling back to Web Speech API otherwise.
 *
 * The Web Speech API fallback's `stopListening` is wrapped so it ignores
 * the optional `reason` argument — that parameter is Deepgram-specific
 * (drives labelled WS close codes for diagnostic logging). Keeping the
 * signature compatible here lets useInterview call
 * `stopListening('inactivityPreSpeech')` uniformly without branching.
 */
export function useSpeechRecognitionAdapter() {
  if (USE_DEEPGRAM) {
    // eslint-disable-next-line react-hooks/rules-of-hooks
    return useDeepgramRecognition()
  }
  // eslint-disable-next-line react-hooks/rules-of-hooks
  const base = useSpeechRecognition()
  return {
    ...base,
    stopListening: (_reason?: StopListeningReason) => base.stopListening(),
    warmUp: () => {},
    setExternalStream: (_s: MediaStream) => {},
    setOnInterrupt: (_cb: (() => void) | null) => {},
    setSuppressInterrupt: (_s: boolean) => {},
    getAndClearInterruptAccum: () => '',
  }
}
