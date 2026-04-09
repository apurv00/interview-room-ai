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
  PushbackTone,
  ThreadEntry,
  ThreadSummary,
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
import {
  computePerformanceSignal as computeSignal,
  shouldProbeOrAdvance as probeOrAdvance,
  buildThreadSummary as buildSummary,
  toneToEmotion,
} from './interviewUtils'
import { useAvatarSpeech } from './useAvatarSpeech'
import { useInterviewAPI } from './useInterviewAPI'
import { createDbSession, persistSession } from './interviewPersistence'

// ─── Hook options ─────────────────────────────────────────────────────────────

interface UseInterviewOptions {
  config: InterviewConfig | null
  voicesReady: boolean
  startListening: (onComplete: (result: SpeechRecognitionResult) => void, options?: StartListeningOptions) => void
  stopListening: () => void
  /** Pre-warm STT WebSocket so startListening is instant. */
  warmUpListening?: () => void
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
  finishInterview: () => void
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
  const { avatarEmotion, isAvatarTalking, setAvatarEmotion, avatarSpeak, prefetchTTS } = useAvatarSpeech({
    interviewType: config?.interviewType,
    isMultimodalEnabled,
  })

  // ── API calls (extracted to useInterviewAPI) ──
  const { generateQuestion: apiGenerateQuestion, evaluateAnswer: apiEvaluateAnswer } = useInterviewAPI({ config })

  // ── Interview content ──
  const [currentQuestion, setCurrentQuestion] = useState('')
  const [questionIndex, setQuestionIndex] = useState(0)
  const questionIndexRef = useRef(0)
  const transcriptRef = useRef<TranscriptEntry[]>([])
  const evaluationsRef = useRef<AnswerEvaluation[]>([])
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

  // ── Timer ──
  const [timeRemaining, setTimeRemaining] = useState(0)
  const timeRemainingRef = useRef(0)

  // ── DB session ──
  const sessionIdRef = useRef<string | null>(null)
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
    createDbSession(config).then((result) => {
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

  // ─── Timer countdown ───────────────────────────────────────────────────────

  useEffect(() => {
    if (!config) return
    const tick = setInterval(() => {
      setTimeRemaining((t) => {
        const next = Math.max(0, t - 1)
        timeRemainingRef.current = next
        if (next === 0 && phaseRef.current !== 'SCORING' && phaseRef.current !== 'ENDED') {
          finishInterview()
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
    (qIdx: number): Promise<string> =>
      apiGenerateQuestion(
        qIdx,
        transcriptRef.current,
        performanceSignalRef.current,
        completedThreadsRef.current,
        getAbortSignal(),
      ),
    [apiGenerateQuestion]
  )

  const evaluateAnswer = useCallback(
    (question: string, answer: string, qIdx: number, probeDepth?: number): Promise<AnswerEvaluation> =>
      apiEvaluateAnswer(question, answer, qIdx, probeDepth, getAbortSignal()),
    [apiEvaluateAnswer]
  )

  // ─── Shared helpers (DRY: listening + evaluation + coaching) ──────────────

  /** Listen for candidate speech and collect metrics. Resolves with the answer text.
   *  @param showLive - whether to update live answer display
   *  @param timeoutMs - max time to wait for speech (default 30s). 0 = no timeout.
   */
  function listenForAnswer(
    showLive: boolean = true,
    timeoutMs: number = 30000,
    onCaptureReady?: () => void,
  ): Promise<string> {
    // Periodically update avatar emotion during listening based on answer growth
    let lastWordCount = 0
    const emotionInterval = setInterval(() => {
      const currentAnswer = liveAnswerRef.current || ''
      const wordCount = currentAnswer.split(/\s+/).filter(Boolean).length
      if (wordCount > lastWordCount) {
        // Candidate is actively speaking — show engagement
        if (wordCount > 80) {
          setAvatarEmotion('impressed') // Long detailed answer
        } else if (wordCount > 30) {
          setAvatarEmotion('friendly')  // Building momentum
        } else {
          setAvatarEmotion('curious')   // Listening attentively
        }
        lastWordCount = wordCount
      }
    }, 3000) // Check every 3 seconds

    return new Promise((resolve) => {
      let resolved = false
      let timeoutTimer: ReturnType<typeof setTimeout> | undefined

      startListening((result) => {
        if (resolved) return
        resolved = true
        clearTimeout(timeoutTimer)
        clearInterval(emotionInterval)
        if (result.metrics) {
          speechMetricsRef.current.push(result.metrics)
        }
        if (result.words?.length) {
          liveWordsRef.current.push(...result.words)
        }
        if (showLive) setLiveAnswer(result.text)
        resolve(result.text)
      }, { onCaptureReady })

      // Auto-resolve with empty string after timeout if no speech detected
      if (timeoutMs > 0) {
        timeoutTimer = setTimeout(() => {
          if (!resolved) {
            resolved = true
            clearInterval(emotionInterval)
            stopListening()
            resolve('')
          }
        }, timeoutMs)
      }
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
   *  In coach mode: blocks for 3s so the candidate reads the full tip.
   *  In normal mode: fires-and-forgets so the next question can start
   *  immediately — the tip auto-dismisses after 800ms or when the next
   *  transitionTo('ASK_QUESTION') clears it, whichever comes first. */
  async function showCoachingTip(evaluation: AnswerEvaluation): Promise<void> {
    transitionTo('COACHING')
    const tip = deriveCoachingTip(evaluation, config?.role, config?.interviewType)
    setCoachingTip(tip)

    if (config?.coachMode) {
      // Coach mode: block so the candidate can read the full tip
      const abortCtrl = new AbortController()
      coachingAbortRef.current = abortCtrl
      await new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, 3000)
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
      // Normal mode: don't block — auto-dismiss after 800ms in the background.
      // The tip is also cleared on next transitionTo('ASK_QUESTION').
      setTimeout(() => {
        // Only clear if coaching tip hasn't been replaced by something else
        setCoachingTip((prev) => (prev === tip ? null : prev))
      }, 800)
    }
  }

  // Thinking acknowledgments — short filler phrases to avoid dead silence
  const THINKING_ACKS = ['Got it.', 'Mm-hmm.', 'Interesting.', 'I see.']
  const ackCountRef = useRef(0)

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

    // Play a brief thinking acknowledgment if eval takes >1.5s
    // Only fires once every ~3 turns to avoid sounding robotic
    let ackCancelled = false
    const shouldAck = !config?.coachMode && ackCountRef.current % 3 === 0
    const ackTimer = shouldAck
      ? setTimeout(() => {
          if (!ackCancelled) {
            const ack = THINKING_ACKS[ackCountRef.current % THINKING_ACKS.length]
            avatarSpeak(ack, 'friendly')
          }
        }, 1500)
      : undefined

    const [evaluation, concurrentResult] = await Promise.all([
      evaluateAnswer(question, answer, qIdx, probeDepth),
      concurrentTask ?? (Promise.resolve(undefined) as Promise<T>),
    ])

    // Cancel acknowledgment if eval returned before 1.5s
    ackCancelled = true
    if (ackTimer) clearTimeout(ackTimer)
    ackCountRef.current++

    evaluationsRef.current = [...evaluationsRef.current, { ...evaluation, question, answer }]
    performanceSignalRef.current = computePerformanceSignal()
    await showCoachingTip(evaluation)

    return { evaluation, concurrentResult }
  }

  // ─── Finish interview ──────────────────────────────────────────────────────

  const finishInterview = useCallback(async () => {
    transitionTo('SCORING')
    window.speechSynthesis.cancel()
    stopListening()
    onRecordingStop?.()
    // Cancel the interview loop and coaching sleep
    interviewAbortRef.current?.abort()
    coachingAbortRef.current?.abort()
    setCoachingTip(null)

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

      // Clear session state — interview is complete
      localStorage.removeItem(STORAGE_KEYS.INTERVIEW_CONFIG)
      localStorage.removeItem(STORAGE_KEYS.INTERVIEW_ACTIVE_SESSION)
      router.push(`/feedback/${sid}`)
    } else {
      localStorage.removeItem(STORAGE_KEYS.INTERVIEW_CONFIG)
      localStorage.removeItem(STORAGE_KEYS.INTERVIEW_ACTIVE_SESSION)
      router.push('/feedback/local')
    }
  }, [config, router, stopListening, onRecordingStop])

  // ─── Intentional silence ───────────────────────────────────────────────────

  /**
   * After a short answer, occasionally pause for 2.5s to see if the candidate elaborates.
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
    if (wordCount >= 30) return Promise.resolve(null)

    // Adaptive chance: very short answers get higher silence probability
    const silenceChance = wordCount < 15 ? 0.40 : 0.25
    if (Math.random() >= silenceChance) return Promise.resolve(null)

    // Set avatar to "curious" (waiting look)
    setAvatarEmotion('curious')

    return new Promise<string | null>((resolve) => {
      const silenceTimer = setTimeout(() => {
        stopListening()
        resolve(null)
      }, 2500)

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

  /** Decide whether to probe deeper or advance to next topic. */
  function shouldProbeOrAdvance(evaluation: AnswerEvaluation): 'probe' | 'advance' {
    if (!config) return 'advance'
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

  // toneToEmotion is imported from interviewUtils

  /**
   * Handle pushback after evaluation. Returns the spoken question text if pushback
   * was delivered (to be used instead of probeQuestion), or null if no pushback.
   */
  async function handlePushback(
    evaluation: AnswerEvaluation,
    qIdx: number,
  ): Promise<string | null> {
    if (!evaluation.pushback || timeRemainingRef.current < 60) return null

    const { line, tone } = evaluation.pushback
    const emotion = toneToEmotion(tone)

    currentProbeDepthRef.current++

    currentThreadRef.current.push({
      role: 'interviewer', text: line, isProbe: true,
      probeType: 'clarify', probeDepth: currentProbeDepthRef.current,
    })

    // Speak pushback line
    transitionTo('ASK_QUESTION')
    const pushbackQIdx = qIdx + 1
    questionIndexRef.current = pushbackQIdx
    setQuestionIndex(pushbackQIdx)
    setCurrentQuestion(line)
    addToTranscript('interviewer', line, pushbackQIdx)
    warmUpListening?.()
    await avatarSpeak(line, emotion)

    // Listen for response — defer LISTENING until capture starts
    setLiveAnswer('')
    const response = await listenForAnswer(true, 30000, () => transitionTo('LISTENING'))

    if (isInterviewOver()) return line

    if (response) {
      addToTranscript('candidate', response, pushbackQIdx)
      currentThreadRef.current.push({
        role: 'candidate', text: response, isProbe: true,
        probeDepth: currentProbeDepthRef.current,
      })

      // Evaluate pushback response
      await evaluateAndCoach(line, response, pushbackQIdx, undefined, currentProbeDepthRef.current)
    }

    return line
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
        setCurrentQuestion(question)
        addToTranscript('interviewer', question, qIdx)

        // Track in current thread
        currentThreadRef.current = [{
          role: 'interviewer', text: question, isProbe: false, probeDepth: 0,
        }]
        currentProbeDepthRef.current = 0

        // Avatar speaks the question
        checkAbort()
        const emotion: AvatarEmotion =
          qIdx === 0 ? 'friendly' : qIdx % 3 === 0 ? 'curious' : 'neutral'
        warmUpListening?.()
        await avatarSpeak(question, emotion)

        // Listen for answer — defer LISTENING state until audio capture is actually running
        checkAbort()
        setLiveAnswer('')
        const answer = await listenForAnswer(true, 30000, () => transitionTo('LISTENING'))

        if (isInterviewOver()) return

        if (!answer) {
          // Empty answer — nudge the candidate and re-ask.
          // This can happen if speech recognition timed out or failed to initialize.
          checkAbort()
          const retryPrompt = "Take your time — whenever you're ready, I'd love to hear your thoughts on this."
          addToTranscript('interviewer', retryPrompt, qIdx)
          warmUpListening?.()
          await avatarSpeak(retryPrompt, 'friendly')

          checkAbort()
          setLiveAnswer('')
          const retryAnswer = await listenForAnswer(true, 30000, () => transitionTo('LISTENING'))

          if (isInterviewOver()) return
          if (!retryAnswer) {
            // Still empty after retry — move to next question with a gentle transition
            const skipMsg = "No problem — let's move on to the next question."
            addToTranscript('interviewer', skipMsg, qIdx)
            await avatarSpeak(skipMsg, 'friendly')
            finalizeThread(topicQuestion)
            currentTopicIndexRef.current++
            qIdx++
            continue
          }
          // Use retry answer
          addToTranscript('candidate', retryAnswer, qIdx)
          currentThreadRef.current.push({
            role: 'candidate', text: retryAnswer, isProbe: false, probeDepth: 0,
          })
          const { evaluation: retryEval } = await evaluateAndCoach(
            question, retryAnswer, qIdx, undefined, 0,
          )
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

        // Evaluate answer + generate next question in parallel for faster transitions
        checkAbort()
        const nextQIdx = qIdx + 1
        const shouldPrefetch = nextQIdx < maxQ && timeRemainingRef.current > 60
        const nextQuestionPromise = shouldPrefetch ? generateQuestion(nextQIdx) : undefined
        const { evaluation, concurrentResult: prefetchedQ } = await evaluateAndCoach(
          question, finalAnswer, qIdx, nextQuestionPromise, currentProbeDepthRef.current,
        )
        if (prefetchedQ) {
          prefetchedQuestionRef.current = Promise.resolve(prefetchedQ as string)
          // Pre-fetch TTS audio for the next question to eliminate voice delay
          prefetchTTS(prefetchedQ as string)
        }

        // Pre-fetch TTS for probe question if evaluation decided to probe
        if (evaluation.probeDecision?.shouldProbe && evaluation.probeDecision.probeQuestion) {
          prefetchTTS(evaluation.probeDecision.probeQuestion)
        }

        // ── Handle pushback (fires before probe loop, can act as ad-hoc probe) ──
        let currentEval = evaluation
        if (currentEval.pushback && timeRemainingRef.current >= 60) {
          const pushbackResult = await handlePushback(currentEval, qIdx)
          if (pushbackResult) {
            qIdx++ // handlePushback used qIdx+1 for the pushback exchange
            // Re-read the latest evaluation (from the pushback response)
            currentEval = evaluationsRef.current[evaluationsRef.current.length - 1]
          }
          if (isInterviewOver()) return
        }

        // ── Probe loop (only if no pushback already fired, or after pushback evaluation) ──
        while (shouldProbeOrAdvance(currentEval) === 'probe') {
          if (isInterviewOver()) return

          const probeQ = currentEval.probeDecision!.probeQuestion!
          const probeType = currentEval.probeDecision!.probeType ?? undefined
          currentProbeDepthRef.current++
          qIdx++ // Increment global exchange counter

          currentThreadRef.current.push({
            role: 'interviewer', text: probeQ, isProbe: true,
            probeType, probeDepth: currentProbeDepthRef.current,
          })

          // Ask probe
          checkAbort()
          transitionTo('ASK_QUESTION')
          questionIndexRef.current = qIdx
          setQuestionIndex(qIdx)
          setCurrentQuestion(probeQ)
          addToTranscript('interviewer', probeQ, qIdx)
          warmUpListening?.()
          await avatarSpeak(probeQ, 'curious')

          // Listen for probe answer — defer LISTENING until capture starts
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

          // Evaluate probe answer
          const { evaluation: probeEval } = await evaluateAndCoach(
            probeQ, probeAnswer, qIdx, undefined, currentProbeDepthRef.current,
          )
          currentEval = probeEval
        }

        // ── Finalize thread, advance to next topic ──
        finalizeThread(topicQuestion)
        currentTopicIndexRef.current++

        // Avatar emotion based on last evaluation quality
        const avgScore =
          (currentEval.relevance + currentEval.structure +
           currentEval.specificity + currentEval.ownership) / 4
        const responseEmotion: AvatarEmotion =
          avgScore >= 75 ? 'impressed' : avgScore >= 55 ? 'friendly' : 'curious'
        setAvatarEmotion(responseEmotion)

        qIdx++
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

      // Start prefetching Q1 + its TTS in parallel with intro speech
      // (intro takes 3-8 seconds — plenty of time for generation + TTS)
      const q1Promise = generateQuestion(1)
      q1Promise.then((q) => prefetchTTS(q)).catch(() => {})
      prefetchedQuestionRef.current = q1Promise

      warmUpListening?.()
      await avatarSpeak(intro, 'friendly')

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

    const t = setTimeout(start, 500)
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
