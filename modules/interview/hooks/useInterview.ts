'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import { useRouter } from 'next/navigation'
import type {
  AvatarEmotion,
  InterviewConfig,
  InterviewState,
  TranscriptEntry,
  AnswerEvaluation,
  SpeechMetrics,
  PerformanceSignal,
  ProbeType,
  ThreadEntry,
  ThreadSummary,
  InterruptContext,
} from '@shared/types'
import {
  getInterviewIntro,
  WRAP_UP_LINE,
  getQuestionCount,
} from '@interview/config/interviewConfig'
import { deriveCoachingTip } from '@interview/config/coachingTips'
import { STORAGE_KEYS, sessionScopedKey } from '@shared/storageKeys'
import type { SpeechRecognitionResult } from './useSpeechRecognition'
import type { StartListeningOptions } from './useDeepgramRecognition'
import type { TurnRouterResult } from './useInterviewAPI'
import {
  classifyIntent,
  CONVERSATION_RESPONSES,
  THINKING_ACKS,
  PRE_QUESTION_FILLERS,
  simplifyQuestion,
  pickRandom,
} from '@interview/config/conversationalResponses'
import { completion } from '@shared/services/modelRouter'
import {
  computePerformanceSignal as computeSignal,
  shouldProbeOrAdvance as probeOrAdvance,
  buildThreadSummary as buildSummary,
  buildProbeQuestion,
  toneToEmotion,
} from './interviewUtils'
import { useAvatarSpeech } from './useAvatarSpeech'
import { useInterviewAPI } from './useInterviewAPI'
import { createDbSession, persistSession, type CreateDbSessionResult } from './interviewPersistence'

// ─── Hook options ─────────────────────────────────────────────────────────────

interface UseInterviewOptions {
  config: InterviewConfig | null
  voicesReady: boolean
  startListening: (onComplete: (result: SpeechRecognitionResult) => void, options?: StartListeningOptions) => void
  stopListening: () => void
  /** Pre-warm STT WebSocket so startListening is instant. */
  warmUpListening?: () => void
  /** Set interrupt callback for speech-during-TTS detection. */
  setOnInterrupt?: (cb: (() => void) | null) => void
  /** Suppress interrupt detection during TTS to prevent self-interruption. */
  setSuppressInterrupt?: (suppress: boolean) => void
  /** Return and clear accumulated interrupt speech for answer prepending. */
  getAndClearInterruptAccum?: () => string
  onRecordingStop?: () => void
  currentProblem?: { id: string; title: string; description: string } | null
  currentDesignProblem?: { id: string; title: string; description: string; requirements: string[] } | null
}

// ─── Hook return ──────────────────────────────────────────────────────────────

export interface UseInterviewReturn {
  phase: InterviewState
  questionIndex: number
  currentQuestion: string
  avatarEmotion: AvatarEmotion
  isAvatarTalking: boolean
  timeRemaining: number
  liveAnswer: string
  sessionId: string | null
  coachingTip: string | null
  /**
   * G.7: optional endReason lets the caller mark *why* the interview ended
   * (time_up, user_ended, normal, etc.) so generate-feedback can later
   * penalize incomplete sessions honestly. Omitting the argument defaults
   * to 'normal' — pre-G.7 callers remain source-compatible.
   */
  finishInterview: (endReason?: 'normal' | 'time_up' | 'user_ended' | 'usage_limit' | 'abandoned') => void
  onCodeSubmit: (code: string, language: string) => void
  onDesignSubmit: (data: import('@shared/types').DesignSubmission) => void
}

// ─── Hook ─────────────────────────────────────────────────────────────────────

export function useInterview({
  config,
  voicesReady,
  startListening,
  stopListening,
  warmUpListening,
  setOnInterrupt,
  setSuppressInterrupt,
  getAndClearInterruptAccum,
  onRecordingStop,
  currentProblem,
  currentDesignProblem,
}: UseInterviewOptions): UseInterviewReturn {
  const router = useRouter()

  // ── State machine ──
  const [phase, setPhase] = useState<InterviewState>('INTERVIEW_START')
  const phaseRef = useRef<InterviewState>('INTERVIEW_START')
  function transitionTo(s: InterviewState) {
    phaseRef.current = s
    setPhase(s)
  }

  // ── Avatar (extracted to useAvatarSpeech) ──
  const isMultimodalEnabled = process.env.NEXT_PUBLIC_FEATURE_MULTIMODAL === 'true'
  const { avatarEmotion, isAvatarTalking, setAvatarEmotion, avatarSpeak: rawAvatarSpeak, prefetchTTS, cancelTTS, softCancelTTS, playAck, cancelAck } = useAvatarSpeech({
    interviewType: config?.interviewType,
    isMultimodalEnabled,
  })

  // Interrupt-capable avatarSpeak: if candidate starts talking during TTS,
  // cancel speech and let the candidate be heard. Deepgram streams continuously.
  // Also discards any queued coaching messages (I6) to avoid stale overlaps.
  const interruptedRef = useRef(false)
  /** Captured interrupt context — populated when candidate interrupts AI speech. */
  const interruptContextRef = useRef<InterruptContext | null>(null)
  /** Topics the AI acknowledged but deferred ("we'll come back to that"). */
  const deferredTopicsRef = useRef<string[]>([])
  const avatarSpeak = useCallback(async (
    text: string,
    emotion?: import('@shared/types').AvatarEmotion,
    onAudioStart?: () => void,
  ): Promise<{ interrupted: boolean; interruptContext: InterruptContext | null }> => {
    interruptedRef.current = false
    interruptContextRef.current = null
    // Suppress interrupt detection during TTS to prevent the AI's own
    // speech (picked up by the mic via speaker feedback) from triggering
    // false interrupts. Only enable interrupts after audio actually starts
    // playing — that's when a real candidate interrupt would occur.
    setSuppressInterrupt?.(true)
    setOnInterrupt?.(() => {
      interruptedRef.current = true
      // Capture interrupt context for downstream decision-making.
      // interruptSpeech comes from Deepgram's interruptAccumRef (the ≥3 words
      // that triggered this handler). spokenPortion is approximated as the full
      // text for now — refined when chunk-level TTS progress tracking is added.
      interruptContextRef.current = {
        interruptedUtterance: text,
        spokenPortion: text,
        interruptSpeech: getAndClearInterruptAccum?.() ?? '',
        phase: phaseRef.current,
        questionIndex: questionIndexRef.current,
      }
      // Soft-cancel: let the current audio buffer drain so the AI finishes
      // its sentence naturally (~1-2s) instead of hard-cutting mid-word.
      softCancelTTS()
      setSuppressInterrupt?.(false)
      // I6: Discard any pending coaching message on interrupt
      coachingAbortRef.current?.abort()
      setCoachingTip(null)
    })
    await rawAvatarSpeak(text, emotion, () => {
      // Audio has started playing — now allow candidate interrupts.
      // Before this point, any mic input is likely echo from the TTS
      // audio playing through speakers, not the candidate speaking.
      setSuppressInterrupt?.(false)
      onAudioStart?.()
    })
    setOnInterrupt?.(null) // Clear interrupt handler after TTS finishes
    setSuppressInterrupt?.(false) // Ensure suppression is cleared
    return {
      interrupted: interruptedRef.current,
      interruptContext: interruptContextRef.current,
    }
  }, [rawAvatarSpeak, setOnInterrupt, setSuppressInterrupt, softCancelTTS])

  // ── DB session id (hoisted above useInterviewAPI so the hook can read it) ──
  const sessionIdRef = useRef<string | null>(null)
  /** Resolves when createDbSession completes. Awaited in start() before Q1
   *  generation so the Document Intelligence Layer (structured resume/JD
   *  parsing) has a sessionId to work with. See Issue #5. */
  const sessionCreationPromiseRef = useRef<Promise<CreateDbSessionResult> | null>(null)

  // ── API calls (extracted to useInterviewAPI) ──
  // Pass a lazy getter for sessionId so the fetch body sends the latest value
  // once createDbSession resolves — without forcing a re-render of this hook.
  const { generateQuestion: apiGenerateQuestion, evaluateAnswer: apiEvaluateAnswer, callTurnRouter: apiCallTurnRouter, flowHintsRef } = useInterviewAPI({
    config,
    getSessionId: () => sessionIdRef.current,
  })

  // ── Interview content ──
  const [currentQuestion, setCurrentQuestion] = useState('')
  const [questionIndex, setQuestionIndex] = useState(0)
  const questionIndexRef = useRef(0)
  const transcriptRef = useRef<TranscriptEntry[]>([])
  const evaluationsRef = useRef<AnswerEvaluation[]>([])
  const pendingEvalRef = useRef<Promise<void> | null>(null)
  const speechMetricsRef = useRef<SpeechMetrics[]>([])
  /** Audio-timeline-relative words captured live by Deepgram across
   *  every candidate turn. Fed into the multimodal analysis pipeline
   *  as a drop-in replacement for post-interview Whisper transcription,
   *  eliminating a redundant STT pass plus its 25MB Groq upload limit. */
  const liveWordsRef = useRef<import('./useSpeechRecognition').LiveTranscriptWord[]>([])

  // ── Live answer capture ──
  const [liveAnswer, _setLiveAnswer] = useState('')
  const liveAnswerRef = useRef('')
  const setLiveAnswer = useCallback((text: string) => {
    liveAnswerRef.current = text
    _setLiveAnswer(text)
  }, [])

  // ── Coaching ──
  const [coachingTip, setCoachingTip] = useState<string | null>(null)
  const coachingAbortRef = useRef<AbortController | null>(null)

  // ── Interview abort (stops the loop on End Interview) ──
  const interviewAbortRef = useRef<AbortController | null>(null)

  // ── Code submission (coding interviews) ──
  const codeSubmitResolverRef = useRef<((submission: { code: string; language: string }) => void) | null>(null)
  const currentProblemRef = useRef(currentProblem)
  currentProblemRef.current = currentProblem

  const onCodeSubmit = useCallback((code: string, language: string) => {
    if (codeSubmitResolverRef.current) {
      codeSubmitResolverRef.current({ code, language })
      codeSubmitResolverRef.current = null
    }
  }, [])

  function waitForCodeSubmission(): Promise<{ code: string; language: string }> {
    return new Promise((resolve, reject) => {
      // If already aborted (e.g. usage limit or timer expired), reject immediately
      if (interviewAbortRef.current?.signal.aborted) {
        reject(new InterviewAbortError())
        return
      }
      codeSubmitResolverRef.current = resolve
      interviewAbortRef.current?.signal.addEventListener('abort', () => {
        reject(new InterviewAbortError())
      }, { once: true })
    })
  }

  // ── Design submission (system design interviews) ──
  const designSubmitResolverRef = useRef<((data: import('@shared/types').DesignSubmission) => void) | null>(null)
  const currentDesignProblemRef = useRef(currentDesignProblem)
  currentDesignProblemRef.current = currentDesignProblem

  const onDesignSubmit = useCallback((data: import('@shared/types').DesignSubmission) => {
    if (designSubmitResolverRef.current) {
      designSubmitResolverRef.current(data)
      designSubmitResolverRef.current = null
    }
  }, [])

  function waitForDesignSubmission(): Promise<import('@shared/types').DesignSubmission> {
    return new Promise((resolve, reject) => {
      if (interviewAbortRef.current?.signal.aborted) {
        reject(new InterviewAbortError())
        return
      }
      designSubmitResolverRef.current = resolve
      interviewAbortRef.current?.signal.addEventListener('abort', () => {
        reject(new InterviewAbortError())
      }, { once: true })
    })
  }

  class InterviewAbortError extends Error {
    constructor() { super('Interview aborted'); this.name = 'InterviewAbortError' }
  }

  function checkAbort() {
    if (interviewAbortRef.current?.signal.aborted) throw new InterviewAbortError()
  }

  function getAbortSignal(): AbortSignal | undefined {
    return interviewAbortRef.current?.signal
  }

  // ── Performance signal (progressive difficulty) ──
  const performanceSignalRef = useRef<PerformanceSignal>('calibrating')

  // ── Question prefetch (parallel loading during coaching) ──
  const prefetchedQuestionRef = useRef<Promise<string> | null>(null)

  // ── Thread tracking (adaptive probing) ──
  const currentTopicIndexRef = useRef(0)
  const currentProbeDepthRef = useRef(0)
  const currentThreadRef = useRef<ThreadEntry[]>([])
  const completedThreadsRef = useRef<ThreadSummary[]>([])

  // ── Thinking pause mode (TM1) — suspends silence timeout while candidate thinks ──
  const isThinkingPauseRef = useRef(false)

  // ── BUG 4 fix: cooldown for "take your time" nudge ──
  // Once fired, don't repeat for 2 minutes (effectively once per short
  // interview). Reset on finish, not per question — Rakshit reported it
  // firing on the 4th question after 3 successful answers, which felt
  // patronizing.
  const lastTakeYourTimeRef = useRef<number>(0)

  // ── Timer ──
  const [timeRemaining, setTimeRemaining] = useState(0)
  const timeRemainingRef = useRef(0)

  // ── DB session ──
  // Note: sessionIdRef is declared above (near useInterviewAPI) so it can be
  // passed to the API hook. Declared here would cause a duplicate-identifier error.
  const usageLimitReachedRef = useRef(false)

  // ─── Init timer + DB session ────────────────────────────────────────────────

  useEffect(() => {
    if (!config) return
    setTimeRemaining(config.duration * 60)
    timeRemainingRef.current = config.duration * 60

    // NOTE: createDbSession runs concurrently with the start() effect below.
    // sessionIdRef may not be populated during the intro phase. This is safe
    // because no DB persist occurs until finishInterview(), which runs much later.
    // localStorage captures all data as a backup regardless.
    //
    // Retake linkage: if the user initiated this session as a retake from
    // the feedback page, a pending parent id was written to localStorage.
    // We read and clear it here so the backend can link the new session to
    // the chain root and later feedback pages can diff scores vs. parent.
    let pendingRetakeParent: string | undefined
    try {
      const raw = localStorage.getItem(STORAGE_KEYS.PENDING_RETAKE_PARENT)
      if (raw) pendingRetakeParent = raw
      localStorage.removeItem(STORAGE_KEYS.PENDING_RETAKE_PARENT)
    } catch { /* ignore */ }

    const dbSessionPromise = createDbSession(config, pendingRetakeParent)
    sessionCreationPromiseRef.current = dbSessionPromise
    dbSessionPromise.then((result) => {
      if (result.limitReached) {
        usageLimitReachedRef.current = true
        interviewAbortRef.current?.abort()
        coachingAbortRef.current?.abort()
        stopListening()
        onRecordingStop?.()
        setCurrentQuestion('Monthly interview limit reached. Please upgrade your plan to continue.')
        setCoachingTip('You have reached your monthly interview limit. Visit Pricing to upgrade and keep practicing.')
        transitionTo('ENDED')
        localStorage.removeItem(STORAGE_KEYS.INTERVIEW_ACTIVE_SESSION)
        localStorage.removeItem(STORAGE_KEYS.INTERVIEW_CONFIG)
        // Redirect home after a brief delay so the user sees the message
        setTimeout(() => router.push('/'), 4000)
        return
      }

      if (result.sessionId) {
        sessionIdRef.current = result.sessionId
        // Mark session as active to prevent duplicate creation on back navigation
        localStorage.setItem(STORAGE_KEYS.INTERVIEW_ACTIVE_SESSION, result.sessionId)
        persistSession(result.sessionId, {
          status: 'in_progress',
          startedAt: new Date().toISOString(),
          // Track problem IDs for cross-session repeat prevention
          ...(currentProblemRef.current ? { codingProblemId: currentProblemRef.current.id } : {}),
          ...(currentDesignProblemRef.current ? { designProblemId: currentDesignProblemRef.current.id } : {}),
        })
      }
    })
  }, [config]) // eslint-disable-line react-hooks/exhaustive-deps

  // ─── Timer countdown with milestone nudges (TM6) ────────────────────────

  const firedMilestonesRef = useRef<Set<number>>(new Set())

  useEffect(() => {
    if (!config) return
    const tick = setInterval(() => {
      setTimeRemaining((t) => {
        const next = Math.max(0, t - 1)
        timeRemainingRef.current = next

        // TM6: Milestone nudges at 90s and 30s remaining
        if (next === 90 && !firedMilestonesRef.current.has(90) && phaseRef.current !== 'SCORING' && phaseRef.current !== 'ENDED') {
          firedMilestonesRef.current.add(90)
          setCoachingTip("We're running low on time, aim to wrap up your current thought.")
          setTimeout(() => setCoachingTip(prev => prev?.includes('running low') ? null : prev), 4000)
        }
        if (next === 30 && !firedMilestonesRef.current.has(30) && phaseRef.current !== 'SCORING' && phaseRef.current !== 'ENDED') {
          firedMilestonesRef.current.add(30)
          setCoachingTip('Last 30 seconds, wrap up when ready.')
          setTimeout(() => setCoachingTip(prev => prev?.includes('Last 30') ? null : prev), 4000)
        }

        // TM6: At time=0, give grace for any active phase so the AI doesn't
        // cut off mid-word (ASK_QUESTION) or lose an in-flight eval (PROCESSING).
        // LISTENING gets 15s (user finishing answer), other active phases get 5s
        // (AI finishing current sentence / eval completing).
        if (next === 0 && phaseRef.current !== 'SCORING' && phaseRef.current !== 'ENDED') {
          const activePhase = phaseRef.current
          if (activePhase === 'LISTENING') {
            setCoachingTip('Time is up, please finish your current thought.')
            setTimeout(() => {
              if (phaseRef.current !== 'SCORING' && phaseRef.current !== 'ENDED') {
                // G.7: timer-expired exit — tag it so generate-feedback
                // can differentiate "ran out of time" from "candidate quit".
                finishInterview('time_up')
              }
            }, 15000)
          } else if (activePhase === 'ASK_QUESTION' || activePhase === 'PROCESSING' || activePhase === 'COACHING') {
            // Let AI finish speaking / eval settle before ending
            setTimeout(() => {
              if (phaseRef.current !== 'SCORING' && phaseRef.current !== 'ENDED') {
                finishInterview('time_up')
              }
            }, 5000)
          } else {
            finishInterview('time_up')
          }
        }
        return next
      })
    }, 1000)
    return () => clearInterval(tick)
  }, [config]) // eslint-disable-line react-hooks/exhaustive-deps

  // ─── Transcript helpers ────────────────────────────────────────────────────

  const addToTranscript = useCallback(
    (speaker: 'interviewer' | 'candidate', text: string, qIdx?: number) => {
      const entry: TranscriptEntry = { speaker, text, timestamp: Date.now(), questionIndex: qIdx }
      transcriptRef.current = [...transcriptRef.current, entry]
    },
    []
  )

  // ─── Performance signal computation ────────────────────────────────────────

  function computePerformanceSignal(): PerformanceSignal {
    return computeSignal(evaluationsRef.current)
  }

  // ─── API wrappers (delegate to useInterviewAPI with local refs) ─────────────

  const generateQuestion = useCallback(
    (qIdx: number, completedThreadsOverride?: ThreadSummary[]): Promise<string> =>
      apiGenerateQuestion(
        qIdx,
        // Cap to last 8 transcript entries (~4 Q&A pairs) to keep prompt size bounded.
        // completedThreadsRef already carries older topic summaries for context diversity.
        transcriptRef.current.slice(-8),
        performanceSignalRef.current,
        completedThreadsOverride ?? completedThreadsRef.current,
        getAbortSignal(),
      ),
    [apiGenerateQuestion]
  )

  const evaluateAnswer = useCallback(
    (question: string, answer: string, qIdx: number, probeDepth?: number): Promise<AnswerEvaluation> =>
      apiEvaluateAnswer(question, answer, qIdx, probeDepth, getAbortSignal(),
        evaluationsRef.current.slice(-5).map(e => ({
          question: e.question?.slice(0, 80) || '',
          answerSummary: e.answerSummary || e.answer?.slice(0, 150) || '',
        })),
      ),
    [apiEvaluateAnswer]
  )

  // ─── Shared helpers (DRY: listening + evaluation + coaching) ──────────────

  /** Listen for candidate speech and collect metrics. Resolves with the answer text.
   *  @param showLive - whether to update live answer display
   *  @param timeoutMs - max time to wait for speech (default 30s). 0 = no timeout.
   */
  /** Max answer duration (180s) — prevents candidate from monopolizing time */
  const MAX_ANSWER_MS = 180_000

  function listenForAnswer(
    showLive: boolean = true,
    timeoutMs: number = 30000,
    onCaptureReady?: () => void,
  ): Promise<string> {
    // Bridge interrupt words: if the candidate interrupted AI speech, their
    // interrupt words (≥3 words from Deepgram) are the start of their answer.
    // Prepend them so the candidate doesn't have to repeat themselves.
    const interruptPrefix = interruptContextRef.current?.interruptSpeech ?? ''
    if (interruptPrefix) {
      // Seed the live answer display so it shows immediately
      setLiveAnswer(interruptPrefix)
    }

    // Periodically update avatar emotion during listening based on answer growth
    let lastWordCount = 0
    const emotionInterval = setInterval(() => {
      const currentAnswer = liveAnswerRef.current || ''
      const wordCount = currentAnswer.split(/\s+/).filter(Boolean).length
      if (wordCount > lastWordCount) {
        if (wordCount > 80) {
          setAvatarEmotion('impressed')
        } else if (wordCount > 30) {
          setAvatarEmotion('friendly')
        } else {
          setAvatarEmotion('curious')
        }
        lastWordCount = wordCount
      }
    }, 3000)

    return new Promise((resolve) => {
      let resolved = false
      let timeoutTimer: ReturnType<typeof setTimeout> | undefined
      let maxTimer: ReturnType<typeof setTimeout> | undefined

      const wrappedOnCaptureReady = onCaptureReady

      startListening((result) => {
        if (resolved) return
        resolved = true
        clearTimeout(timeoutTimer)
        clearTimeout(maxTimer)
        clearInterval(emotionInterval)
        if (result.metrics) {
          speechMetricsRef.current.push(result.metrics)
        }
        if (result.words?.length) {
          liveWordsRef.current.push(...result.words)
        }
        const fullText = interruptPrefix
          ? `${interruptPrefix} ${result.text}`.trim()
          : result.text
        if (showLive) setLiveAnswer(fullText)
        resolve(fullText)
      }, { onCaptureReady: wrappedOnCaptureReady })

      // Speech-aware inactivity timeout.
      // Fires after timeoutMs of NO speech progress. If the user is actively
      // speaking (liveAnswerRef growing), the timer reschedules itself so the
      // candidate is never cut off mid-answer. Only fires when the user hasn't
      // started speaking or has gone silent for timeoutMs.
      //
      // IMPORTANT: do NOT set resolved=true or call resolve('') here — doing so
      // creates a race with finishRecognition's async onComplete callback (which
      // fires after a dynamic import). If resolved=true is set first, the
      // startListening callback guard discards the actual captured text and the
      // promise resolves with '' even when finalTextRef had a full answer.
      // Instead, let stopListening() → finishRecognition() → onComplete fire
      // naturally with result.text. A 3-second safety timeout handles the edge
      // case where onComplete never fires (e.g. dynamic import hangs).
      if (timeoutMs > 0) {
        // Start from the interrupt prefix length so the prefix alone
        // doesn't count as "speech progress" and cause a false reschedule.
        let lastSeenLength = interruptPrefix.length
        const scheduleInactivityTimeout = () => {
          timeoutTimer = setTimeout(() => {
            if (resolved) return
            const currentLength = (liveAnswerRef.current || '').length
            if (currentLength > lastSeenLength) {
              // User is still speaking — reset the inactivity clock
              lastSeenLength = currentLength
              scheduleInactivityTimeout()
            } else {
              // No new speech for timeoutMs — stop listening
              clearTimeout(maxTimer)
              clearInterval(emotionInterval)
              stopListening()
              // Safety net: if onComplete doesn't fire within 3s, resolve empty
              setTimeout(() => {
                if (!resolved) {
                  resolved = true
                  resolve('')
                }
              }, 3000)
            }
          }, timeoutMs)
        }
        scheduleInactivityTimeout()
      }

      // Hard cap: stop listening after MAX_ANSWER_MS regardless of speech
      maxTimer = setTimeout(() => {
        if (!resolved) {
          resolved = true
          clearTimeout(timeoutTimer)
          clearInterval(emotionInterval)
          stopListening()
          // Resolve with whatever was captured so far
          resolve(liveAnswerRef.current || '')
        }
      }, MAX_ANSWER_MS)
    })
  }

  /** Returns true if interview has been ended/scored (should bail out of loop). */
  function isInterviewOver(): boolean {
    return (
      (phaseRef.current as string) === 'SCORING' ||
      (phaseRef.current as string) === 'ENDED'
    )
  }

  /** Show coaching tip briefly.
   *  In coach mode: blocks so the candidate reads the full tip.
   *  In normal mode: fires-and-forgets so the next question can start
   *  immediately — the tip auto-dismisses after a length-aware delay
   *  or when the next transitionTo('ASK_QUESTION') clears it. */
  async function showCoachingTip(evaluation: AnswerEvaluation): Promise<void> {
    transitionTo('COACHING')
    const tip = deriveCoachingTip(evaluation, config?.role, config?.interviewType, evaluation.primaryGap)
    setCoachingTip(tip)

    // BUG 5 fix: scale dismissal time to tip length so longer STAR-style
    // tips (100+ chars) don't disappear before the candidate can read them.
    // Reading speed ~50 chars/sec; add 1s buffer for context-switching.
    const tipLength = tip.length
    const normalDismissMs = tipLength > 100 ? 6000 : tipLength > 50 ? 4000 : 2000
    const coachDismissMs = Math.max(3000, normalDismissMs)

    if (config?.coachMode) {
      // Coach mode: block so the candidate can read the full tip
      const abortCtrl = new AbortController()
      coachingAbortRef.current = abortCtrl
      await new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, coachDismissMs)
        abortCtrl.signal.addEventListener('abort', () => {
          clearTimeout(timer)
          resolve()
        })
      })
      coachingAbortRef.current = null
      if (!abortCtrl.signal.aborted) {
        setCoachingTip(null)
      }
    } else {
      // Normal mode: don't block — auto-dismiss after the length-aware delay.
      // The tip is also cleared on next transitionTo('ASK_QUESTION').
      setTimeout(() => {
        // Only clear if coaching tip hasn't been replaced by something else
        setCoachingTip((prev) => (prev === tip ? null : prev))
      }, normalDismissMs)
    }
  }

  // Thinking acknowledgments — uses expanded set from conversationalResponses
  const ackCountRef = useRef(0)
  /** Track candidate-initiated clarifying questions for scoring signal */
  const clarifyingQCountRef = useRef(0)

  /** Evaluate answer, accumulate result, show coaching tip. Optionally runs a concurrent task in parallel with evaluation. */
  async function evaluateAndCoach<T = void>(
    question: string,
    answer: string,
    qIdx: number,
    concurrentTask?: Promise<T>,
    probeDepth?: number,
  ): Promise<{ evaluation: AnswerEvaluation; concurrentResult: T }> {
    transitionTo('PROCESSING')
    setLiveAnswer('')
    setAvatarEmotion('curious') // Show engagement during processing

    // Play a brief thinking acknowledgment if eval takes >800ms.
    // Only fires once every ~3 turns to avoid sounding robotic. Uses
    // the decoupled `playAck` channel so the next question's avatarSpeak
    // does NOT cancel an in-flight ack (see INTERVIEW_FLOW.md §7.6).
    // The 800ms delay (was 1500ms) matches Haiku's ~1-2s eval latency
    // so the ack actually fires before evaluation returns.
    let ackCancelled = false
    const shouldAck = !config?.coachMode && ackCountRef.current % 3 === 0
    const ackTimer = shouldAck
      ? setTimeout(() => {
          if (!ackCancelled) {
            const ack = THINKING_ACKS[ackCountRef.current % THINKING_ACKS.length]
            playAck(ack)
          }
        }, 800)
      : undefined

    const [evaluation, concurrentResult] = await Promise.all([
      evaluateAnswer(question, answer, qIdx, probeDepth),
      concurrentTask ?? (Promise.resolve(undefined) as Promise<T>),
    ])

    // Cancel acknowledgment.
    //
    // `ackCancelled` + `clearTimeout` only protect the case where eval
    // returns BEFORE the 800ms timer fires. If eval returns AFTER the
    // timer fires, `playAck` has already been launched and its fetch
    // is in flight on the isolated ack channel. Without `cancelAck`,
    // a slow /api/tts fetch (especially first cache-miss phrases) can
    // resolve AFTER the next `avatarSpeak(question)` starts speaking,
    // producing overlapping AI audio — the next question's
    // `cancelStream()` deliberately does NOT touch the ack channel,
    // so we must abort it here. No-op in the healthy case.
    // Reported by Codex review on PR #228; see INTERVIEW_FLOW.md §8.
    ackCancelled = true
    if (ackTimer) clearTimeout(ackTimer)
    cancelAck()
    ackCountRef.current++

    evaluationsRef.current = [...evaluationsRef.current, { ...evaluation, question, answer }]
    performanceSignalRef.current = computePerformanceSignal()
    await showCoachingTip(evaluation)

    return { evaluation, concurrentResult }
  }

  /**
   * Fast-path evaluation for main (non-probe) answers.
   *
   * Uses the turn-router (~400ms) in the critical path instead of the full
   * evaluate-answer call, so TTS for the next utterance can start immediately
   * after the turn-router resolves.
   *
   * Full evaluation runs concurrently in the background; when it resolves it:
   *   - updates evaluationsRef (for session feedback)
   *   - shows the coaching tip as a non-blocking overlay (fires during TTS)
   *
   * Returns { routerResult, prefetchedQ } so the caller can branch immediately.
   */
  async function evaluateMainAnswer(
    question: string,
    answer: string,
    qIdx: number,
    nextQPromise?: Promise<string>,
    probeDepth?: number,
  ): Promise<{ routerResult: TurnRouterResult; prefetchedQ: string | null }> {
    transitionTo('PROCESSING')
    setLiveAnswer('')
    setAvatarEmotion('curious')

    // Thinking acknowledgment — same cadence as evaluateAndCoach
    let ackCancelled = false
    const shouldAck = !config?.coachMode && ackCountRef.current % 3 === 0
    const ackTimer = shouldAck
      ? setTimeout(() => {
          if (!ackCancelled) {
            const ack = THINKING_ACKS[ackCountRef.current % THINKING_ACKS.length]
            void avatarSpeak(ack, 'friendly')
          }
        }, 1500)
      : undefined

    // Critical path: turn-router + next question prefetch in parallel (~400ms)
    const [routerResult, prefetchedQ] = await Promise.all([
      apiCallTurnRouter({
        question,
        answer,
        probeDepth: probeDepth ?? 0,
        questionIndex: qIdx,
        interviewType: config?.interviewType || 'behavioral',
        signal: getAbortSignal(),
      }),
      nextQPromise ?? Promise.resolve(null),
    ])

    ackCancelled = true
    if (ackTimer) clearTimeout(ackTimer)
    ackCountRef.current++

    // Background: full evaluation (non-blocking from here on)
    // Updates evaluationsRef and shows coaching tip overlay when resolved.
    // Captured in pendingEvalRef so finishInterview can await the last eval.
    pendingEvalRef.current = evaluateAnswer(question, answer, qIdx, probeDepth)
      .then((evaluation) => {
        evaluationsRef.current = [...evaluationsRef.current, { ...evaluation, question, answer }]
        performanceSignalRef.current = computePerformanceSignal()
        // Coaching tip as non-blocking overlay — appears during TTS or while listening
        const tip = deriveCoachingTip(evaluation, config?.role, config?.interviewType, evaluation.primaryGap)
        if (tip) {
          setCoachingTip(tip)
          const dismissMs = tip.length > 100 ? 6000 : tip.length > 50 ? 4000 : 2000
          setTimeout(() => setCoachingTip((prev) => (prev === tip ? null : prev)), dismissMs)
        }
      })
      .catch(() => {
        // Push a minimal eval so session summary still has an entry
        evaluationsRef.current = [
          ...evaluationsRef.current,
          {
            questionIndex: qIdx,
            question,
            answer,
            relevance: 60,
            structure: 55,
            specificity: 55,
            ownership: 60,
            probeDecision: { shouldProbe: false },
          },
        ]
        performanceSignalRef.current = computePerformanceSignal()
      })

    return { routerResult, prefetchedQ: prefetchedQ as string | null }
  }

  // ─── Finish interview ──────────────────────────────────────────────────────

  // G.7: endReason lets each call site tell us WHY the interview ended so
  // the session row gets a durable signal of completion vs abandonment.
  // Default is 'normal' — the interview ran its course. Timer-based exits
  // pass 'time_up'. The End button (external caller in app/interview/page)
  // passes 'user_ended'. Field is additive and strictly informational; no
  // existing caller breaks.
  const finishInterview = useCallback(async (endReason: 'normal' | 'time_up' | 'user_ended' | 'usage_limit' | 'abandoned' = 'normal') => {
    // Idempotency guard: timer=0 and End button can both fire this.
    if (phaseRef.current === 'SCORING' || phaseRef.current === 'ENDED') return
    // CRITICAL: cancel everything BEFORE the state transition so any in-flight
    // avatarSpeak / question generation / coaching sleep is interrupted
    // synchronously. Without these the loop can fire one more question after
    // the user clicks End.
    interviewAbortRef.current?.abort()
    coachingAbortRef.current?.abort()
    cancelTTS() // stops streaming + buffered audio + in-flight TTS fetches
    window.speechSynthesis.cancel()
    stopListening()
    onRecordingStop?.()
    setCoachingTip(null)
    transitionTo('SCORING')

    // Wait for any in-flight background evaluation to settle so
    // evaluationsRef includes the last answer's scores.
    if (pendingEvalRef.current) {
      await Promise.race([
        pendingEvalRef.current,
        new Promise<void>((r) => setTimeout(r, 3000)),
      ])
      pendingEvalRef.current = null
    }

    const data = {
      config,
      transcript: transcriptRef.current,
      evaluations: evaluationsRef.current,
      speechMetrics: speechMetricsRef.current,
    }
    // Keep localStorage as fallback (session-scoped key when possible, plus unscoped)
    const sid = sessionIdRef.current
    const dataJson = JSON.stringify(data)
    if (sid) {
      localStorage.setItem(sessionScopedKey(STORAGE_KEYS.INTERVIEW_DATA, sid), dataJson)
    }
    localStorage.setItem(STORAGE_KEYS.INTERVIEW_DATA, dataJson)

    // Persist to DB before navigating (with 10s timeout guard — must be long enough
    // for fetchWithRetry's 3 attempts with exponential backoff: ~7s total)
    if (sid) {
      await Promise.race([
        persistSession(sid, {
          status: 'completed',
          completedAt: new Date().toISOString(),
          durationActualSeconds: config ? config.duration * 60 - timeRemainingRef.current : 0,
          transcript: transcriptRef.current,
          evaluations: evaluationsRef.current,
          speechMetrics: speechMetricsRef.current,
          // Hand Deepgram's captured words to the post-interview pipeline
          // so it can skip Whisper entirely. Empty array for Web Speech
          // API fallback users.
          liveTranscriptWords: liveWordsRef.current,
          // G.7: completion shape. `answeredCount` denormalized from the
          // evaluations array (generate-feedback could derive it, but the
          // field enables analytic queries without joining). `endReason`
          // comes from the caller so timer-based vs user-ended can be
          // distinguished downstream.
          answeredCount: evaluationsRef.current.length,
          endReason,
        }),
        new Promise((r) => setTimeout(r, 10000)),
      ])

      // Update practice stats (fire-and-forget)
      if (config) {
        const evals = evaluationsRef.current
        if (evals.length > 0) {
          const dims = ['relevance', 'structure', 'specificity', 'ownership'] as const
          const dimAvgs = dims.map(d => ({
            name: d,
            avg: evals.reduce((s, e) => s + (e[d] || 0), 0) / evals.length,
          }))
          const avgScore = Math.round(dimAvgs.reduce((s, d) => s + d.avg, 0) / dims.length)
          const sorted = [...dimAvgs].sort((a, b) => b.avg - a.avg)
          fetch('/api/learn/stats', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              domain: config.role,
              interviewType: config.interviewType || 'behavioral',
              score: avgScore,
              strongDimensions: sorted.slice(0, 2).map(d => d.name),
              weakDimensions: sorted.slice(-2).map(d => d.name),
            }),
          }).catch(() => {})
        }
      }

      // Auto-trigger AI analysis if recording exists (fire-and-forget).
      if (isMultimodalEnabled) {
        fetch('/api/analysis/start', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ sessionId: sid }),
        }).catch(() => {})
      }

      // Pre-generate feedback so it's ready when user opens feedback page.
      // Fire-and-forget — persists to session.feedback in DB. The feedback
      // page checks session.feedback on load and skips re-generation if present.
      if (config) {
        fetch('/api/generate-feedback', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            config,
            transcript: transcriptRef.current,
            evaluations: evaluationsRef.current,
            speechMetrics: speechMetricsRef.current,
            sessionId: sid,
          }),
        }).catch(() => {}) // Don't block navigation — feedback page handles missing feedback gracefully
      }

      // Clear session state — interview is complete
      localStorage.removeItem(STORAGE_KEYS.INTERVIEW_CONFIG)
      localStorage.removeItem(STORAGE_KEYS.INTERVIEW_ACTIVE_SESSION)
      router.push(`/feedback/${sid}`)
    } else {
      localStorage.removeItem(STORAGE_KEYS.INTERVIEW_CONFIG)
      localStorage.removeItem(STORAGE_KEYS.INTERVIEW_ACTIVE_SESSION)
      router.push('/feedback/local')
    }
  }, [config, router, stopListening, onRecordingStop, cancelTTS]) // eslint-disable-line react-hooks/exhaustive-deps

  // ─── Intentional silence ───────────────────────────────────────────────────

  /**
   * After an answer, briefly listen for continuation speech before moving to evaluation.
   * This catches users who pause naturally then continue elaborating — especially common
   * in system design and case study interviews where answers are long and thinking-heavy.
   *
   * Timeout varies by answer length:
   *  - Short (<15 words): always listens, 2.5s window (likely incomplete answer)
   *  - Medium (15-30 words): 35% chance, 2.0s window
   *  - Long (30+ words): always listens, 1.5s window (brief catch for trailing thoughts)
   *
   * Returns additional text if the candidate spoke, or null if silence held.
   */
  function maybeIntentionalSilence(answer: string, isProbe: boolean): Promise<string | null> {
    // Skip on probe responses, low time, or first question (intro)
    if (isProbe) return Promise.resolve(null)
    if (timeRemainingRef.current < 90) return Promise.resolve(null)
    if (questionIndexRef.current === 0) return Promise.resolve(null)
    // Skip if already in follow-up/probe flow
    if (currentProbeDepthRef.current > 0) return Promise.resolve(null)
    // Skip if candidate is struggling — don't add pressure
    if (performanceSignalRef.current === 'struggling') return Promise.resolve(null)

    const wordCount = answer.trim().split(/\s+/).length

    // Determine timeout and whether to apply silence check
    let silenceMs: number
    if (wordCount < 15) {
      // Short answers — always check, longer window
      silenceMs = 2500
    } else if (wordCount < 30) {
      // Medium answers — probabilistic (35% chance)
      if (Math.random() >= 0.35) return Promise.resolve(null)
      silenceMs = 2000
    } else {
      // Long answers — always check with a brief window to catch trailing speech
      silenceMs = 1500
    }

    // Set avatar to "curious" (waiting look)
    setAvatarEmotion('curious')

    return new Promise<string | null>((resolve) => {
      const silenceTimer = setTimeout(() => {
        stopListening()
        resolve(null)
      }, silenceMs)

      startListening((result) => {
        clearTimeout(silenceTimer)
        if (result.words?.length) {
          liveWordsRef.current.push(...result.words)
        }
        resolve(result.text.trim() || null)
      })
    })
  }

  // ─── Thread helpers ────────────────────────────────────────────────────────

  /** Decide whether to probe deeper or advance to next topic.
   *  Uses flow-aware logic when flowHints are available from generate-question. */
  function shouldProbeOrAdvance(evaluation: AnswerEvaluation): 'probe' | 'advance' {
    if (!config) return 'advance'
    const hints = flowHintsRef.current

    // Flow-aware: enforce per-slot maxProbes and phase rules
    if (hints) {
      const probe = evaluation.probeDecision
      if (!probe?.shouldProbe) return 'advance'
      if (timeRemainingRef.current < 60) return 'advance'

      // Per-slot maxProbes enforcement
      if (currentProbeDepthRef.current >= hints.maxProbes) return 'advance'

      // Warm-up phase: always advance (no probing)
      if (hints.phase === 'warm-up') return 'advance'

      // Coverage pressure: force advance when remaining must-slots are tight
      const roughTimePerTopic = 90
      const questionsRemainingByTime = Math.floor(timeRemainingRef.current / roughTimePerTopic)
      if (hints.remainingMustSlots > 0 && hints.remainingMustSlots >= questionsRemainingByTime) {
        return 'advance'
      }

      // Deep-dive phase: allow probing
      if (hints.phase === 'deep-dive') return 'probe'

      // Default: follow evaluator recommendation
      return 'probe'
    }

    // Fallback: original logic when no flow hints
    return probeOrAdvance(
      evaluation,
      timeRemainingRef.current,
      completedThreadsRef.current.length,
      config.duration,
    )
  }

  /** Build a summary for the completed thread. */
  function buildThreadSummary(topicQuestion: string): ThreadSummary {
    const thread = currentThreadRef.current
    const topicIdx = currentTopicIndexRef.current
    // Gather evaluations for this thread from evaluationsRef
    const threadEvals = evaluationsRef.current.filter(e =>
      thread.some(t => t.role === 'candidate' && t.text === e.answer)
    )
    return buildSummary(topicIdx, topicQuestion, thread, threadEvals)
  }

  /** Finalize current thread and reset for next topic. */
  function finalizeThread(topicQuestion: string) {
    if (currentThreadRef.current.length > 0) {
      completedThreadsRef.current = [
        ...completedThreadsRef.current,
        buildThreadSummary(topicQuestion),
      ]
    }
    currentThreadRef.current = []
    currentProbeDepthRef.current = 0
  }

  // ─── Main interview loop ───────────────────────────────────────────────────

  const runInterviewLoop = useCallback(
    async (startingQIndex: number) => {
      if (!config) return
      const maxQ = getQuestionCount(config.duration)
      let qIdx = startingQIndex

      try {
      while (qIdx < maxQ) {
        checkAbort()
        if (isInterviewOver()) return
        // Only skip starting a NEW question if very little time remains;
        // once a question is in progress, let the user finish answering
        if (timeRemainingRef.current < 15 && qIdx > 0) break

        // ── Generate new topic question (use prefetched if available) ──
        transitionTo('ASK_QUESTION')
        let question: string
        if (prefetchedQuestionRef.current) {
          question = await prefetchedQuestionRef.current
          prefetchedQuestionRef.current = null
        } else {
          question = await generateQuestion(qIdx)
        }
        const topicQuestion = question // Save for thread summary
        questionIndexRef.current = qIdx
        setQuestionIndex(qIdx)
        // Eagerly show the question text and log it to the transcript so
        // the user sees the UI advance immediately. With streaming TTS
        // restored (see `/api/tts/stream`), the text-to-voice gap is
        // <500ms (audio decode only) — imperceptible. Do NOT defer this
        // to `onAudioStart` to "sync" with slow audio; that hides a
        // backend regression behind a blank screen (see BUG-7 in
        // modules/interview/docs/INTERVIEW_FLOW.md §8).
        setCurrentQuestion(question)
        addToTranscript('interviewer', question, qIdx)

        // Track in current thread
        currentThreadRef.current = [{
          role: 'interviewer', text: question, isProbe: false, probeDepth: 0,
        }]
        currentProbeDepthRef.current = 0

        // Avatar speaks the question (with occasional filler for realism — T1)
        checkAbort()
        const emotion: AvatarEmotion =
          qIdx === 0 ? 'friendly' : qIdx % 3 === 0 ? 'curious' : 'neutral'
        // After Q2, occasionally prepend a natural transition filler (~40% chance)
        // to avoid the robotic "question, question, question" cadence.
        // Filler is prepended to question text as a single TTS call to avoid
        // double network roundtrip delay.
        let spokenQuestion = question
        if (qIdx >= 2 && Math.random() < 0.4) {
          const filler = pickRandom(PRE_QUESTION_FILLERS)
          spokenQuestion = `${filler} ${question}`
        }
        warmUpListening?.()
        await avatarSpeak(spokenQuestion, emotion)
        // BUG 1 fix: re-check after the long avatarSpeak await — user may have
        // ended the interview while TTS was playing.
        if (isInterviewOver()) return

        // ── Conversational listen loop ──
        // Classifies candidate intent before processing. Handles: clarifications,
        // redirects, thinking pauses, distress, corrections, repetitions,
        // time checks, hint requests, proactive questions, and "I don't know".
        checkAbort()
        setLiveAnswer('')
        let answer = ''
        let conversationTurns = 0
        let dontKnowAttempts = 0
        const MAX_CONVERSATION_TURNS = 5 // raised from 3 to accommodate non-answer intents

        while (conversationTurns <= MAX_CONVERSATION_TURNS) {
          setLiveAnswer('') // Fresh slate each iteration — prevents stale text from prior turns
          const speech = await listenForAnswer(true, 30000, () => transitionTo('LISTENING'))
          if (isInterviewOver()) return

          if (!speech) {
            // If in thinking pause, candidate went silent — give them more time
            // with a gentle check-in (up to 90s total, then advance)
            if (isThinkingPauseRef.current) {
              isThinkingPauseRef.current = false
              // They were thinking but went silent — treat as ready to move on
            }

            if (conversationTurns === 0) {
              // First attempt empty — nudge candidate.
              // BUG 4 fix: only fire the "take your time" nudge once per
              // 2 minutes per session. Reported issue: after 3 successful
              // answers, hearing "take your time" again felt patronizing
              // and out-of-context. Skip the spoken nudge if we recently
              // fired one — just bump the counter and silently keep listening.
              const NUDGE_COOLDOWN_MS = 120_000
              if (Date.now() - lastTakeYourTimeRef.current > NUDGE_COOLDOWN_MS) {
                checkAbort()
                const retryPrompt = "Take your time — whenever you're ready, I'd love to hear your thoughts on this."
                addToTranscript('interviewer', retryPrompt, qIdx)
                warmUpListening?.()
                await avatarSpeak(retryPrompt, 'friendly')
                lastTakeYourTimeRef.current = Date.now()
              }
              conversationTurns++
              continue
            }
            // Still empty after conversation — skip
            const skipMsg = "No problem — let's move on to the next question."
            addToTranscript('interviewer', skipMsg, qIdx)
            await avatarSpeak(skipMsg, 'friendly')
            break
          }

          const intent = classifyIntent(speech)

          if (intent === 'answer') {
            // Check for "I don't know" pattern (E3)
            const dontKnowPattern = /^(i don'?t know|i('m| am) not sure|no idea|i haven'?t (thought about|considered)|i (really )?don'?t know)/i
            if (dontKnowPattern.test(speech.trim()) && speech.trim().length < 60) {
              dontKnowAttempts++
              addToTranscript('candidate', speech, qIdx)

              if (dontKnowAttempts === 1) {
                // First "I don't know" — probe for partial knowledge
                const probe = pickRandom(CONVERSATION_RESPONSES.dontKnow.probe)
                addToTranscript('interviewer', probe, qIdx)
                warmUpListening?.()
                await avatarSpeak(probe, 'friendly')
                conversationTurns++
                continue
              }
              // Second "I don't know" — advance gracefully
              const advance = pickRandom(CONVERSATION_RESPONSES.dontKnow.advance)
              addToTranscript('interviewer', advance, qIdx)
              await avatarSpeak(advance, 'friendly')
              break
            }

            isThinkingPauseRef.current = false
            answer = speech
            break
          }

          // Non-answer intents: distress, correction, repetition don't count as conversation turns
          addToTranscript('candidate', speech, qIdx)

          if (intent === 'distress') {
            // (I5, E6) — Emotional support, don't count as turn, enter thinking pause
            const comfort = pickRandom(CONVERSATION_RESPONSES.distress)
            addToTranscript('interviewer', comfort, qIdx)
            isThinkingPauseRef.current = true
            setLiveAnswer('') // Clear stale answer text so fresh listening starts clean
            warmUpListening?.()
            await avatarSpeak(comfort, 'friendly')
            // Don't increment conversationTurns — distress doesn't count
            continue
          }

          if (intent === 'correction') {
            // (I4) — Let candidate restart, clear live answer, don't re-ask
            const reply = pickRandom(CONVERSATION_RESPONSES.correction)
            addToTranscript('interviewer', reply, qIdx)
            setLiveAnswer('')
            warmUpListening?.()
            await avatarSpeak(reply, 'friendly')
            // Don't increment conversationTurns — correction doesn't count
            continue
          }

          if (intent === 'repetition') {
            // (E5) — Re-read the question with a natural prefix
            const prefix = pickRandom(CONVERSATION_RESPONSES.repetition)
            const fullRepeat = prefix + ' ' + question
            addToTranscript('interviewer', fullRepeat, qIdx)
            warmUpListening?.()
            await avatarSpeak(fullRepeat, 'friendly')
            // Don't increment conversationTurns
            continue
          }

          if (intent === 'timecheck') {
            // (TM3) — Report remaining time in character
            const minutesLeft = Math.floor(timeRemainingRef.current / 60)
            const isStrong = performanceSignalRef.current === 'strong'
            const timeMsg = CONVERSATION_RESPONSES.timecheck(minutesLeft, isStrong)
            addToTranscript('interviewer', timeMsg, qIdx)
            warmUpListening?.()
            await avatarSpeak(timeMsg, 'friendly')
            // Don't increment conversationTurns
            continue
          }

          if (intent === 'hint') {
            // (E2) — Provide light scaffold hint based on interview type
            const interviewType = config?.interviewType || 'screening'
            const hintKey = (interviewType in CONVERSATION_RESPONSES.hint ? interviewType : 'screening') as keyof typeof CONVERSATION_RESPONSES.hint
            const hintMsg = CONVERSATION_RESPONSES.hint[hintKey]
            addToTranscript('interviewer', hintMsg, qIdx)
            warmUpListening?.()
            await avatarSpeak(hintMsg, 'friendly')
            conversationTurns++
            continue
          }

          if (intent === 'challenge_question') {
            // (E4) — Candidate pushes back on the question. Respond professionally, reframe.
            const reframe = pickRandom(CONVERSATION_RESPONSES.challenge_question) + ' ' + simplifyQuestion(question)
            addToTranscript('interviewer', reframe, qIdx)
            warmUpListening?.()
            await avatarSpeak(reframe, 'friendly')
            // Don't increment conversationTurns — challenge doesn't count
            continue
          }

          if (intent === 'gaming') {
            // (E8) — Candidate tries to extract the answer. Stay in character.
            const deflect = pickRandom(CONVERSATION_RESPONSES.gaming)
            addToTranscript('interviewer', deflect, qIdx)
            warmUpListening?.()
            await avatarSpeak(deflect, 'neutral')
            // Don't increment conversationTurns
            continue
          }

          if (intent === 'skip') {
            // Candidate wants to skip this question — move on gracefully
            const skipMsg = "No problem at all — let's move on to the next one."
            addToTranscript('interviewer', skipMsg, qIdx)
            await avatarSpeak(skipMsg, 'friendly')
            break
          }

          conversationTurns++

          if (intent === 'clarification') {
            const rephrase = pickRandom(CONVERSATION_RESPONSES.clarification) + ' ' + simplifyQuestion(question)
            addToTranscript('interviewer', rephrase, qIdx)
            warmUpListening?.()
            await avatarSpeak(rephrase, 'friendly')
            continue
          }

          if (intent === 'redirect') {
            const redirectReply = pickRandom(CONVERSATION_RESPONSES.redirect)
            addToTranscript('interviewer', redirectReply, qIdx)
            warmUpListening?.()
            await avatarSpeak(redirectReply, 'friendly')
            continue
          }

          if (intent === 'thinking') {
            // (TM1) — Enter thinking pause mode
            const thinkReply = pickRandom(CONVERSATION_RESPONSES.thinking)
            addToTranscript('interviewer', thinkReply, qIdx)
            isThinkingPauseRef.current = true
            warmUpListening?.()
            await avatarSpeak(thinkReply, 'friendly')
            continue
          }

          if (intent === 'question') {
            // Proactive candidate question — AI answers in character
            clarifyingQCountRef.current++
            try {
              const aiAnswer = await completion({
                taskSlot: 'interview.answer-candidate-question',
                system: 'You are Alex Chen, an interviewer. The candidate asked a clarifying question. Give a brief, helpful answer (1-2 sentences). Stay in character. Then naturally guide back to the original question.',
                messages: [{ role: 'user', content: `Interview question: "${question}"\nCandidate asks: "${speech}"` }],
              })
              addToTranscript('interviewer', aiAnswer.text, qIdx)
              warmUpListening?.()
              await avatarSpeak(aiAnswer.text, 'friendly')
            } catch {
              // Fallback if LLM call fails
              const fallback = "Great question! For the purposes of this interview, let's assume a standard scenario. Now, back to my question —"
              addToTranscript('interviewer', fallback, qIdx)
              warmUpListening?.()
              await avatarSpeak(fallback, 'friendly')
            }
            continue
          }
        }

        if (isInterviewOver()) return
        isThinkingPauseRef.current = false

        if (!answer) {
          // No answer after conversation loop — skip to next question
          finalizeThread(topicQuestion)
          currentTopicIndexRef.current++
          qIdx++
          continue
        }

        // ── Intentional silence: give short answers a chance to elaborate ──
        let finalAnswer = answer
        const silenceElaboration = await maybeIntentionalSilence(answer, false)
        if (silenceElaboration) {
          finalAnswer = `${answer} ${silenceElaboration}`
        }

        addToTranscript('candidate', finalAnswer, qIdx)
        currentThreadRef.current.push({
          role: 'candidate', text: finalAnswer, isProbe: false, probeDepth: 0,
        })

        // ── Fast routing: turn-router + next question prefetch in parallel (~400ms) ──
        // Full evaluation runs concurrently in the background (see evaluateMainAnswer).
        // Coaching tip overlay fires when the bg eval resolves — non-blocking.
        checkAbort()
        const nextQIdx = qIdx + 1
        const shouldPrefetch = nextQIdx < maxQ && timeRemainingRef.current > 60
        // Build a snapshot that includes the current (not-yet-finalized) thread so
        // the next question's deduplication prompt sees ALL topics including this one.
        // Without this, completedThreadsRef is stale — missing the current topic —
        // causing repeated questions (Bug #2).
        const threadsSnapshot = shouldPrefetch
          ? [...completedThreadsRef.current, buildThreadSummary(topicQuestion)]
          : undefined
        const nextQuestionPromise = shouldPrefetch ? generateQuestion(nextQIdx, threadsSnapshot) : undefined
        const { routerResult, prefetchedQ } = await evaluateMainAnswer(
          question, finalAnswer, qIdx, nextQuestionPromise, currentProbeDepthRef.current,
        )
        if (prefetchedQ) {
          prefetchedQuestionRef.current = Promise.resolve(prefetchedQ)
          prefetchTTS(prefetchedQ)
        }

        // Pre-fetch TTS for probe question the moment the router decides to probe
        if (routerResult.nextAction === 'probe' && routerResult.probeQuestion) {
          prefetchTTS(routerResult.probeQuestion)
        }

        // ── E7: Nonsensical/joke answer — re-ask without breaking character ──
        if (routerResult.isNonsensical && currentProbeDepthRef.current === 0) {
          const reaskMsg = "I want to make sure I understand you correctly. Could you walk me through that more seriously?"
          addToTranscript('interviewer', reaskMsg, qIdx)
          warmUpListening?.()
          await avatarSpeak(reaskMsg, 'neutral')

          setLiveAnswer('')
          const retryAnswer = await listenForAnswer(true, 30000, () => transitionTo('LISTENING'))
          if (isInterviewOver()) return
          if (retryAnswer) {
            addToTranscript('candidate', retryAnswer, qIdx)
            currentThreadRef.current.push({
              role: 'candidate', text: retryAnswer, isProbe: true,
              probeDepth: 1,
            })
            currentProbeDepthRef.current++
            // Full eval for the retry — blocks but this is an edge case
            await evaluateAndCoach(question, retryAnswer, qIdx, undefined, 1)
          }
        }

        // ── P6: Pivot re-anchoring — if candidate dodged the question, re-ask ──
        // Use re-anchor question from router (it detects topic drift) or generate one.
        if (routerResult.isPivot && currentProbeDepthRef.current === 0 && timeRemainingRef.current >= 60) {
          const reAnchorQ = routerResult.probeQuestion
            || `Let me bring us back to the original question. ${question}`
          currentProbeDepthRef.current++
          qIdx++
          currentThreadRef.current.push({
            role: 'interviewer', text: reAnchorQ, isProbe: true,
            probeType: 'clarify', probeDepth: currentProbeDepthRef.current,
          })
          checkAbort()
          transitionTo('ASK_QUESTION')
          questionIndexRef.current = qIdx
          setQuestionIndex(qIdx)
          warmUpListening?.()
          // BUG-7 fix: defer text + transcript until audio starts
          await avatarSpeak(reAnchorQ, 'curious', () => {
            setCurrentQuestion(reAnchorQ)
            addToTranscript('interviewer', reAnchorQ, qIdx)
          })

          setLiveAnswer('')
          const pivotAnswer = await listenForAnswer(true, 30000, () => transitionTo('LISTENING'))
          if (isInterviewOver()) return

          if (pivotAnswer) {
            addToTranscript('candidate', pivotAnswer, qIdx)
            currentThreadRef.current.push({
              role: 'candidate', text: pivotAnswer, isProbe: true,
              probeDepth: currentProbeDepthRef.current,
            })
            await evaluateAndCoach(reAnchorQ, pivotAnswer, qIdx, undefined, currentProbeDepthRef.current)
          }
        }

        // ── Probe loop ──
        // First probe decision comes from the turn-router (routerResult.nextAction).
        // Subsequent probe decisions come from the full evaluation inside evaluateAndCoach.
        // Probe limits vary by interview type: case studies go deeper, screening stays shallow.
        const probeLimit: Record<string, number> = {
          'case-study': 5,
          technical: 3,
          behavioral: 2,
          screening: 2,
        }
        // Flow-aware: use per-slot maxProbes when available, fall back to type-based limit
        const flowMaxProbes = flowHintsRef.current?.maxProbes
        const MAX_PROBES_PER_TOPIC = flowMaxProbes ?? probeLimit[config?.interviewType || 'screening'] ?? 2

        // First-level probe: driven by turn-router (TTS can start as soon as router returns)
        let nextProbeAction: 'probe' | 'advance' = routerResult.nextAction
        let nextProbeQ: string | undefined = routerResult.probeQuestion
        let nextProbeType: ProbeType | undefined = routerResult.style === 'probing' ? 'challenge' : 'expand'

        while (nextProbeAction === 'probe' && nextProbeQ && currentProbeDepthRef.current < MAX_PROBES_PER_TOPIC) {
          if (isInterviewOver()) return

          const probeQ = nextProbeQ
          const probeType = nextProbeType
          currentProbeDepthRef.current++
          qIdx++

          currentThreadRef.current.push({
            role: 'interviewer', text: probeQ, isProbe: true,
            probeType, probeDepth: currentProbeDepthRef.current,
          })

          // Ask probe — BUG-7 fix: defer text + transcript until audio starts
          checkAbort()
          transitionTo('ASK_QUESTION')
          questionIndexRef.current = qIdx
          setQuestionIndex(qIdx)
          warmUpListening?.()
          await avatarSpeak(probeQ, routerResult.style !== 'neutral' ? toneToEmotion(routerResult.style) : 'curious', () => {
            setCurrentQuestion(probeQ)
            addToTranscript('interviewer', probeQ, qIdx)
          })

          // Listen for probe answer
          checkAbort()
          setLiveAnswer('')
          const probeAnswer = await listenForAnswer(true, 30000, () => transitionTo('LISTENING'))

          if (isInterviewOver()) return

          if (!probeAnswer) {
            transitionTo('PROCESSING')
            setLiveAnswer('')
            break
          }

          addToTranscript('candidate', probeAnswer, qIdx)
          currentThreadRef.current.push({
            role: 'candidate', text: probeAnswer, isProbe: true,
            probeType, probeDepth: currentProbeDepthRef.current,
          })

          // Full evaluation for probe answer (30s listen window already covered it)
          const { evaluation: probeEval } = await evaluateAndCoach(
            probeQ, probeAnswer, qIdx, undefined, currentProbeDepthRef.current,
          )

          // Next probe decision comes from the full eval (not turn-router)
          nextProbeAction = shouldProbeOrAdvance(probeEval)
          nextProbeQ = buildProbeQuestion(
            probeEval.probeDecision?.probeType,
            probeEval.probeDecision?.probeTarget,
          )
          nextProbeType = probeEval.probeDecision?.probeType ?? 'expand'
        }

        // ── Finalize thread, advance to next topic ──
        finalizeThread(topicQuestion)
        currentTopicIndexRef.current++

        // Avatar emotion: use the last eval in the ref (bg eval has resolved by now
        // since probe loop / TTS playback covered the 2-3s eval window).
        const lastEval = evaluationsRef.current[evaluationsRef.current.length - 1]
        const responseEmotion: AvatarEmotion = (() => {
          if (!lastEval) return 'friendly'
          const avg = (lastEval.relevance + lastEval.structure + lastEval.specificity + lastEval.ownership) / 4
          return avg >= 75 ? 'impressed' : avg >= 55 ? 'friendly' : 'curious'
        })()
        setAvatarEmotion(responseEmotion)

        qIdx++

        // ── Surface a deferred topic if the candidate interrupted earlier ──
        // Max 2 per interview, only when enough time remains.
        if (deferredTopicsRef.current.length > 0 && timeRemainingRef.current > 90 && qIdx < maxQ) {
          const deferredTopic = deferredTopicsRef.current.shift()!
          const bridgeMsg = `Earlier you mentioned something interesting — "${deferredTopic}". I'd love to hear more about that.`
          checkAbort()
          addToTranscript('interviewer', bridgeMsg, qIdx)
          setCurrentQuestion(bridgeMsg)
          warmUpListening?.()
          await avatarSpeak(bridgeMsg, 'curious')
          if (isInterviewOver()) return

          setLiveAnswer('')
          const deferredAnswer = await listenForAnswer(true, 30000, () => transitionTo('LISTENING'))
          if (isInterviewOver()) return
          if (deferredAnswer) {
            addToTranscript('candidate', deferredAnswer, qIdx)
            await evaluateAndCoach(bridgeMsg, deferredAnswer, qIdx, undefined, 0)
          }
          qIdx++
        }
      }

      // ── Surface remaining deferred topics during wrap-up ──
      if (deferredTopicsRef.current.length > 0) {
        checkAbort()
        if (!isInterviewOver()) {
          const remaining = deferredTopicsRef.current.splice(0, 2)
          for (const topic of remaining) {
            const followUp = `Before we wrap up — you raised an interesting point earlier about "${topic}". Can you tell me more?`
            addToTranscript('interviewer', followUp)
            warmUpListening?.()
            await avatarSpeak(followUp, 'curious')
            if (isInterviewOver()) break

            setLiveAnswer('')
            const topicAnswer = await listenForAnswer(true, 30000, () => transitionTo('LISTENING'))
            if (isInterviewOver()) break
            if (topicAnswer) {
              addToTranscript('candidate', topicAnswer)
            }
          }
        }
      }

      // Wrap-up — listen for user questions and respond
      checkAbort()
      if (isInterviewOver()) return
      transitionTo('WRAP_UP')
      addToTranscript('interviewer', WRAP_UP_LINE)
      await avatarSpeak(WRAP_UP_LINE, 'friendly')

      // Listen for user's wrap-up questions (15s timeout)
      setLiveAnswer('')
      const wrapUpAnswer = await listenForAnswer(true, 15000, () => transitionTo('LISTENING'))

      if (wrapUpAnswer && wrapUpAnswer.trim().length > 5) {
        addToTranscript('candidate', wrapUpAnswer)
        // Generate a brief closing response
        checkAbort()
        const closingLine = "That's a great question! I appreciate your curiosity. We'll be in touch with next steps. Thank you so much for your time today — it was a pleasure speaking with you!"
        addToTranscript('interviewer', closingLine)
        await avatarSpeak(closingLine, 'friendly')
      } else {
        // No questions — graceful close
        const noQuestionsClose = "No worries at all! Thank you so much for your time today — it was a pleasure speaking with you. We'll be in touch!"
        addToTranscript('interviewer', noQuestionsClose)
        await avatarSpeak(noQuestionsClose, 'friendly')
      }

      finishInterview()
      } catch (err) {
        // Silently catch abort errors — interview was intentionally ended
        if (err instanceof InterviewAbortError || (err instanceof DOMException && err.name === 'AbortError')) return
        throw err
      }
    },
    [config, generateQuestion, avatarSpeak, startListening, evaluateAnswer, addToTranscript, finishInterview] // eslint-disable-line react-hooks/exhaustive-deps
  )

  // ─── Start interview when config + voices ready ────────────────────────────

  useEffect(() => {
    if (!config || !voicesReady) return

    interviewAbortRef.current = new AbortController()

    const start = async () => {
      try {
      if (usageLimitReachedRef.current) return

      // ── Coding interview: special flow ──
      if (config.interviewType === 'coding' && currentProblemRef.current) {
        const problem = currentProblemRef.current
        const codingIntro = `Hi! I'm Alex, and today we'll work through a coding challenge together. I'll present you with a problem, and you can write your solution in the code editor on the right. Feel free to think out loud as you work — I'm interested in your approach as much as the final code. Let's get started!`
        setCurrentQuestion(codingIntro)
        addToTranscript('interviewer', codingIntro, 0)
        checkAbort()
        await avatarSpeak(codingIntro, 'friendly')

        checkAbort()

        // Present the problem
        const problemText = `Here's your problem: "${problem.title}". Take a look at the full description on the left panel. When you're ready, start coding and click Submit when done.`
        transitionTo('ASK_QUESTION')
        questionIndexRef.current = 1
        setQuestionIndex(1)
        setCurrentQuestion(problemText)
        addToTranscript('interviewer', problemText, 1)
        await avatarSpeak(problemText, 'curious')

        checkAbort()

        // Transition to CODE_EDITING — user codes
        transitionTo('CODE_EDITING')
        setLiveAnswer('')

        // Wait for code submission
        const submission = await waitForCodeSubmission()

        if (isInterviewOver()) return
        checkAbort()

        // Evaluate the code
        transitionTo('PROCESSING')
        addToTranscript('candidate', `[Code submitted in ${submission.language}]`, 1)

        let feedbackText = 'Good effort! Let me share some thoughts.'
        try {
          const evalRes = await fetch('/api/evaluate-code', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              code: submission.code,
              language: submission.language,
              problemTitle: problem.title,
              problemDescription: problem.description,
              questionIndex: 1,
              sessionId: sessionIdRef.current,
            }),
          })
          if (evalRes.ok) {
            const evaluation = await evalRes.json()
            feedbackText = evaluation.feedback || feedbackText
            const avgScore = ((evaluation.correctness || 0) + (evaluation.efficiency || 0) + (evaluation.code_quality || 0)) / 3
            setAvatarEmotion(avgScore >= 70 ? 'impressed' : avgScore >= 40 ? 'friendly' : 'curious')
          }
        } catch { /* continue with default feedback */ }

        checkAbort()

        // Show feedback
        transitionTo('COACHING')
        setCoachingTip(feedbackText)
        setCurrentQuestion(feedbackText)
        addToTranscript('interviewer', feedbackText, 1)
        await avatarSpeak(feedbackText, avatarEmotion)

        await new Promise<void>((r) => setTimeout(r, 2000))
        checkAbort()

        // Follow-up: ask about approach
        if (timeRemainingRef.current > 60) {
          const followUp = `Can you walk me through your approach? What data structures did you use, and what's the time complexity of your solution?`
          transitionTo('ASK_QUESTION')
          questionIndexRef.current = 2
          setQuestionIndex(2)
          setCurrentQuestion(followUp)
          addToTranscript('interviewer', followUp, 2)
          warmUpListening?.()
          await avatarSpeak(followUp, 'curious')

          checkAbort()
          setLiveAnswer('')
          const answer = await listenForAnswer(true, 30000, () => transitionTo('LISTENING'))

          if (answer && !isInterviewOver()) {
            addToTranscript('candidate', answer, 2)
            await evaluateAndCoach(followUp, answer, 2, undefined, 0)
          }
        }

        // Wrap up — listen for user questions
        if (!isInterviewOver()) {
          transitionTo('WRAP_UP')
          addToTranscript('interviewer', WRAP_UP_LINE)
          await avatarSpeak(WRAP_UP_LINE, 'friendly')

          setLiveAnswer('')
          const codingWrapUpAnswer = await listenForAnswer(true, 15000, () => transitionTo('LISTENING'))

          if (codingWrapUpAnswer && codingWrapUpAnswer.trim().length > 5) {
            addToTranscript('candidate', codingWrapUpAnswer)
            const closingLine = "That's a great question! I appreciate your curiosity. We'll be in touch with next steps. Thank you so much for your time today — it was a pleasure speaking with you!"
            addToTranscript('interviewer', closingLine)
            await avatarSpeak(closingLine, 'friendly')
          } else {
            const noQuestionsClose = "No worries at all! Thank you so much for your time today — it was a pleasure speaking with you. We'll be in touch!"
            addToTranscript('interviewer', noQuestionsClose)
            await avatarSpeak(noQuestionsClose, 'friendly')
          }

          finishInterview()
        }
        return
      }

      // ── System design interview: special flow ──
      if (config.interviewType === 'system-design' && currentDesignProblemRef.current) {
        const problem = currentDesignProblemRef.current
        const designIntro = `Hi! I'm Alex, and today we'll work through a system design challenge together. I'll present you with a problem, and you can build your architecture diagram using the design canvas on the right. Feel free to think out loud as you design — I'm interested in your reasoning and trade-off analysis as much as the final architecture. Let's get started!`
        setCurrentQuestion(designIntro)
        addToTranscript('interviewer', designIntro, 0)
        checkAbort()
        await avatarSpeak(designIntro, 'friendly')

        checkAbort()

        // Present the problem
        const requirementsList = problem.requirements.map((r: string) => `• ${r}`).join('\n')
        const problemText = `Here's your challenge: "${problem.title}". Take a look at the full description and requirements on the left panel. Use the component palette to build your architecture — drag components onto the canvas and use Connect mode to draw relationships between them. Click Submit when you're ready for my review.`
        transitionTo('ASK_QUESTION')
        questionIndexRef.current = 1
        setQuestionIndex(1)
        setCurrentQuestion(problemText)
        addToTranscript('interviewer', problemText, 1)
        await avatarSpeak(problemText, 'curious')

        checkAbort()

        // Transition to DESIGN_CANVAS — user designs
        transitionTo('DESIGN_CANVAS')
        setLiveAnswer('')

        // Wait for design submission
        const submission = await waitForDesignSubmission()

        if (isInterviewOver()) return
        checkAbort()

        // Evaluate the design
        transitionTo('PROCESSING')
        addToTranscript('candidate', `[Design submitted: ${submission.components.length} components, ${submission.connections.length} connections]`, 1)

        let feedbackText = 'Interesting design! Let me share some thoughts.'
        try {
          const evalRes = await fetch('/api/evaluate-design', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              components: submission.components,
              connections: submission.connections,
              problemTitle: problem.title,
              problemDescription: problem.description,
              requirements: problem.requirements,
              questionIndex: 1,
              sessionId: sessionIdRef.current,
            }),
          })
          if (evalRes.ok) {
            const evaluation = await evalRes.json()
            feedbackText = evaluation.feedback || feedbackText
            const avgScore = ((evaluation.architecture || 0) + (evaluation.scalability || 0) + (evaluation.requirements_clarity || 0)) / 3
            setAvatarEmotion(avgScore >= 70 ? 'impressed' : avgScore >= 40 ? 'friendly' : 'curious')

            // Add follow-up question if provided
            if (evaluation.follow_up_question) {
              feedbackText += ` ${evaluation.follow_up_question}`
            }
          }
        } catch { /* continue with default feedback */ }

        checkAbort()

        // Show feedback
        transitionTo('COACHING')
        setCoachingTip(feedbackText)
        setCurrentQuestion(feedbackText)
        addToTranscript('interviewer', feedbackText, 1)
        await avatarSpeak(feedbackText, avatarEmotion)

        await new Promise<void>((r) => setTimeout(r, 2000))
        checkAbort()

        // Follow-up: ask about design decisions
        if (timeRemainingRef.current > 60) {
          const followUp = `Can you walk me through the key design decisions you made? Specifically, how would your system handle a 10x increase in traffic, and what are the potential bottlenecks?`
          transitionTo('ASK_QUESTION')
          questionIndexRef.current = 2
          setQuestionIndex(2)
          setCurrentQuestion(followUp)
          addToTranscript('interviewer', followUp, 2)
          warmUpListening?.()
          await avatarSpeak(followUp, 'curious')

          checkAbort()
          setLiveAnswer('')
          const answer = await listenForAnswer(true, 30000, () => transitionTo('LISTENING'))

          if (answer && !isInterviewOver()) {
            addToTranscript('candidate', answer, 2)
            await evaluateAndCoach(followUp, answer, 2, undefined, 0)
          }
        }

        // Second follow-up on trade-offs if time allows
        if (timeRemainingRef.current > 60 && !isInterviewOver()) {
          const tradeOffQ = `What trade-offs did you consider in your design? For example, consistency vs availability, or latency vs throughput. What would you change if you had different constraints?`
          transitionTo('ASK_QUESTION')
          questionIndexRef.current = 3
          setQuestionIndex(3)
          setCurrentQuestion(tradeOffQ)
          addToTranscript('interviewer', tradeOffQ, 3)
          warmUpListening?.()
          await avatarSpeak(tradeOffQ, 'skeptical')

          checkAbort()
          setLiveAnswer('')
          const answer2 = await listenForAnswer(true, 30000, () => transitionTo('LISTENING'))

          if (answer2 && !isInterviewOver()) {
            addToTranscript('candidate', answer2, 3)
            await evaluateAndCoach(tradeOffQ, answer2, 3, undefined, 0)
          }
        }

        // Wrap up — listen for user questions
        if (!isInterviewOver()) {
          transitionTo('WRAP_UP')
          addToTranscript('interviewer', WRAP_UP_LINE)
          await avatarSpeak(WRAP_UP_LINE, 'friendly')

          setLiveAnswer('')
          const designWrapUpAnswer = await listenForAnswer(true, 15000, () => transitionTo('LISTENING'))

          if (designWrapUpAnswer && designWrapUpAnswer.trim().length > 5) {
            addToTranscript('candidate', designWrapUpAnswer)
            const closingLine = "That's a great question! I appreciate your curiosity. We'll be in touch with next steps. Thank you so much for your time today — it was a pleasure speaking with you!"
            addToTranscript('interviewer', closingLine)
            await avatarSpeak(closingLine, 'friendly')
          } else {
            const noQuestionsClose = "No worries at all! Thank you so much for your time today — it was a pleasure speaking with you. We'll be in touch!"
            addToTranscript('interviewer', noQuestionsClose)
            await avatarSpeak(noQuestionsClose, 'friendly')
          }

          finishInterview()
        }
        return
      }

      // ── Standard interview flow ──
      const intro = getInterviewIntro(config.role, config.interviewType, config.targetCompany)
      setCurrentQuestion(intro)
      addToTranscript('interviewer', intro, 0)
      checkAbort()

      // Start intro speech IMMEDIATELY — do NOT block on session creation.
      // The intro takes 3-8 seconds, which gives createDbSession (including
      // the Document Intelligence Layer's LLM parsing) time to finish in
      // the background. We await it AFTER starting speech but BEFORE Q1
      // generation, so sessionId is available for structured resume context.
      warmUpListening?.()
      const introSpeechPromise = avatarSpeak(intro, 'friendly')

      // While the intro plays, wait for session creation to complete.
      // This ensures sessionId is available for the Document Intelligence
      // Layer (structured resume/JD parsing) when Q1 fires. See Issue #5.
      if (sessionCreationPromiseRef.current) {
        await sessionCreationPromiseRef.current
      }

      // Start prefetching Q1 + its TTS in parallel with remaining intro speech
      const q1Promise = generateQuestion(1)
      q1Promise.then((q) => prefetchTTS(q)).catch(() => {})
      prefetchedQuestionRef.current = q1Promise

      // Wait for intro speech to finish before continuing
      await introSpeechPromise

      // Listen for the candidate's response to the intro ("tell me about yourself")
      checkAbort()
      setLiveAnswer('')
      questionIndexRef.current = 0
      setQuestionIndex(0)

      // Track intro as thread
      currentThreadRef.current = [
        { role: 'interviewer', text: intro, isProbe: false, probeDepth: 0 },
      ]

      const introAnswer = await listenForAnswer(true, 30000, () => transitionTo('LISTENING'))

      if (isInterviewOver()) return

      if (introAnswer) {
        addToTranscript('candidate', introAnswer, 0)
        currentThreadRef.current.push(
          { role: 'candidate', text: introAnswer, isProbe: false, probeDepth: 0 },
        )
        await evaluateAndCoach(intro, introAnswer, 0, undefined, 0)
      }

      // Finalize intro thread
      finalizeThread(intro)
      currentTopicIndexRef.current++

      // Continue with AI-generated questions starting from index 1
      checkAbort()
      runInterviewLoop(1)
      } catch (err) {
        if (err instanceof InterviewAbortError || (err instanceof DOMException && err.name === 'AbortError')) return
        throw err
      }
    }

    // Brief delay to let React render settle before starting the interview flow
    const t = setTimeout(start, 200)
    return () => clearTimeout(t)
  }, [config, voicesReady]) // eslint-disable-line react-hooks/exhaustive-deps

  return {
    phase,
    questionIndex,
    currentQuestion,
    avatarEmotion,
    isAvatarTalking,
    timeRemaining,
    liveAnswer,
    sessionId: sessionIdRef.current,
    coachingTip,
    finishInterview,
    onCodeSubmit,
    onDesignSubmit,
  }
}
