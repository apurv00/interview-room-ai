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
  QUESTION_COUNT,
  MINIMUM_TOPICS,
} from '@interview/config/interviewConfig'
import { deriveCoachingTip } from '@interview/config/coachingTips'
import { STORAGE_KEYS, sessionScopedKey } from '@shared/storageKeys'
import { fetchWithRetry } from '@shared/fetchWithRetry'
import type { SpeechRecognitionResult } from './useSpeechRecognition'
import {
  computePerformanceSignal as computeSignal,
  shouldProbeOrAdvance as probeOrAdvance,
  buildThreadSummary as buildSummary,
  toneToEmotion,
} from './interviewUtils'

// ─── Session persistence helpers ──────────────────────────────────────────────

interface CreateDbSessionResult {
  sessionId: string | null
  limitReached?: boolean
}

async function createDbSession(config: InterviewConfig): Promise<CreateDbSessionResult> {
  try {
    const res = await fetch('/api/interviews', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ config }),
    })
    if (res.status === 402) return { sessionId: null, limitReached: true }
    if (!res.ok) return { sessionId: null }
    const data = await res.json()
    return { sessionId: data.sessionId }
  } catch {
    return { sessionId: null }
  }
}

async function persistSession(sessionId: string, payload: Record<string, unknown>) {
  await fetchWithRetry(`/api/interviews/${sessionId}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  })
}

// ─── Hook options ─────────────────────────────────────────────────────────────

interface UseInterviewOptions {
  config: InterviewConfig | null
  voicesReady: boolean
  startListening: (onComplete: (result: SpeechRecognitionResult) => void) => void
  stopListening: () => void
  onRecordingStop?: () => void
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
}

// ─── Hook ─────────────────────────────────────────────────────────────────────

export function useInterview({
  config,
  voicesReady,
  startListening,
  stopListening,
  onRecordingStop,
}: UseInterviewOptions): UseInterviewReturn {
  const router = useRouter()

  // ── State machine ──
  const [phase, setPhase] = useState<InterviewState>('INTERVIEW_START')
  const phaseRef = useRef<InterviewState>('INTERVIEW_START')
  function transitionTo(s: InterviewState) {
    phaseRef.current = s
    setPhase(s)
  }

  // ── Avatar ──
  const [avatarEmotion, setAvatarEmotion] = useState<AvatarEmotion>('friendly')
  const [isAvatarTalking, setIsAvatarTalking] = useState(false)

  // ── Interview content ──
  const [currentQuestion, setCurrentQuestion] = useState('')
  const [questionIndex, setQuestionIndex] = useState(0)
  const questionIndexRef = useRef(0)
  const transcriptRef = useRef<TranscriptEntry[]>([])
  const evaluationsRef = useRef<AnswerEvaluation[]>([])
  const speechMetricsRef = useRef<SpeechMetrics[]>([])

  // ── Live answer capture ──
  const [liveAnswer, setLiveAnswer] = useState('')

  // ── Coaching ──
  const [coachingTip, setCoachingTip] = useState<string | null>(null)
  const coachingAbortRef = useRef<AbortController | null>(null)

  // ── Performance signal (progressive difficulty) ──
  const performanceSignalRef = useRef<PerformanceSignal>('calibrating')

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
      if (result.sessionId) {
        sessionIdRef.current = result.sessionId
        persistSession(result.sessionId, { status: 'in_progress', startedAt: new Date().toISOString() })
      }
    })
  }, [config])

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

  // ─── TTS (avatar speaks) ───────────────────────────────────────────────────

  const avatarSpeak = useCallback(
    (text: string, emotion: AvatarEmotion = 'friendly'): Promise<void> => {
      return new Promise((resolve) => {
        window.speechSynthesis.cancel()
        const utterance = new SpeechSynthesisUtterance(text)
        const voices = window.speechSynthesis.getVoices()
        // Prefer Indian English / natural-sounding voices, fall back to Western defaults
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
        utterance.rate = 1.08
        utterance.pitch = 1.02
        utterance.volume = 1

        setAvatarEmotion(emotion)
        setIsAvatarTalking(true)

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
    []
  )

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

  // ─── Generate question ─────────────────────────────────────────────────────

  const generateQuestion = useCallback(
    async (qIdx: number): Promise<string> => {
      try {
        const threads = completedThreadsRef.current
        const lastThread = threads.length > 0 ? threads[threads.length - 1] : undefined
        const res = await fetch('/api/generate-question', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            config,
            questionIndex: qIdx,
            previousQA: transcriptRef.current,
            performanceSignal: performanceSignalRef.current,
            lastThreadSummary: lastThread,
            completedThreads: threads.length > 0 ? threads : undefined,
          }),
        })
        const data = await res.json()
        return data.question as string
      } catch {
        return 'Tell me about a challenge you faced recently and how you handled it.'
      }
    },
    [config]
  )

  // ─── Evaluate answer ───────────────────────────────────────────────────────

  const evaluateAnswer = useCallback(
    async (question: string, answer: string, qIdx: number, probeDepth?: number): Promise<AnswerEvaluation> => {
      try {
        const res = await fetch('/api/evaluate-answer', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ config, question, answer, questionIndex: qIdx, probeDepth }),
        })
        return res.json()
      } catch {
        return {
          questionIndex: qIdx,
          question,
          answer,
          relevance: 60,
          structure: 55,
          specificity: 55,
          ownership: 60,
          needsFollowUp: false,
          flags: [],
        }
      }
    },
    [config]
  )

  // ─── Shared helpers (DRY: listening + evaluation + coaching) ──────────────

  /** Listen for candidate speech and collect metrics. Resolves with the answer text. */
  function listenForAnswer(showLive: boolean = true): Promise<string> {
    return new Promise((resolve) => {
      startListening((result) => {
        if (result.metrics) {
          speechMetricsRef.current.push(result.metrics)
        }
        if (showLive) setLiveAnswer(result.text)
        resolve(result.text)
      })
    })
  }

  /** Returns true if interview has been ended/scored (should bail out of loop). */
  function isInterviewOver(): boolean {
    return (
      (phaseRef.current as string) === 'SCORING' ||
      (phaseRef.current as string) === 'ENDED'
    )
  }

  /** Show coaching tip for 2s (cancellable via coachingAbortRef). */
  async function showCoachingTip(evaluation: AnswerEvaluation): Promise<void> {
    transitionTo('COACHING')
    setCoachingTip(deriveCoachingTip(evaluation))
    const abortCtrl = new AbortController()
    coachingAbortRef.current = abortCtrl
    await new Promise<void>((resolve) => {
      const timer = setTimeout(resolve, 2000)
      abortCtrl.signal.addEventListener('abort', () => {
        clearTimeout(timer)
        resolve()
      })
    })
    coachingAbortRef.current = null
    if (!abortCtrl.signal.aborted) {
      setCoachingTip(null)
    }
  }

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

    const [evaluation, concurrentResult] = await Promise.all([
      evaluateAnswer(question, answer, qIdx, probeDepth),
      concurrentTask ?? (Promise.resolve(undefined) as Promise<T>),
    ])

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
    // Cancel coaching sleep if in progress
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
              interviewType: config.interviewType || 'hr-screening',
              score: avgScore,
              strongDimensions: sorted.slice(0, 2).map(d => d.name),
              weakDimensions: sorted.slice(-2).map(d => d.name),
            }),
          }).catch(() => {})
        }
      }

      router.push(`/feedback/${sid}`)
    } else {
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

    const wordCount = answer.trim().split(/\s+/).length
    if (wordCount >= 30) return Promise.resolve(null)

    // 25% chance
    if (Math.random() >= 0.25) return Promise.resolve(null)

    // Set avatar to "curious" (waiting look)
    setAvatarEmotion('curious')

    return new Promise<string | null>((resolve) => {
      const silenceTimer = setTimeout(() => {
        stopListening()
        resolve(null)
      }, 2500)

      startListening((result) => {
        clearTimeout(silenceTimer)
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
    await avatarSpeak(line, emotion)

    // Listen for response
    transitionTo('LISTENING')
    setLiveAnswer('')
    const response = await listenForAnswer()

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
      const maxQ = QUESTION_COUNT[config.duration]
      let qIdx = startingQIndex

      while (qIdx < maxQ) {
        if (isInterviewOver()) return
        if (timeRemainingRef.current < 30) break

        // ── Generate new topic question ──
        transitionTo('ASK_QUESTION')
        const question = await generateQuestion(qIdx)
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
        const emotion: AvatarEmotion =
          qIdx === 0 ? 'friendly' : qIdx % 3 === 0 ? 'curious' : 'neutral'
        await avatarSpeak(question, emotion)

        // Listen for answer
        transitionTo('LISTENING')
        setLiveAnswer('')
        const answer = await listenForAnswer()

        if (isInterviewOver()) return

        if (!answer) {
          transitionTo('PROCESSING')
          setLiveAnswer('')
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

        // Evaluate (uses combined answer if candidate elaborated during silence)
        const { evaluation } = await evaluateAndCoach(
          question, finalAnswer, qIdx, undefined, currentProbeDepthRef.current,
        )

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
          const probeType = currentEval.probeDecision!.probeType
          currentProbeDepthRef.current++
          qIdx++ // Increment global exchange counter

          currentThreadRef.current.push({
            role: 'interviewer', text: probeQ, isProbe: true,
            probeType, probeDepth: currentProbeDepthRef.current,
          })

          // Ask probe
          transitionTo('ASK_QUESTION')
          questionIndexRef.current = qIdx
          setQuestionIndex(qIdx)
          setCurrentQuestion(probeQ)
          addToTranscript('interviewer', probeQ, qIdx)
          await avatarSpeak(probeQ, 'curious')

          // Listen for probe answer
          transitionTo('LISTENING')
          setLiveAnswer('')
          const probeAnswer = await listenForAnswer()

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

      // Wrap-up
      if (isInterviewOver()) return
      transitionTo('WRAP_UP')
      addToTranscript('interviewer', WRAP_UP_LINE)
      await avatarSpeak(WRAP_UP_LINE, 'friendly')

      // 6s for user to ask questions
      await new Promise((r) => setTimeout(r, 6000))
      finishInterview()
    },
    [config, generateQuestion, avatarSpeak, startListening, evaluateAnswer, addToTranscript, finishInterview] // eslint-disable-line react-hooks/exhaustive-deps
  )

  // ─── Start interview when config + voices ready ────────────────────────────

  useEffect(() => {
    if (!config || !voicesReady) return

    const start = async () => {
      const intro = getInterviewIntro(config.role)
      setCurrentQuestion(intro)
      addToTranscript('interviewer', intro, 0)
      await avatarSpeak(intro, 'friendly')

      // Listen for the candidate's response to the intro ("tell me about yourself")
      transitionTo('LISTENING')
      setLiveAnswer('')
      questionIndexRef.current = 0
      setQuestionIndex(0)

      // Track intro as thread
      currentThreadRef.current = [
        { role: 'interviewer', text: intro, isProbe: false, probeDepth: 0 },
      ]

      const introAnswer = await listenForAnswer()

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
      runInterviewLoop(1)
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
  }
}
