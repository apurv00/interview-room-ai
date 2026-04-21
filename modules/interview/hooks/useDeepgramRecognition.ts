'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import { track } from '@shared/analytics/track'
import { wallClockMsToAudioSeconds } from '@interview/audio/recordingClock'
import type {
  SpeechRecognitionResult,
  LiveTranscriptWord,
} from './useSpeechRecognition'

export interface StartListeningOptions {
  /** Called once audio capture is actually running (mic open, ScriptProcessor connected).
   *  Use this to flip UI state — avoids the "Listening…" label appearing before audio flows. */
  onCaptureReady?: () => void
}

/** Diagnostic packet summary captured into the hook's ring buffer.
 *  Exposed via `window.__deepgramDebug` for root-cause investigation
 *  of overlapping `is_final` transcripts. */
export interface DeepgramPacketLog {
  /** Wall-clock ms when the packet was received. */
  t: number
  /** Deepgram message type: 'Results', 'UtteranceEnd', 'Metadata', etc. */
  type: string
  /** Present for Results packets — true for finalized segments. */
  isFinal?: boolean
  /** Present for Results packets — true for end-of-utterance boundary. */
  speechFinal?: boolean
  /** Deepgram's session-relative audio time (seconds) where this
   *  segment begins. Overlapping segments share `start` ranges. */
  start?: number
  /** Duration (seconds) of the transcribed audio segment. */
  duration?: number
  /** Primary transcript text; empty for non-Results packets. */
  transcript?: string
  /** Word-level timings from Deepgram. Truncated to first 8 entries
   *  to keep the ring buffer bounded in size. */
  words?: Array<{ word: string; start: number; end: number }>
  /** Snapshot of `audioFrameCountRef` at the moment this packet was
   *  received. Lets us correlate transcript segments to the count of
   *  PCM frames we sent — a double-send would show an unexpected 2×
   *  delta between consecutive packets. */
  framesSentAtRx: number
}

/** Named reasons we might terminate a Deepgram WebSocket session. Each
 *  maps to a distinct 4xxx close code so the debug-log endpoint can show
 *  us in Vercel logs exactly which trigger fired — essential for
 *  diagnosing mid-speech cutoffs where `ws.close()` with no args
 *  produces the ambiguous code 1005. Codes are in the application-
 *  defined 4000–4999 range (RFC 6455 §7.4.2).
 *
 *  `stopListeningExternal*` variants identify which useInterview call
 *  site tripped the stopListening() public API — needed because PR #293
 *  logs showed ~74% of closes collapsing into one label, making it
 *  impossible to distinguish the legitimate inactivity timer from the
 *  intentional-silence probe from the user-initiated end.
 *
 *  Code 4002 is intentionally skipped: it was the retired `earlyQuestion`
 *  trigger removed because it cut users mid-rhetorical-flow (e.g.
 *  "say option a, the faster one?" in the middle of an example). */
type FinishTrigger =
  | 'startListenReentry'
  | 'tokenFetchFailed'
  | 'graceTimer'
  | 'offline'
  | 'reconnectExhausted'
  | 'getUserMediaFailed'
  | 'warmUpTimeout'
  // stopListening() public-API sub-triggers — set via stopListening(reason)
  | 'stopListeningInactivityPreSpeech'
  | 'stopListeningInactivityPostSpeech'
  | 'stopListeningMaxAnswer'
  | 'stopListeningIntentionalSilence'
  | 'stopListeningFinishInterview'
  | 'stopListeningUsageLimit'
  | 'stopListeningExternal' // fallback when caller didn't specify

const FINISH_TRIGGER_CODES: Record<FinishTrigger, number> = {
  startListenReentry: 4000,
  graceTimer: 4001,
  // 4002 reserved (retired earlyQuestion trigger)
  stopListeningExternal: 4003,
  warmUpTimeout: 4004,
  reconnectExhausted: 4005,
  tokenFetchFailed: 4006,
  offline: 4007,
  getUserMediaFailed: 4008,
  // stopListening sub-triggers
  stopListeningInactivityPreSpeech: 4010,
  stopListeningInactivityPostSpeech: 4011,
  stopListeningMaxAnswer: 4012,
  stopListeningIntentionalSilence: 4013,
  stopListeningFinishInterview: 4014,
  stopListeningUsageLimit: 4015,
}

/** Caller-supplied reason for ending a listening session. Each value
 *  maps internally to a distinct 4xxx close code (via FINISH_TRIGGER_CODES)
 *  so Vercel logs can tell which useInterview call site ended the turn.
 *  Omit the argument and the default `'external'` (4003) fires — still
 *  meaningful, just less specific. */
export type StopListeningReason =
  | 'inactivityPreSpeech'
  | 'inactivityPostSpeech'
  | 'maxAnswer'
  | 'intentionalSilence'
  | 'finishInterview'
  | 'usageLimit'

export interface UseDeepgramRecognitionReturn {
  isListening: boolean
  liveTranscript: string
  startListening: (onComplete: (result: SpeechRecognitionResult) => void, options?: StartListeningOptions) => void
  stopListening: (reason?: StopListeningReason) => void
  /** Pre-warm: fetch token + connect WebSocket so startListening is instant. */
  warmUp: () => void
  /** Provide an existing audio stream to avoid redundant getUserMedia calls. */
  setExternalStream: (stream: MediaStream) => void
  /** Suppress interrupt detection (e.g. during TTS playback to prevent
   *  speaker-to-mic feedback from triggering false interrupts). */
  setSuppressInterrupt: (suppress: boolean) => void
  /** Set a callback that fires when speech is detected while no active listening session.
   *  Used to detect candidate interrupting TTS playback. */
  setOnInterrupt: (cb: (() => void) | null) => void
  /** Return and clear the accumulated interrupt speech so it can be prepended to the
   *  next listenForAnswer result. */
  getAndClearInterruptAccum: () => string
}

/** A WebSocket instance tagged with the trigger name that initiated
 *  its (upcoming) close. We attach the trigger directly to the socket
 *  rather than storing it on a hook-level ref so reconnect flows can
 *  safely have multiple sockets in various states of teardown without
 *  their onclose handlers reading each other's state. Each onclose
 *  reads the tag from ITS OWN `ws` closure variable — the instances
 *  never share the tag. Codex P2 on PR #293. */
type TaggedWebSocket = WebSocket & { __finishTrigger?: FinishTrigger | null }

/** Classification of the candidate's utterance as of the most recent
 *  UtteranceEnd. Drives how long we wait before finalizing the answer.
 *  See `classifyUtteranceIntent` for the rules. */
export type UtteranceIntent = 'complete' | 'incomplete' | 'thinkingRequest'

/** Grace windows per intent — the budget we give the candidate to
 *  resume speaking after Deepgram detects silence. Any interim or
 *  `is_final` result cancels the pending grace (see lines ~687-699),
 *  so "resume" can be as short as one more word. These are only the
 *  MAX wait in the worst case where silence truly continues.
 *
 *  Tuning note: current grace is 2500/3000ms (wordCount-based). This
 *  replaces that with an intent-based tier. `complete` stays near the
 *  old floor so clean answers don't introduce extra dead air after
 *  natural end-of-sentence. `thinkingRequest` honors explicit signals
 *  like "let me think" / "give me a moment" without TTS confirmation
 *  (which would open its own WS drop + reconnect race — Codex-style
 *  analysis on this branch before implementing). */
const GRACE_MS_BY_INTENT: Record<UtteranceIntent, number> = {
  complete: 3000,
  incomplete: 4500,
  thinkingRequest: 30000,
}

/** Regex patterns that signal the candidate is explicitly asking for
 *  more thinking time. Anchored to end-of-utterance so phrases buried
 *  mid-sentence ("I'd need to think about trade-offs, then I'd...")
 *  don't false-fire. Trailing punctuation/whitespace tolerated.
 *
 *  False-positive protection: if the candidate says a thinking phrase
 *  but then immediately continues speaking, the grace timer gets
 *  cancelled by the next interim/is_final (existing behavior). So
 *  worst-case cost of a wrong match is 27s of extra dead air when
 *  they genuinely stopped — not a cutoff. */
const THINKING_PHRASE_PATTERNS: readonly RegExp[] = [
  /\blet me think(?:\s+(?:about|on|through)\s+\w+)?[.!?…]*\s*$/i,
  /\bgive me (?:a|one) (?:moment|second|minute|sec|bit)[.!?…]*\s*$/i,
  /\bone (?:sec|second|moment|minute)[.!?…]*\s*$/i,
  /\bhmm[,]?\s+(?:let me|i)\b[\s\S]{0,20}$/i,
  /\bi need\b[\s\S]{0,20}\b(?:time|moment|minute|think|sec)[.!?…]*\s*$/i,
  /\blet me (?:collect|gather) my thoughts[.!?…]*\s*$/i,
  /\bhold on[.!?…]*\s*$/i,
  /\bbear with me[.!?…]*\s*$/i,
  /\b(?:wait|lemme)[,]?\s+(?:let me|i)\b[\s\S]{0,20}$/i,
  /\bek (?:second|minute|sec)[.!?…]*\s*$/i,
  /\bruk(?:o)?[.!?…]*\s*$/i,
  /\bsochne do[.!?…]*\s*$/i,
  /\bsoch(?:ne)? lo[.!?…]*\s*$/i,
  /\bsoch raha hu(?:n)?[.!?…]*\s*$/i,
]

/** Conjunctions/prepositions at end-of-text suggesting the candidate
 *  trailed off mid-thought (not yet done). */
const INCOMPLETE_ENDING_PATTERNS: readonly RegExp[] = [
  /\b(?:and|or|but|so|because|since|while|when|if|then|also|plus|however|therefore|moreover|furthermore)\s*$/i,
  /\b(?:to|for|in|at|on|of|with|by|as|about|from|into|over|under|around)\s*$/i,
  /,\s*$/,
  /\.\.\.\s*$/,
  /…\s*$/,
]

/** Classify the candidate's utterance intent as of this UtteranceEnd.
 *
 *  @param text The full accumulated `finalTextRef.current` for the turn.
 *  @returns 'thinkingRequest' if an explicit request-for-time phrase
 *           ends the text; 'incomplete' if the text trails off with a
 *           conjunction/preposition or ellipsis; 'complete' otherwise.
 *
 *  Only the END of the text is inspected — phrase matches buried
 *  mid-sentence don't fire. This mirrors the real-world distinction
 *  between "let me think for a moment" (said then stopped) vs "I'd
 *  need to think about the trade-offs carefully, then I'd..." (said
 *  as part of continuing answer). Continuous speech doesn't trigger
 *  UtteranceEnd mid-sentence, so classifications only run on the true
 *  tail of a natural-silence boundary.
 *
 *  Exported for unit testing. No side effects — pure function.  */
export function classifyUtteranceIntent(text: string): UtteranceIntent {
  const trimmed = text.trim()
  if (!trimmed) return 'complete'

  for (const pattern of THINKING_PHRASE_PATTERNS) {
    if (pattern.test(trimmed)) return 'thinkingRequest'
  }

  for (const pattern of INCOMPLETE_ENDING_PATTERNS) {
    if (pattern.test(trimmed)) return 'incomplete'
  }

  return 'complete'
}

/**
 * Deepgram Nova-2 streaming speech recognition via WebSocket.
 * Same interface as useSpeechRecognition for drop-in replacement.
 *
 * Supports pre-warming: call warmUp() during avatar speech so the
 * WebSocket is connected before the user starts answering.
 */
export function useDeepgramRecognition(): UseDeepgramRecognitionReturn {
  const [isListening, setIsListening] = useState(false)
  const [liveTranscript, setLiveTranscript] = useState('')

  const wsRef = useRef<WebSocket | null>(null)
  const audioContextRef = useRef<AudioContext | null>(null)
  const processorRef = useRef<AudioWorkletNode | null>(null)
  const sourceRef = useRef<MediaStreamAudioSourceNode | null>(null)
  const audioStreamRef = useRef<MediaStream | null>(null)
  const externalStreamRef = useRef<MediaStream | null>(null)
  const finalTextRef = useRef('')
  /** Audio-timeline-relative words accumulated across all finalised
   *  results for the current turn. Translated from Deepgram's
   *  session-relative offsets via the recording clock. */
  const wordsRef = useRef<LiveTranscriptWord[]>([])
  const onCompleteRef = useRef<((result: SpeechRecognitionResult) => void) | null>(null)
  const startTimeRef = useRef(0)
  const rafRef = useRef<number>(0)
  const lastTranscriptRef = useRef('')
  const reconnectAttemptsRef = useRef(0)
  const reconnectTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const isFinishingRef = useRef(false)
  const fallbackFinishTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  /** Grace period timer — delays finalization after UtteranceEnd to allow
   *  users with natural thinking pauses to continue speaking. */
  const graceTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  /** Capture-ready callback — fired once after audio processing starts. */
  const onCaptureReadyRef = useRef<(() => void) | null>(null)
  /** Interrupt callback — fired when speech is detected while avatar is speaking. */
  const onInterruptRef = useRef<(() => void) | null>(null)
  /** When true, suppress interrupt detection. Used during TTS playback to prevent
   *  the AI's own speech (picked up by the mic) from triggering false interrupts. */
  const suppressInterruptRef = useRef(false)
  /** Accumulated final-packet transcript for the current interrupt window.
   *  Deepgram can emit a single utterance as multiple `is_final: true`
   *  packets (e.g. "wait can" then "I clarify"). If we checked the
   *  3-word threshold per packet, a genuine 4-word interrupt split
   *  across two 2-word packets would never fire. Instead we accumulate
   *  across packets while the avatar is speaking and reset on (a) the
   *  interrupt actually firing, (b) `startListening` (a fresh session),
   *  or (c) an inactivity timeout (see `interruptAccumTimerRef`).
   *  Reported by Codex review on PR #228. */
  const interruptAccumRef = useRef<string>('')
  /** Inactivity reset timer for `interruptAccumRef`. Prevents stale
   *  fragments from a prior utterance leaking into the next one. */
  const interruptAccumTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  // Token cache — avoids re-fetching for each question
  const cachedTokenRef = useRef<string | null>(null)
  // Whether warmUp() has been called and WebSocket is ready
  const isWarmedUpRef = useRef(false)
  const warmUpPromiseRef = useRef<Promise<void> | null>(null)
  /** KeepAlive interval for the warm WS. Deepgram closes idle /v1/listen
   *  sockets after ~10s of no traffic. During a long intro TTS (12s+)
   *  the warm socket would die server-side while the client still saw
   *  readyState=OPEN, producing phase=LISTENING with zero transcripts.
   *  We send {"type":"KeepAlive"} every 5s from onopen until audio
   *  actually starts flowing (which keeps the socket alive on its own). */
  const keepAliveTimerRef = useRef<ReturnType<typeof setInterval> | null>(null)
  /** True when document.visibilityState === 'hidden'. Browsers throttle
   *  setTimeout/setInterval and may suspend AudioContext when the tab is
   *  backgrounded — Deepgram receives silence, fires UtteranceEnd, and the
   *  grace timer terminates the answer before the user returns. We pause
   *  the grace timer while hidden and resume normal flow on visibility. */
  const isPageHiddenRef = useRef(false)
  /** Diagnostic ring buffer for Deepgram message shapes. Populated by
   *  `attachMessageHandler` on every Results/UtteranceEnd/Metadata
   *  packet so operators can inspect the raw stream from DevTools
   *  (via `window.__deepgramDebug`) after a real interview turn.
   *
   *  Purpose: root-cause investigation of the overlapping `is_final`
   *  transcripts observed in production session
   *  `69e36b369c13dfe7e7ea90a3`. We need `start`/`duration`/
   *  `speech_final` to distinguish (a) Deepgram re-emitting the same
   *  audio window (timings overlap) from (b) natural boundary-word
   *  reuse (timings disjoint). See AI_ANALYSIS.md §8. */
  const packetLogRef = useRef<Array<DeepgramPacketLog>>([])
  /** Counter of PCM frames sent to Deepgram via `processor.onaudioprocess`.
   *  Snapshotted on each inbound packet into `packetLogRef` to detect a
   *  potential double-send (frame count jumping by 2× expected between
   *  two consecutive packets would indicate duplicated audio). */
  const audioFrameCountRef = useRef(0)

  // Hook-level visibility listener. Mounted once per hook instance, replaces
  // the per-session listener that used to live inside setupAudioProcessing
  // (which couldn't prevent the grace timer from firing while hidden — only
  // resume the audio context after the fact, by which point finishRecognition
  // had already run). E-3.7 fix.
  // Diagnostic window exposure: lets operators grab the packet log +
  // audio-frame counter from DevTools after one real interview turn.
  // Purely read-side, no effect on hook behavior.
  //
  // SECURITY: `packetLogRef` contains full transcript snippets (candidate
  // interview answers) plus word timings. Attaching this to `window`
  // unconditionally would let any script on the page — analytics tags,
  // third-party dependencies, or a compromised package — exfiltrate
  // interview content. Codex P1 on PR #286. Gate by BOTH:
  //   1. Build-time env flag `NEXT_PUBLIC_DEBUG_DEEPGRAM_PACKETS=true`
  //      — deploys with the surface default-off unless explicitly opted in
  //   2. Run-time URL query `?debugDeepgram=1` — per-session operator
  //      opt-in, so even a debug-enabled build requires an explicit URL
  //      to expose the surface
  // Both must match for the surface to attach. Tests and SSR skip entirely.
  useEffect(() => {
    if (typeof window === 'undefined') return
    if (process.env.NODE_ENV === 'test') return
    const envEnabled = process.env.NEXT_PUBLIC_DEBUG_DEEPGRAM_PACKETS === 'true'
    const urlEnabled = typeof window.location !== 'undefined'
      && new URLSearchParams(window.location.search).get('debugDeepgram') === '1'
    if (!envEnabled || !urlEnabled) return
    const debugApi = {
      packets: () => packetLogRef.current.slice(),
      frames: () => audioFrameCountRef.current,
      clear: () => {
        packetLogRef.current = []
        audioFrameCountRef.current = 0
      },
      dump: () => JSON.stringify({
        packets: packetLogRef.current,
        frames: audioFrameCountRef.current,
      }, null, 2),
    }
    ;(window as unknown as { __deepgramDebug?: typeof debugApi }).__deepgramDebug = debugApi
    return () => {
      delete (window as unknown as { __deepgramDebug?: typeof debugApi }).__deepgramDebug
    }
  }, [])

  useEffect(() => {
    if (typeof document === 'undefined') return
    const handleVisibility = () => {
      const hidden = document.hidden
      isPageHiddenRef.current = hidden
      if (!hidden) {
        // Tab visible again — resume audio context if browser suspended it
        if (audioContextRef.current?.state === 'suspended') {
          audioContextRef.current.resume().catch(() => {})
        }
        // Cancel any grace timer that may have been scheduled while hidden
        // (browser throttling can defer its actual fire until tab returns).
        // Letting it fire would terminate the answer the moment the user
        // comes back, before they have a chance to continue speaking.
        if (graceTimerRef.current) {
          clearTimeout(graceTimerRef.current)
          graceTimerRef.current = null
        }
      }
    }
    document.addEventListener('visibilitychange', handleVisibility)
    return () => document.removeEventListener('visibilitychange', handleVisibility)
  }, [])

  /** Provide an existing media stream (from page-level getUserMedia). */
  const setExternalStream = useCallback((stream: MediaStream) => {
    externalStreamRef.current = stream
  }, [])

  const startListening = useCallback(
    (onComplete: (result: SpeechRecognitionResult) => void, options?: StartListeningOptions) => {
      // [DIAGNOSTIC] Temporary Q1-latency perf marker — paired with the
      // console.timeEnd at the bottom of setupAudioProcessing when the
      // audio pipeline signals it's ready. Measures the full user-
      // perceived "startListening → actually capturing audio" delay.
      // eslint-disable-next-line no-console
      console.time('[perf:stt] startListening→captureReady')
      // Guard: if already listening (e.g. called twice in rapid succession),
      // finish the current session before starting a new one. Without this,
      // both sessions share the same WebSocket and the second call overwrites
      // the first's callbacks, causing spurious interrupts. See Issue #2.
      // finishRecognition snapshots onCompleteRef synchronously, so the old
      // session's async callback won't alias with the new one set below.
      if (onCompleteRef.current && !isFinishingRef.current) {
        finishRecognition('startListenReentry')
      }

      onCompleteRef.current = onComplete
      onCaptureReadyRef.current = options?.onCaptureReady ?? null
      finalTextRef.current = ''
      // Reset diagnostic counters per turn so each answer's log starts
      // at frame 0. Ring buffer keeps prior turns' packets until capped.
      audioFrameCountRef.current = 0
      wordsRef.current = []
      lastTranscriptRef.current = ''
      reconnectAttemptsRef.current = 0
      isFinishingRef.current = false
      startTimeRef.current = Date.now()
      setLiveTranscript('')

      // Fresh listening session — drop any stale interrupt-accumulator
      // fragments so a prior almost-interrupt doesn't combine with this
      // session's early words to spuriously cross the ≥3-word threshold.
      interruptAccumRef.current = ''
      if (interruptAccumTimerRef.current) {
        clearTimeout(interruptAccumTimerRef.current)
        interruptAccumTimerRef.current = null
      }

      // Safety timeout: if capture-ready never fires (e.g. getUserMedia rejected),
      // fire the callback anyway after 1500ms so the UI doesn't stall.
      // 1500ms accounts for first-call getUserMedia latency (400-800ms) + AudioContext init.
      const captureReadySafety = options?.onCaptureReady
        ? setTimeout(() => {
            if (onCaptureReadyRef.current) {
              onCaptureReadyRef.current()
              onCaptureReadyRef.current = null
            }
          }, 1500)
        : undefined

      // Wrap the original onCaptureReady to also clear the safety timeout
      const originalOnCaptureReady = onCaptureReadyRef.current
      if (originalOnCaptureReady && captureReadySafety) {
        onCaptureReadyRef.current = () => {
          clearTimeout(captureReadySafety)
          originalOnCaptureReady()
          onCaptureReadyRef.current = null
        }
      }

      // If warmed up and WebSocket is already connected, start capture immediately
      if (isWarmedUpRef.current && wsRef.current?.readyState === WebSocket.OPEN) {
        setIsListening(true)
        // Do NOT clear the KeepAlive interval here. Previous revisions
        // assumed PCM audio frames would keep the socket alive on their
        // own — but Deepgram confirmed (support thread, 2026-04-18) that
        // /v1/listen idle-closes after ~12s of no data with close code
        // 1011 + "NET-0001" reason, and the recommended mitigation is to
        // send `{"type":"KeepAlive"}` every 3–5s regardless of audio
        // flow. ScriptProcessorNode (deprecated) can throttle on tab
        // backgrounding or main-thread pressure, which stalls audio long
        // enough to trigger the idle close. KeepAlive pings are free
        // insurance — Deepgram ignores them when audio is flowing.
        // See R3 investigation on session 01RUySybLLDdv36aXXFbuRsr.
        // The warmUp's onopen already started a 5s KeepAlive interval;
        // we simply let it continue through the listening session. It
        // will be cleared by ws.onclose / stopListening / teardown.
        // The warmUp WebSocket was created without an onmessage handler —
        // attach it now so Deepgram results are actually received.
        attachMessageHandler(wsRef.current)
        startAudioCapture(wsRef.current)
        isWarmedUpRef.current = false
        return
      }

      // If warmUp is in progress, wait for it then start capture
      if (warmUpPromiseRef.current) {
        warmUpPromiseRef.current
          .then(() => {
            if (wsRef.current?.readyState === WebSocket.OPEN) {
              setIsListening(true)
              // Same rationale as the fast path: do NOT clear KeepAlive
              // here. Deepgram idle-closes /v1/listen after ~12s of no
              // data (confirmed via Deepgram support 2026-04-18, close
              // code 1011 + NET-0001). ScriptProcessorNode throttling
              // under main-thread pressure can stall audio long enough
              // to trigger the idle close. Let the 5s KeepAlive started
              // by warmUp continue throughout listening — it's ignored
              // by Deepgram when audio flows normally, and saves the
              // connection when audio stalls.
              attachMessageHandler(wsRef.current)
              startAudioCapture(wsRef.current)
              isWarmedUpRef.current = false
            } else {
              // Warm-up WebSocket failed, fall back to full connection.
              // warmUp's onclose/onerror handlers already clear
              // keepAliveTimerRef when the socket dies, so no extra
              // cleanup is needed on this branch — the timer is already
              // cleared by the time we reach here.
              connectFresh()
            }
          })
          .catch(() => connectFresh())
        return
      }

      // No warm-up — do full connection (original path)
      connectFresh()

      function connectFresh() {
        fetchTokenCached()
          .then((token) => connectWebSocket(token))
          .catch((err) => {
            console.error('Deepgram token fetch failed after retries:', err)
            setIsListening(false)
            // Fire onCaptureReady so the UI transitions from "connecting" state
            // instead of hanging silently. Resolve recognition after 5s (not 30s)
            // so the conversation loop can nudge the user or retry.
            onCaptureReadyRef.current?.()
            onCaptureReadyRef.current = null
            fallbackFinishTimerRef.current = setTimeout(() => {
              if (onCompleteRef.current) {
                finishRecognition('tokenFetchFailed')
              }
            }, 5000)
          })
      }
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    []
  )

  /**
   * Pre-warm: fetch token and connect WebSocket ahead of time.
   * Call this during avatar speech so recognition starts instantly.
   */
  const warmUp = useCallback(() => {
    // [DIAGNOSTIC] Temporary Q1-latency perf marker — see matching
    // console.timeEnd in ws.onopen below. Measures how long the warmUp
    // WebSocket takes to reach OPEN state. Remove once Q1 listening
    // delay is diagnosed.
    // eslint-disable-next-line no-console
    console.time('[perf:stt] warmUp→wsOpen')
    // Skip if already warmed up or connecting
    if (isWarmedUpRef.current || warmUpPromiseRef.current) return
    if (wsRef.current?.readyState === WebSocket.OPEN) return

    const promise = fetchTokenCached()
      .then((token) => {
        return new Promise<void>((resolve) => {
          const wsUrl = 'wss://api.deepgram.com/v1/listen?model=nova-2&smart_format=true&filler_words=true&utterance_end_ms=2500&interim_results=true&language=en&encoding=linear16&sample_rate=16000'
          const ws = new WebSocket(wsUrl, ['token', token])

          // Per-socket KeepAlive timer handle. See connectWebSocket for
          // the full rationale — Codex P1 #2 on PR #291 pointed out the
          // same race applies here: a delayed warmUp socket close can
          // arrive AFTER a subsequent connectWebSocket has opened a new
          // cold socket and installed its own timer. If warmUp's close
          // handlers clear `keepAliveTimerRef.current` unconditionally,
          // they wipe the new cold socket's active timer → idle-close
          // reconnect loop returns. Closure-local handle + identity
          // check prevents that.
          let myKeepAliveTimer: ReturnType<typeof setInterval> | null = null
          const clearMyKeepAlive = () => {
            if (myKeepAliveTimer !== null) {
              clearInterval(myKeepAliveTimer)
              // Only null-out the shared ref if it still points at OUR
              // timer. If a connectWebSocket reconnect already overwrote
              // it, leave alone — we must not kill the active session.
              if (keepAliveTimerRef.current === myKeepAliveTimer) {
                keepAliveTimerRef.current = null
              }
              myKeepAliveTimer = null
            }
          }

          ws.onopen = () => {
            // [DIAGNOSTIC] Paired with warmUp→wsOpen timer above.
            // eslint-disable-next-line no-console
            console.timeEnd('[perf:stt] warmUp→wsOpen')
            wsRef.current = ws
            isWarmedUpRef.current = true
            warmUpPromiseRef.current = null
            // Keep the idle socket alive. Deepgram closes /v1/listen after
            // ~12s of no inbound data (confirmed via support 2026-04-18);
            // intro TTS runs 12s+ so without this ping the warm socket
            // dies before startListening can use it.
            if (keepAliveTimerRef.current) clearInterval(keepAliveTimerRef.current)
            myKeepAliveTimer = setInterval(() => {
              if (ws.readyState === WebSocket.OPEN) {
                try { ws.send(JSON.stringify({ type: 'KeepAlive' })) } catch { /* ignore */ }
              }
            }, 5000)
            keepAliveTimerRef.current = myKeepAliveTimer
            resolve()
          }
          ws.onerror = () => {
            warmUpPromiseRef.current = null
            clearMyKeepAlive()
            resolve() // Don't reject — startListening will fall back
          }
          ws.onclose = (ev) => {
            if (isWarmedUpRef.current) {
              isWarmedUpRef.current = false
            }
            // Pipe close event to server so it shows up in Vercel
            // `level:error` logs. The STT WebSocket runs browser ↔
            // deepgram.com directly so close codes never hit our server
            // unless we explicitly forward them. Fire-and-forget —
            // failure here must not affect the interview. Mid-answer
            // cutoff diagnosis depends on seeing which close codes
            // (1006 network, 1011 idle, 4xxx Deepgram-specific) fire.
            // `trigger` identifies which code path initiated the close
            // (e.g. `warmUpTimeout`, `stopListeningExternal`). Needed
            // because client-initiated `ws.close()` collapses to code
            // 1005 in onclose — useless for root-cause analysis without
            // a label. The tag lives on THIS socket instance so a late
            // onclose from a stale reconnect peer cannot consume the
            // tag set for a currently-active socket. Codex P2 on PR #293.
            const triggerForLog = (ws as TaggedWebSocket).__finishTrigger ?? null
            fetch('/api/debug/deepgram-ws-close', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({
                code: ev.code,
                reason: ev.reason ?? '',
                wasClean: ev.wasClean,
                context: 'warmUp',
                trigger: triggerForLog,
              }),
            }).catch(() => { /* ignore */ })
            clearMyKeepAlive()
          }

          // Timeout: if WebSocket hasn't opened within 5s, give up.
          // Only the CONNECTING state can be aborted cleanly — close
          // there fires an onclose that will read the tag. On
          // CLOSING/CLOSED the close is a no-op and no onclose would
          // follow to consume the tag, which would corrupt the NEXT
          // session's debug POST (Codex P1 on PR #293). On OPEN the
          // connection succeeded and the timeout is a no-op —
          // preserving the pre-fix behavior where this branch left
          // healthy warm sockets (and their KeepAlive) untouched.
          setTimeout(() => {
            const s = ws.readyState
            if (s === WebSocket.OPEN) return
            if (s === WebSocket.CONNECTING) {
              ;(ws as TaggedWebSocket).__finishTrigger = 'warmUpTimeout'
              ws.close(FINISH_TRIGGER_CODES.warmUpTimeout, 'warmUpTimeout')
            }
            // CONNECTING → close-and-unwind; CLOSING/CLOSED → unwind only
            warmUpPromiseRef.current = null
            clearMyKeepAlive()
            resolve()
          }, 5000)
        })
      })
      .catch(() => {
        warmUpPromiseRef.current = null
      })

    warmUpPromiseRef.current = promise
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  /** Fetch token with caching — reuses token across questions. */
  async function fetchTokenCached(): Promise<string> {
    if (cachedTokenRef.current) return cachedTokenRef.current
    const token = await fetchDeepgramTokenWithRetry()
    cachedTokenRef.current = token
    return token
  }

  async function fetchDeepgramTokenWithRetry(retries = 2): Promise<string> {
    for (let attempt = 0; attempt < retries; attempt++) {
      try {
        return await fetchDeepgramToken()
      } catch (err) {
        if (attempt < retries - 1) {
          console.warn(`Deepgram token fetch attempt ${attempt + 1} failed, retrying...`)
          await new Promise(r => setTimeout(r, 1500))
        } else {
          throw err
        }
      }
    }
    throw new Error('All token fetch attempts failed')
  }

  async function fetchDeepgramToken(): Promise<string> {
    const res = await fetch('/api/transcribe/token', { method: 'POST' })
    if (!res.ok) {
      throw new Error(`Token request failed with ${res.status}`)
    }
    const data = await res.json()
    if (!data.token) {
      console.error('[Deepgram] Token endpoint returned no token:', data)
      throw new Error('No token returned')
    }
    return data.token
  }

  /** Push a bounded summary of one Deepgram message onto the diagnostic
   *  ring buffer. Side-effect-free — does not inspect or touch transcript
   *  state. See `DeepgramPacketLog` for field meanings. */
  function recordPacket(data: Record<string, unknown>) {
    const MAX_PACKETS = 500
    const alt = (data.channel as { alternatives?: Array<{ transcript?: string; words?: Array<{ word: string; start: number; end: number }> }> })
      ?.alternatives?.[0]
    const entry: DeepgramPacketLog = {
      t: Date.now(),
      type: typeof data.type === 'string' ? data.type : 'unknown',
      isFinal: typeof data.is_final === 'boolean' ? data.is_final : undefined,
      speechFinal: typeof data.speech_final === 'boolean' ? data.speech_final : undefined,
      start: typeof data.start === 'number' ? data.start : undefined,
      duration: typeof data.duration === 'number' ? data.duration : undefined,
      transcript: typeof alt?.transcript === 'string' ? alt.transcript : undefined,
      words: alt?.words?.slice(0, 8).map(w => ({ word: w.word, start: w.start, end: w.end })),
      framesSentAtRx: audioFrameCountRef.current,
    }
    const buf = packetLogRef.current
    buf.push(entry)
    if (buf.length > MAX_PACKETS) buf.splice(0, buf.length - MAX_PACKETS)
  }

  /** Attach the Deepgram message handler to a WebSocket.
   *  Called from both connectWebSocket (cold path) and the fast warmUp path.
   *  Without this, the warmed-up WS has no onmessage → transcripts are never received. */
  function attachMessageHandler(ws: WebSocket) {
    ws.onmessage = (event) => {
      try {
        const data = JSON.parse(event.data)

        // ── Diagnostic capture (no behavior effect) ──
        // Snapshot every packet's shape for root-cause investigation of
        // overlapping is_final transcripts seen in prod. Bounded ring
        // buffer — cap at 500 so session memory stays tiny (~100KB).
        recordPacket(data)

        if (data.type === 'Results') {
          const transcript = data.channel?.alternatives?.[0]?.transcript || ''
          const isFinal = data.is_final

          // Interrupt detection: speech detected while no active listening session.
          // Require ≥3 words to avoid false positives from breaths, mic pops,
          // keyboard clicks, or 1-word mishearings like "uh" / "mm". Real
          // candidate interrupts ("wait, can I clarify", "I'd like to restart")
          // are always multi-word.
          //
          // Deepgram can split one utterance into multiple `is_final` packets
          // (e.g. "wait can" then "I clarify"), so checking per-packet misses
          // genuine multi-word interrupts. Accumulate across packets and check
          // the running total. See INTERVIEW_FLOW.md §8 (Codex P1).
          if (isFinal && transcript && !onCompleteRef.current && onInterruptRef.current && !suppressInterruptRef.current) {
            interruptAccumRef.current = interruptAccumRef.current
              ? `${interruptAccumRef.current} ${transcript}`
              : transcript

            // Reset the accumulator after 2s of silence so fragments from
            // one mic blip don't linger and combine with unrelated later
            // noise to cross the threshold.
            if (interruptAccumTimerRef.current) {
              clearTimeout(interruptAccumTimerRef.current)
            }
            interruptAccumTimerRef.current = setTimeout(() => {
              interruptAccumRef.current = ''
              interruptAccumTimerRef.current = null
            }, 2000)

            const wordCount = interruptAccumRef.current
              .trim()
              .split(/\s+/)
              .filter(Boolean).length
            if (wordCount >= 3) {
              // Clear the accumulator so subsequent packets don't re-fire.
              interruptAccumRef.current = ''
              if (interruptAccumTimerRef.current) {
                clearTimeout(interruptAccumTimerRef.current)
                interruptAccumTimerRef.current = null
              }
              onInterruptRef.current()
              return
            }
          }

          if (isFinal && transcript) {
            // New speech arrived — cancel any pending grace period timer.
            // The user is still talking; don't finalize yet.
            if (graceTimerRef.current) {
              clearTimeout(graceTimerRef.current)
              graceTimerRef.current = null
            }
          } else if (!isFinal && transcript && graceTimerRef.current) {
            // Interim results also indicate active speech — cancel grace.
            // Deepgram sends interim results ~200ms before is_final. Without
            // this, a natural 2.5s pause triggers UtteranceEnd → 1.5s grace,
            // and if is_final arrives after 1.5s (high latency), the user
            // gets cut off mid-sentence. Interim results arrive faster.
            clearTimeout(graceTimerRef.current)
            graceTimerRef.current = null
          }

          if (isFinal && transcript) {

            finalTextRef.current = finalTextRef.current
              ? `${finalTextRef.current} ${transcript}`
              : transcript

            const rawWords = data.channel?.alternatives?.[0]?.words as
              | Array<{ word: string; start: number; end: number; confidence?: number }>
              | undefined
            if (rawWords?.length) {
              const turnStartAudioSec = wallClockMsToAudioSeconds(startTimeRef.current)
              for (const w of rawWords) {
                wordsRef.current.push({
                  word: w.word,
                  start: turnStartAudioSec + w.start,
                  end: turnStartAudioSec + w.end,
                  confidence: typeof w.confidence === 'number' ? w.confidence : 1,
                })
              }
            }
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

        // ── Adaptive grace period on UtteranceEnd ──
        // Instead of immediately finalizing when Deepgram detects silence,
        // start a grace period. If the user resumes speaking, the timer is
        // cancelled (above). This prevents cutting off users who pause
        // naturally while thinking. Short answers get a longer grace period
        // since the user likely isn't done yet.
        if (data.type === 'UtteranceEnd') {
          // E-3.7: skip grace-timer scheduling while the tab is hidden.
          // Browsers suspend AudioContext when backgrounded, so Deepgram
          // sees silence and fires UtteranceEnd even though the candidate
          // didn't actually stop speaking. The visibility handler will
          // also cancel any in-flight grace timer when the tab returns,
          // letting the next is_final or UtteranceEnd resume normal flow.
          if (finalTextRef.current.trim().length > 0 && !isPageHiddenRef.current) {
            // Clear any existing grace timer (e.g., from a previous UtteranceEnd)
            if (graceTimerRef.current) {
              clearTimeout(graceTimerRef.current)
            }
            // Classify the candidate's utterance-end signal so grace
            // window matches intent. 'complete' gets a short 3s window
            // (don't add dead air after a clean natural end), 'incomplete'
            // 8s (trailing off with a conjunction — might resume), and
            // 'thinkingRequest' 30s (explicit "let me think" / "give me
            // a moment"). The next interim/is_final cancels the pending
            // grace regardless of window size, so the window is only the
            // UPPER BOUND on silence tolerance.
            //
            // PR #293 production logs showed 74% of closes collapsing
            // into stopListeningExternal — the inactivity timer was
            // firing at the 30s mark because liveAnswerRef was never
            // wired. This intent-based grace fixes the "user takes a
            // breath" failure mode upstream, so most legitimate
            // continuations are caught by grace-cancellation without
            // the useInterview-level inactivity net having to fire.
            const intent = classifyUtteranceIntent(finalTextRef.current)
            const graceMs = GRACE_MS_BY_INTENT[intent]
            graceTimerRef.current = setTimeout(() => {
              graceTimerRef.current = null
              // Double-guard: if the tab was hidden between scheduling and
              // firing (e.g. browser didn't throttle us into the post-visible
              // window), abort. The visibility handler also cancels this
              // timer on the visible event, but we can't rely on one or the
              // other alone — browser timer throttling is implementation-
              // defined across Chrome/Firefox/Safari.
              if (isPageHiddenRef.current) return
              finishRecognition('graceTimer')
            }, graceMs)
          }
        }
      } catch {
        // Ignore JSON parse errors from Deepgram metadata messages
      }
    }
  }

  function connectWebSocket(token: string) {
    if (!navigator.onLine) {
      console.warn('[Deepgram] Browser is offline, skipping WebSocket connect')
      finishRecognition('offline')
      return
    }

    const wsUrl = 'wss://api.deepgram.com/v1/listen?model=nova-2&smart_format=true&filler_words=true&utterance_end_ms=2500&interim_results=true&language=en&encoding=linear16&sample_rate=16000'
    // Use auth via websocket subprotocol so transient token is not logged in the URL.
    const ws = new WebSocket(wsUrl, ['token', token])
    let disconnectHandled = false

    wsRef.current = ws

    const handleDisconnect = () => {
      if (disconnectHandled) return
      disconnectHandled = true
      maybeReconnectOrFinish(token)
    }

    // Per-socket KeepAlive timer handle, captured in the ws's closure.
    // Using a local (not `keepAliveTimerRef.current` directly) so that a
    // late ws.onclose from the OLD socket after reconnect doesn't wipe
    // the NEW socket's active timer. Codex P1 on PR #291. If we only
    // scoped via the shared ref, the following race breaks the fix:
    //   1. old ws fires onerror → handleDisconnect → reconnect → new ws
    //   2. new ws.onopen sets keepAliveTimerRef.current = newTimer
    //   3. old ws.onclose arrives LATE, sees keepAliveTimerRef.current,
    //      clears it — silently killing the new socket's pings
    //   4. new socket then idle-closes again, reintroducing R3
    // Closure-local `myKeepAliveTimer` pins cleanup to THIS ws.
    let myKeepAliveTimer: ReturnType<typeof setInterval> | null = null

    ws.onopen = () => {
      console.log('[Deepgram] WebSocket connected')
      // Refresh the reconnect budget on a successful open so a second
      // network blip 30 minutes later doesn't fail from a stale counter
      // (E-3.4). startListening also resets this at session start.
      reconnectAttemptsRef.current = 0
      setIsListening(true)
      // Start KeepAlive pings against Deepgram's /v1/listen idle close
      // (12s no-data → close 1011 + NET-0001, confirmed via Deepgram
      // support 2026-04-18). The cold path previously had NO KeepAlive
      // start, leaving every cold reconnect vulnerable to idle close if
      // ScriptProcessorNode throttled even briefly. Clear any prior
      // interval first — on reconnect this replaces a stale ref.
      if (keepAliveTimerRef.current) clearInterval(keepAliveTimerRef.current)
      myKeepAliveTimer = setInterval(() => {
        if (ws.readyState === WebSocket.OPEN) {
          try { ws.send(JSON.stringify({ type: 'KeepAlive' })) } catch { /* ignore */ }
        }
      }, 5000)
      keepAliveTimerRef.current = myKeepAliveTimer
      startAudioCapture(ws)
    }

    attachMessageHandler(ws)

    ws.onerror = (err) => {
      console.error('[Deepgram] WebSocket error:', err)
      handleDisconnect()
    }

    ws.onclose = (ev) => {
      // Pipe close event to server so it surfaces in Vercel
      // `level:error` logs. The STT WebSocket runs browser ↔
      // deepgram.com directly so close codes never hit our server
      // unless we explicitly forward them. Fire-and-forget — failure
      // here must not affect the interview. Mid-answer cutoff
      // diagnosis depends on seeing which close codes (1006 network,
      // 1011 idle, 4xxx Deepgram-specific) actually fire.
      // `trigger` identifies which code path initiated the close (e.g.
      // `graceTimer`, `earlyQuestion`, `reconnectExhausted`). Needed
      // because client-initiated `ws.close()` collapses to code 1005
      // in onclose — useless for root-cause analysis without a label.
      // The tag lives on THIS socket instance so a late onclose from
      // a stale reconnect peer cannot consume the tag set for a
      // currently-active socket. Codex P2 on PR #293.
      const triggerForLog = (ws as TaggedWebSocket).__finishTrigger ?? null
      fetch('/api/debug/deepgram-ws-close', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          code: ev.code,
          reason: ev.reason ?? '',
          wasClean: ev.wasClean,
          context: 'connectWebSocket',
          trigger: triggerForLog,
        }),
      }).catch(() => { /* ignore */ })

      // Clear THIS ws's KeepAlive interval. Uses the closure-local
      // handle, not the shared ref, so a late-arriving close from a
      // stale socket after reconnect cannot wipe the new socket's
      // active timer (Codex race). Only null-out the shared ref when
      // it still points at OUR timer — if a reconnect has already
      // overwritten it, leave it alone.
      if (myKeepAliveTimer !== null) {
        clearInterval(myKeepAliveTimer)
        if (keepAliveTimerRef.current === myKeepAliveTimer) {
          keepAliveTimerRef.current = null
        }
        myKeepAliveTimer = null
      }
      // Skip reconnect when WE initiated the close. A non-null
      // __finishTrigger means some finishRecognition / stopListening
      // / warmUpTimeout path already tagged this socket before calling
      // ws.close(). Running handleDisconnect here would schedule a
      // spurious reconnect (`Reconnecting in 800ms`) on top of a
      // legitimately-ended turn — the 800ms guard in maybeReconnectOrFinish
      // usually aborts the attempt but races at session boundaries can
      // leak reconnects into a fresh session. Untagged closes (Deepgram
      // 1011 idle timeout, browser 1006 network drop) still fall through.
      if (triggerForLog === null) {
        handleDisconnect()
      }
    }
  }

  function maybeReconnectOrFinish(token: string) {
    const maxReconnectAttempts = 2
    reconnectAttemptsRef.current++

    if (reconnectAttemptsRef.current > maxReconnectAttempts) {
      console.warn('[Deepgram] Max reconnect attempts reached, finishing')
      finishRecognition('reconnectExhausted')
      return
    }

    // E-3.4: previously we bailed early if finalTextRef had any content —
    // that truncated the candidate's answer on a single network blip. Now
    // we preserve partial text across reconnects (finalTextRef is only
    // cleared at startListening time) and only finish once maxReconnect
    // attempts are exhausted. The old audio processor is bound to the
    // dead ws, so tear it down here — setupAudioProcessing rebuilds fresh
    // on the next onopen.
    processorRef.current?.disconnect()
    sourceRef.current?.disconnect()
    audioContextRef.current?.close().catch(() => {})
    processorRef.current = null
    sourceRef.current = null
    audioContextRef.current = null

    const delay = 800 * reconnectAttemptsRef.current
    console.log(`[Deepgram] Reconnecting in ${delay}ms (attempt ${reconnectAttemptsRef.current})`)
    reconnectTimerRef.current = setTimeout(() => {
      reconnectTimerRef.current = null
      if (onCompleteRef.current && !isFinishingRef.current) {
        connectWebSocket(token)
      }
    }, delay)
  }

  function startAudioCapture(ws: WebSocket) {
    // Reuse external stream (from page-level getUserMedia) if available
    const existingStream = externalStreamRef.current
    if (existingStream) {
      setupAudioProcessing(existingStream, ws, false).catch((err) => {
        console.error('Audio worklet setup failed:', err)
        finishRecognition('getUserMediaFailed')
      })
      return
    }

    // Fallback: request audio-only stream
    navigator.mediaDevices
      .getUserMedia({ audio: true, video: false })
      .then((stream) => setupAudioProcessing(stream, ws, true))
      .catch((err) => {
        console.error('Audio capture failed:', err)
        finishRecognition('getUserMediaFailed')
      })
  }

  async function setupAudioProcessing(stream: MediaStream, ws: WebSocket, ownStream: boolean) {
    if (ownStream) {
      audioStreamRef.current = stream
    }
    const audioContext = new AudioContext({ sampleRate: 16000 })
    audioContextRef.current = audioContext
    // Chrome's autoplay policy can create AudioContext in 'suspended' state
    // after multiple create/close cycles across questions. A suspended
    // context does not fire the AudioWorklet `process()` callback → no
    // PCM → no transcripts, which is indistinguishable from a dead WS at
    // the UI level. resume() is idempotent on a running context and cheap
    // on a suspended one.
    audioContext.resume().catch(() => { /* best-effort */ })

    const source = audioContext.createMediaStreamSource(stream)
    sourceRef.current = source

    // AudioWorkletNode runs on the audio rendering thread and is
    // immune to main-thread throttling (MediaPipe, React, GC, tab
    // backgrounding). See public/pcm-processor.js for the Float32 →
    // Int16 conversion + 32-render-quantum buffering that preserves
    // the 4096-sample / 256ms packet cadence Deepgram was calibrated
    // against. `addModule()` is async; if it fails (ancient browser,
    // CSP block, 404 on the static asset) the rejection bubbles to
    // startAudioCapture which routes to finishRecognition.
    //
    // Telemetry: we can't run browser QA from the harness, so every
    // load (success or fail) is captured by the shared PostHog track()
    // helper. track() is a no-op when NEXT_PUBLIC_POSTHOG_KEY is unset,
    // so this has zero runtime cost in dev / test / preview-without-
    // PostHog; it only emits an event in prod where the key is wired
    // up. The event carries durationMs (so we can measure cache-hit vs
    // cold-fetch cost in the field) and, on failure, a truncated error
    // string (AudioWorklet rejections tend to be short and known —
    // CSP blocks, SecurityError, unsupported browser).
    const workletStart = Date.now()
    try {
      await audioContext.audioWorklet.addModule('/pcm-processor.js')
    } catch (err) {
      // Stale-setup guard (error path): if the audioContext this setup
      // was spun up for is no longer the active one, a reconnect or stop
      // happened mid-await. Both `maybeReconnectOrFinish` and
      // `finishRecognition` synchronously null `audioContextRef.current`
      // (and `maybeReconnectOrFinish` additionally calls
      // `audioContext.close()`), so the identity check catches both.
      //
      // We intentionally do NOT key off `wsRef.current !== ws` here:
      // during the 800–1600ms reconnect *delay* window,
      // `maybeReconnectOrFinish` has already torn down the AudioContext
      // but has not yet replaced `wsRef.current` (the new ws is created
      // by the delayed `connectWebSocket` call). A ws-identity guard
      // would therefore treat the superseded setup as current, let the
      // rejection propagate into startAudioCapture's `.catch` →
      // `finishRecognition('getUserMediaFailed')` → truncate the in-
      // progress answer and abort the pending reconnect. Codex P1 on
      // PR #300.
      const stale = audioContextRef.current !== audioContext
      track('audio_worklet_loaded', {
        success: false,
        durationMs: Date.now() - workletStart,
        error: String(err instanceof Error ? err.message : err).slice(0, 200),
        stale,
      })
      if (stale) return
      throw err
    }
    // Stale-setup guard (success path): even if addModule resolved,
    // the audioContext we resolved for may have been superseded during
    // the await (reconnect closed it, or finishRecognition stopped us).
    // Constructing an AudioWorkletNode against a closed context below
    // would either throw (latent error path) or succeed and then over-
    // write the active session's processorRef + connect source→worklet
    // →destination on a dead context. Either way: a ghost setup would
    // poison the active session. Bail. See error-path comment above
    // for why context identity is more reliable than ws identity during
    // the reconnect delay window.
    if (audioContextRef.current !== audioContext) {
      track('audio_worklet_loaded', {
        success: true,
        durationMs: Date.now() - workletStart,
        stale: true,
      })
      return
    }
    track('audio_worklet_loaded', {
      success: true,
      durationMs: Date.now() - workletStart,
    })
    // Preserve the mono-input semantics of the retired
    // `createScriptProcessor(4096, 1, 1)` call. The old ScriptProcessor
    // took `numberOfInputChannels=1` which forced the browser to
    // downmix any multi-channel input to mono (spec rule: stereo → mono
    // is `(L + R) / 2`) BEFORE the node received it. AudioWorkletNode
    // defaults to `channelCount=2, channelCountMode='max'`, which would
    // deliver stereo input to the worklet; since pcm-processor.js reads
    // only `inputs[0][0]` (the left channel), a stereo-emitting mic —
    // some Bluetooth headsets, USB arrays, asymmetric laptop built-ins
    // — would ship near-silent left-channel PCM to Deepgram on devices
    // where the speech signal lands on the right channel. Explicit
    // channelCount+channelCountMode replays the old downmix rule
    // deterministically, independent of device channel layout.
    const worklet = new AudioWorkletNode(audioContext, 'pcm-processor', {
      numberOfInputs: 1,
      numberOfOutputs: 1,
      channelCount: 1,
      channelCountMode: 'explicit',
      channelInterpretation: 'speakers',
    })
    processorRef.current = worklet

    worklet.port.onmessage = (e) => {
      if (ws.readyState !== WebSocket.OPEN) return
      // e.data is the transferred ArrayBuffer — 4096 Int16 samples =
      // 8192 bytes. Same wire format Deepgram saw under ScriptProcessor.
      ws.send(e.data)
      // Diagnostic: count every frame we send. Snapshotted into
      // packetLogRef on each inbound Deepgram message so we can detect
      // a potential double-send by looking for an unexpected 2× frame
      // delta between consecutive packets.
      audioFrameCountRef.current++
    }

    source.connect(worklet)
    worklet.connect(audioContext.destination)

    // Visibility handling (resume AudioContext + suppress grace timer while
    // hidden) is installed at the hook level — see the useEffect near the
    // top of the hook. Installing a per-session listener here would leak a
    // handler every listening session AND couldn't prevent the grace timer
    // from firing while hidden, only resume the context after the fact.

    // Audio is now flowing — notify the caller so UI can flip to LISTENING
    // [DIAGNOSTIC] Paired with startListening→captureReady timer above.
    // eslint-disable-next-line no-console
    console.timeEnd('[perf:stt] startListening→captureReady')
    if (onCaptureReadyRef.current) {
      onCaptureReadyRef.current()
      onCaptureReadyRef.current = null
    }
  }

  function finishRecognition(trigger: FinishTrigger = 'stopListeningExternal') {
    if (isFinishingRef.current) return
    isFinishingRef.current = true
    console.log(`[Deepgram] finishRecognition called (trigger=${trigger}), text:`, finalTextRef.current.slice(0, 100))
    setIsListening(false)
    isWarmedUpRef.current = false

    if (fallbackFinishTimerRef.current) {
      clearTimeout(fallbackFinishTimerRef.current)
      fallbackFinishTimerRef.current = null
    }
    if (reconnectTimerRef.current) {
      clearTimeout(reconnectTimerRef.current)
      reconnectTimerRef.current = null
    }
    if (graceTimerRef.current) {
      clearTimeout(graceTimerRef.current)
      graceTimerRef.current = null
    }
    if (keepAliveTimerRef.current) {
      clearInterval(keepAliveTimerRef.current)
      keepAliveTimerRef.current = null
    }

    // Cleanup audio processing
    processorRef.current?.disconnect()
    sourceRef.current?.disconnect()
    audioContextRef.current?.close().catch(() => {})
    processorRef.current = null
    sourceRef.current = null
    audioContextRef.current = null

    // Stop the Deepgram-specific audio stream tracks (NOT the external/page stream)
    if (audioStreamRef.current) {
      audioStreamRef.current.getTracks().forEach(t => t.stop())
      audioStreamRef.current = null
    }

    // Close WebSocket with a labelled code so the onclose handler's
    // debug POST can tell Vercel which trigger terminated the session.
    // Application-defined 4xxx range per RFC 6455 §7.4.2. The `reason`
    // string is intentionally the trigger name itself — redundant with
    // the code, but browsers sometimes swallow codes, and a short
    // reason string is our diagnostic belt-and-suspenders.
    //
    // The trigger is attached directly to the socket (TaggedWebSocket)
    // so reconnect flows can have multiple sockets tearing down
    // concurrently without their onclose handlers consuming each
    // other's state — each onclose reads from its own `ws` closure.
    // The guard also skips CLOSED/CLOSING states where ws.close is a
    // no-op: tagging would leak onto a socket whose onclose already
    // fired. Codex P1 + P2 on PR #293. The console.log at the top of
    // this function still preserves the trigger in browser logs for
    // the no-ws paths (offline / tokenFetchFailed / reconnectExhausted).
    if (wsRef.current && wsRef.current.readyState === WebSocket.OPEN) {
      ;(wsRef.current as TaggedWebSocket).__finishTrigger = trigger
      wsRef.current.close(FINISH_TRIGGER_CODES[trigger], trigger)
    }
    wsRef.current = null

    // Build result.
    // Fall back to lastTranscriptRef (FINAL + INTERIM combined) when finalTextRef
    // is empty — this captures answers where the user spoke in one continuous run
    // without any sentence-boundary pauses that trigger Deepgram is_final commits.
    const text = finalTextRef.current.trim() || lastTranscriptRef.current.trim()
    const durationMinutes = (Date.now() - startTimeRef.current) / 60000
    // Snapshot the accumulated words before we clear the ref — these
    // flow into the multimodal analysis pipeline so it can skip the
    // post-interview Whisper call entirely.
    const turnWords = wordsRef.current
    wordsRef.current = []

    // Snapshot the callback NOW (synchronously) so the async .then() below
    // fires the correct handler even if startListening is called again before
    // the dynamic import resolves. Without this, a rapid double-call to
    // startListening would overwrite onCompleteRef.current and the old
    // session's result would be delivered to the new session's callback.
    const onComplete = onCompleteRef.current
    onCompleteRef.current = null

    // Import analyzeSpeech dynamically to avoid circular deps
    import('@interview/config/speechMetrics')
      .then(({ analyzeSpeech }) => {
        const metrics = analyzeSpeech(text, durationMinutes)
        onComplete?.({ text, durationMinutes, metrics, words: turnWords })
      })
      .catch(() => {
        onComplete?.({
          text,
          durationMinutes,
          metrics: {
            wpm: 0,
            fillerRate: 0,
            pauseScore: 0,
            ramblingIndex: 0,
            totalWords: 0,
            fillerWordCount: 0,
            durationMinutes,
          },
          words: turnWords,
        })
      })
      .finally(() => {
        isFinishingRef.current = false
      })
  }

  /** Map the caller-facing StopListeningReason to the internal
   *  FinishTrigger enum. Kept as a local constant (not top-level) so
   *  TypeScript enforces exhaustiveness with FinishTrigger directly. */
  const stopListening = useCallback((reason?: StopListeningReason) => {
    const trigger: FinishTrigger =
      reason === 'inactivityPreSpeech'   ? 'stopListeningInactivityPreSpeech'
      : reason === 'inactivityPostSpeech' ? 'stopListeningInactivityPostSpeech'
      : reason === 'maxAnswer'            ? 'stopListeningMaxAnswer'
      : reason === 'intentionalSilence'   ? 'stopListeningIntentionalSilence'
      : reason === 'finishInterview'      ? 'stopListeningFinishInterview'
      : reason === 'usageLimit'           ? 'stopListeningUsageLimit'
      : 'stopListeningExternal'
    finishRecognition(trigger)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const setOnInterrupt = useCallback((cb: (() => void) | null) => { onInterruptRef.current = cb }, [])
  const setSuppressInterrupt = useCallback((suppress: boolean) => {
    suppressInterruptRef.current = suppress
    // When suppressing, also clear any accumulated fragments so stale
    // TTS-feedback words don't combine with real speech later.
    if (suppress) {
      interruptAccumRef.current = ''
      if (interruptAccumTimerRef.current) {
        clearTimeout(interruptAccumTimerRef.current)
        interruptAccumTimerRef.current = null
      }
    }
  }, [])

  /** Return and clear the accumulated interrupt speech. Called by listenForAnswer
   *  to prepend interrupt words to the next answer so the candidate doesn't have
   *  to repeat what they said during the interrupt. */
  const getAndClearInterruptAccum = useCallback(() => {
    const text = interruptAccumRef.current.trim()
    interruptAccumRef.current = ''
    if (interruptAccumTimerRef.current) {
      clearTimeout(interruptAccumTimerRef.current)
      interruptAccumTimerRef.current = null
    }
    return text
  }, [])

  return { isListening, liveTranscript, startListening, stopListening, warmUp, setExternalStream, setOnInterrupt, setSuppressInterrupt, getAndClearInterruptAccum }
}
