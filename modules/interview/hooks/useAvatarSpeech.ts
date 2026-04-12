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
  /**
   * Speak `text` via Deepgram Aura (streaming or buffered) with browser
   * speechSynthesis fallback. `onAudioStart` fires the moment audio
   * playback actually begins — use it to sync UI (e.g. revealing the
   * question text) with the start of audio so the user sees text and
   * hears voice simultaneously.
   */
  avatarSpeak: (text: string, emotion?: AvatarEmotion, onAudioStart?: () => void) => Promise<void>
  prefetchTTS: (text: string) => void
  /** Cancel any in-progress TTS playback (used for candidate interrupt). */
  cancelTTS: () => void
  /** Soft-cancel: stop fetching new audio but let the current buffer drain.
   *  The AI finishes its current sentence naturally. Used for graceful
   *  interrupt handling where the AI completes its thought before yielding. */
  softCancelTTS: () => void
  /**
   * Play a short thinking acknowledgment ("Got it", "Okay") on a
   * dedicated audio channel that is isolated from the main `avatarSpeak`
   * pipeline: a subsequent `avatarSpeak(...)` will NOT cancel an
   * in-flight ack (the next question's `cancelStream()` only touches
   * the main channel). The ack is still stopped by `cancelTTS()` so
   * End Interview honors the "stop all audio within 100ms" invariant.
   * Uses /api/tts (buffered + R2-cached — THINKING_ACKS are permanently
   * cached so every ack after the first returns instantly).
   */
  playAck: (text: string) => Promise<void>
  /**
   * Abort any in-flight thinking ack (fetch + audio element) without
   * touching the main speech channel. Called by the interview loop
   * after evaluation completes so a late-resolving `/api/tts` fetch
   * cannot start playing AFTER the next question has begun speaking.
   * Safe to call unconditionally — no-op when nothing is pending.
   */
  cancelAck: () => void
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
  // Track the currently-playing audio element + its object URL so cancelTTS()
  // can interrupt buffered/cached playback (not just streaming).
  const currentAudioRef = useRef<HTMLAudioElement | null>(null)
  const currentAudioUrlRef = useRef<string | null>(null)
  // Track in-flight TTS fetches so they can be aborted on cancelTTS().
  const currentFetchAbortRef = useRef<AbortController | null>(null)
  // Thinking-ack audio channel — tracked separately so the next
  // avatarSpeak's cancelStream() does NOT cancel an in-flight ack.
  // Cleared by cancelTTS() so End Interview still stops acks.
  const currentAckAudioRef = useRef<HTMLAudioElement | null>(null)
  const currentAckUrlRef = useRef<string | null>(null)
  const currentAckFetchAbortRef = useRef<AbortController | null>(null)
  // Streaming audio playback (MediaSource API)
  const { streamAndPlay, cancel: cancelStream, softCancel: softCancelStream, isSupported: isStreamingSupported } = useStreamingAudio()

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
  function playBlob(blob: Blob, onAudioStart?: () => void): Promise<void> {
    return new Promise<void>((resolve) => {
      const url = URL.createObjectURL(blob)
      const audio = new Audio(url)
      // Track refs so cancelTTS() can interrupt this playback synchronously
      currentAudioRef.current = audio
      currentAudioUrlRef.current = url
      const cleanup = () => {
        if (currentAudioRef.current === audio) {
          currentAudioRef.current = null
          currentAudioUrlRef.current = null
        }
        URL.revokeObjectURL(url)
        setIsAvatarTalking(false)
      }
      // Route into the voice mixer so the AI's voice is captured by
      // MediaRecorder alongside the candidate's mic. Safe no-op when
      // the mixer isn't initialised.
      tapAudioElement(audio)
      // Fire onAudioStart the moment playback actually begins
      let startedFired = false
      audio.onplaying = () => {
        if (!startedFired) {
          startedFired = true
          try { onAudioStart?.() } catch { /* swallow caller errors */ }
        }
      }
      audio.onended = () => {
        cleanup()
        resolve()
      }
      audio.onerror = () => {
        cleanup()
        resolve()
      }
      audio.play().catch(() => {
        cleanup()
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
    async (text: string, emotion: AvatarEmotion = 'friendly', onAudioStart?: () => void): Promise<void> => {
      setAvatarEmotion(emotion)
      setIsAvatarTalking(true)
      cancelStream() // Cancel any in-progress stream

      // Fresh AbortController for this speak call so cancelTTS() can stop it
      const fetchAbort = new AbortController()
      currentFetchAbortRef.current = fetchAbort

      // Helper so each playback path fires the start callback exactly once
      let startedFired = false
      const fireStart = () => {
        if (startedFired) return
        startedFired = true
        try { onAudioStart?.() } catch { /* swallow */ }
      }

      if (isMultimodalEnabled) {
        try {
          // Priority 1: Use pre-fetched audio if available (instant playback)
          const cached = ttsCacheRef.current.get(text)
          if (cached) {
            const blob = await cached
            ttsCacheRef.current.delete(text)
            if (blob) {
              await playBlob(blob, fireStart)
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
                signal: fetchAbort.signal,
              })
              if (res.ok && res.body) {
                await streamAndPlay(res, () => {
                  // First chunk starts playing — sync UI now
                  fireStart()
                })
                setIsAvatarTalking(false)
                return
              }
            } catch (err) {
              if ((err as Error)?.name === 'AbortError') {
                setIsAvatarTalking(false)
                return
              }
              // Streaming failed — fall through to buffered
            }
          }

          // Priority 3: Buffered fetch (for browsers without MediaSource)
          const res = await fetch('/api/tts', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ text }),
            signal: fetchAbort.signal,
          })
          if (res.ok) {
            const blob = await res.blob()
            // Re-check abort: user may have ended interview while blob downloaded
            if (fetchAbort.signal.aborted) {
              setIsAvatarTalking(false)
              return
            }
            await playBlob(blob, fireStart)
            return
          }
        } catch (err) {
          if ((err as Error)?.name === 'AbortError') {
            setIsAvatarTalking(false)
            return
          }
          // Fall through to browser TTS
        }
      }

      // Priority 4: Browser speechSynthesis fallback — fires immediately
      // since browser TTS has no buffering delay
      fireStart()
      await speakWithBrowser(text)
    },
    [interviewType, isMultimodalEnabled, isStreamingSupported, streamAndPlay, cancelStream] // eslint-disable-line react-hooks/exhaustive-deps
  )

  // Clears the isolated thinking-ack channel: aborts any in-flight
  // /api/tts fetch and tears down the ack audio element. Shared between
  // cancelTTS (End Interview — stops everything) and cancelAck (eval
  // completion — stops only the ack without touching the main channel).
  const clearAckChannel = useCallback(() => {
    currentAckFetchAbortRef.current?.abort()
    currentAckFetchAbortRef.current = null
    if (currentAckAudioRef.current) {
      try {
        currentAckAudioRef.current.pause()
        currentAckAudioRef.current.src = ''
        currentAckAudioRef.current.load()
      } catch { /* ignore */ }
      if (currentAckUrlRef.current) {
        try { URL.revokeObjectURL(currentAckUrlRef.current) } catch { /* ignore */ }
      }
      currentAckAudioRef.current = null
      currentAckUrlRef.current = null
    }
  }, [])

  const cancelAck = clearAckChannel

  const cancelTTS = useCallback(() => {
    // 1. Abort any in-flight TTS fetch
    currentFetchAbortRef.current?.abort()
    currentFetchAbortRef.current = null
    // 2. Stop the streaming MediaSource pipeline
    cancelStream()
    // 3. Stop any currently-playing buffered <audio> element
    if (currentAudioRef.current) {
      try {
        currentAudioRef.current.pause()
        currentAudioRef.current.src = ''
        currentAudioRef.current.load()
      } catch { /* ignore */ }
      if (currentAudioUrlRef.current) {
        try { URL.revokeObjectURL(currentAudioUrlRef.current) } catch { /* ignore */ }
      }
      currentAudioRef.current = null
      currentAudioUrlRef.current = null
    }
    // 4. Stop any in-flight thinking ack (fetch + audio element).
    //    cancelStream() above does NOT touch the ack channel, so we
    //    must clear it explicitly here to honor the "End Interview
    //    stops all audio within 100ms" invariant.
    clearAckChannel()
    // 5. Cancel browser speechSynthesis fallback
    window.speechSynthesis?.cancel()
    setIsAvatarTalking(false)
  }, [cancelStream, clearAckChannel])

  /**
   * Soft-cancel TTS: stop fetching new audio from the server but let the
   * currently-buffered audio finish playing (the AI completes its current
   * sentence). For streaming audio this drains the SourceBuffer; for buffered
   * audio the element continues to its natural end. Unlike cancelTTS(), this
   * does NOT immediately silence the speaker — the promise from avatarSpeak
   * resolves when the buffered audio finishes (~1-2s).
   */
  const softCancelTTS = useCallback(() => {
    // 1. Abort any in-flight TTS fetch (no more chunks from server)
    currentFetchAbortRef.current?.abort()
    currentFetchAbortRef.current = null
    // 2. Soft-stop the streaming pipeline (drain current buffer)
    softCancelStream()
    // 3. For buffered playback (playBlob), let the current sentence finish
    //    (~1.5s) then pause. Without this, the entire cached clip plays to
    //    the end (5-10s), making the AI feel unresponsive to interrupts.
    if (currentAudioRef.current && !currentAudioRef.current.paused) {
      const audio = currentAudioRef.current
      setTimeout(() => {
        if (currentAudioRef.current === audio && !audio.paused) {
          audio.pause()
          // Trigger onended so avatarSpeak's promise resolves
          audio.dispatchEvent(new Event('ended'))
        }
      }, 1500)
    }
    // 4. Cancel browser speechSynthesis — no sentence-level control available
    window.speechSynthesis?.cancel()
  }, [softCancelStream])

  /**
   * Thinking-ack channel: fire-and-forget short phrase ("Got it.", "Okay.")
   * via /api/tts (buffered, R2-cached). Isolated from avatarSpeak so a
   * subsequent main-channel speak does NOT cancel the ack. Cleared by
   * cancelTTS() — see invariant #5 in INTERVIEW_FLOW.md §7.
   */
  const playAck = useCallback(
    (text: string): Promise<void> => {
      if (!isMultimodalEnabled) return Promise.resolve()

      // Abort any previous ack still in flight — only one ack channel.
      currentAckFetchAbortRef.current?.abort()
      const fetchAbort = new AbortController()
      currentAckFetchAbortRef.current = fetchAbort

      return fetch('/api/tts', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text }),
        signal: fetchAbort.signal,
      })
        .then((res) => (res.ok ? res.blob() : null))
        .then((blob) => {
          if (!blob || fetchAbort.signal.aborted) return
          const url = URL.createObjectURL(blob)
          const audio = new Audio(url)
          currentAckAudioRef.current = audio
          currentAckUrlRef.current = url
          // Route into the recording mixer so the AI voice is captured
          // alongside the candidate's mic in the session recording.
          tapAudioElement(audio)
          return new Promise<void>((resolve) => {
            const cleanup = () => {
              if (currentAckAudioRef.current === audio) {
                currentAckAudioRef.current = null
                currentAckUrlRef.current = null
              }
              try { URL.revokeObjectURL(url) } catch { /* ignore */ }
              resolve()
            }
            audio.onended = cleanup
            audio.onerror = cleanup
            audio.play().catch(cleanup)
          })
        })
        .catch(() => undefined)
    },
    [isMultimodalEnabled]
  )

  return {
    avatarEmotion,
    isAvatarTalking,
    setAvatarEmotion,
    avatarSpeak,
    prefetchTTS,
    cancelTTS,
    softCancelTTS,
    playAck,
    cancelAck,
  }
}
