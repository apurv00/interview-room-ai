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
} from '@/lib/types'
import {
  INTERVIEW_INTROS,
  WRAP_UP_LINE,
  QUESTION_COUNT,
} from '@/lib/interviewConfig'
import { deriveCoachingTip } from '@/lib/coachingTips'
import { STORAGE_KEYS, sessionScopedKey } from '@/lib/storageKeys'
import type { SpeechRecognitionResult } from './useSpeechRecognition'

// ─── Session persistence helpers ──────────────────────────────────────────────

async function createDbSession(config: InterviewConfig): Promise<string | null> {
  try {
    const res = await fetch('/api/interviews', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ config }),
    })
    if (!res.ok) return null
    const data = await res.json()
    return data.sessionId
  } catch {
    return null
  }
}

async function persistSession(sessionId: string, payload: Record<string, unknown>) {
  const MAX_RETRIES = 3
  for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
    try {
      const res = await fetch(`/api/interviews/${sessionId}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      })
      if (res.ok) return
    } catch {
      // Network error — retry
    }
    if (attempt < MAX_RETRIES - 1) {
      await new Promise((r) => setTimeout(r, 1000 * Math.pow(2, attempt)))
    }
  }
  // All retries failed — localStorage is the fallback
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
    createDbSession(config).then((id) => {
      if (id) {
        sessionIdRef.current = id
        persistSession(id, { status: 'in_progress', startedAt: new Date().toISOString() })
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
          'Microsoft Neerja',
          'Google India English',
          'Rishi',
          'Veena',
          'Samantha',
          'Google UK English Female',
          'Karen',
          'Moira',
        ]
        const preferred = voicePreferences.reduce<SpeechSynthesisVoice | null>(
          (found, name) => found || voices.find((v) => v.name.includes(name)) || null,
          null
        )
        if (preferred) utterance.voice = preferred
        utterance.rate = 0.95
        utterance.pitch = 1.0
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

  // ─── Generate question ─────────────────────────────────────────────────────

  const generateQuestion = useCallback(
    async (qIdx: number): Promise<string> => {
      try {
        const res = await fetch('/api/generate-question', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ config, questionIndex: qIdx, previousQA: transcriptRef.current }),
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
    async (question: string, answer: string, qIdx: number): Promise<AnswerEvaluation> => {
      try {
        const res = await fetch('/api/evaluate-answer', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ config, question, answer, questionIndex: qIdx }),
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

  /** Evaluate answer, accumulate result, show coaching tip, wait 3.5s (cancellable). */
  async function evaluateAndCoach(
    question: string,
    answer: string,
    qIdx: number,
  ): Promise<AnswerEvaluation> {
    transitionTo('PROCESSING')
    setLiveAnswer('')
    const evaluation = await evaluateAnswer(question, answer, qIdx)
    evaluationsRef.current = [...evaluationsRef.current, { ...evaluation, question, answer }]

    transitionTo('COACHING')
    setCoachingTip(deriveCoachingTip(evaluation))
    const abortCtrl = new AbortController()
    coachingAbortRef.current = abortCtrl
    await new Promise<void>((resolve) => {
      const timer = setTimeout(resolve, 3500)
      abortCtrl.signal.addEventListener('abort', () => {
        clearTimeout(timer)
        resolve()
      })
    })
    coachingAbortRef.current = null
    if (!abortCtrl.signal.aborted) {
      setCoachingTip(null)
    }

    return evaluation
  }

  // ─── Finish interview ──────────────────────────────────────────────────────

  const finishInterview = useCallback(() => {
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

    // Persist to DB (fire-and-forget) and navigate immediately
    if (sid) {
      persistSession(sid, {
        status: 'completed',
        completedAt: new Date().toISOString(),
        durationActualSeconds: config ? config.duration * 60 - timeRemainingRef.current : 0,
        transcript: transcriptRef.current,
        evaluations: evaluationsRef.current,
        speechMetrics: speechMetricsRef.current,
      })
      router.push(`/feedback/${sid}`)
    } else {
      router.push('/feedback/local')
    }
  }, [config, router, stopListening, onRecordingStop])

  // ─── Main interview loop ───────────────────────────────────────────────────

  const runInterviewLoop = useCallback(
    async (startingQIndex: number) => {
      if (!config) return
      const maxQ = QUESTION_COUNT[config.duration]

      for (let qIdx = startingQIndex; qIdx < maxQ; qIdx++) {
        if (isInterviewOver()) return

        // Check time
        if (timeRemainingRef.current < 30) break

        // Generate question
        transitionTo('ASK_QUESTION')
        const question = await generateQuestion(qIdx)
        questionIndexRef.current = qIdx
        setQuestionIndex(qIdx)
        setCurrentQuestion(question)
        addToTranscript('interviewer', question, qIdx)

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
          continue
        }

        addToTranscript('candidate', answer, qIdx)

        // Evaluate + coaching
        const evaluation = await evaluateAndCoach(question, answer, qIdx)

        // Avatar emotion based on quality
        const avgScore =
          (evaluation.relevance +
            evaluation.structure +
            evaluation.specificity +
            evaluation.ownership) /
          4
        const responseEmotion: AvatarEmotion =
          avgScore >= 75 ? 'impressed' : avgScore >= 55 ? 'friendly' : 'curious'

        // Follow-up?
        if (
          evaluation.needsFollowUp &&
          evaluation.followUpQuestion &&
          timeRemainingRef.current > 60
        ) {
          transitionTo('FOLLOW_UP')
          addToTranscript('interviewer', evaluation.followUpQuestion, qIdx)
          await avatarSpeak(evaluation.followUpQuestion, 'curious')

          transitionTo('LISTENING')
          const followUpAnswer = await listenForAnswer(false)

          if (followUpAnswer) {
            addToTranscript('candidate', followUpAnswer, qIdx)
          }
          transitionTo('PROCESSING')
          setAvatarEmotion(responseEmotion)
          await new Promise((r) => setTimeout(r, 600))
        } else {
          setAvatarEmotion(responseEmotion)
        }
      }

      // Wrap-up
      if (isInterviewOver()) return
      transitionTo('WRAP_UP')
      addToTranscript('interviewer', WRAP_UP_LINE)
      await avatarSpeak(WRAP_UP_LINE, 'friendly')

      // 10s for user to ask questions
      await new Promise((r) => setTimeout(r, 10000))
      finishInterview()
    },
    [config, generateQuestion, avatarSpeak, startListening, evaluateAnswer, addToTranscript, finishInterview]
  )

  // ─── Start interview when config + voices ready ────────────────────────────

  useEffect(() => {
    if (!config || !voicesReady) return

    const start = async () => {
      const intro = INTERVIEW_INTROS[config.role]
      setCurrentQuestion(intro)
      addToTranscript('interviewer', intro, 0)
      await avatarSpeak(intro, 'friendly')

      // Listen for the candidate's response to the intro ("tell me about yourself")
      transitionTo('LISTENING')
      setLiveAnswer('')
      questionIndexRef.current = 0
      setQuestionIndex(0)

      const introAnswer = await listenForAnswer()

      if (isInterviewOver()) return

      if (introAnswer) {
        addToTranscript('candidate', introAnswer, 0)
        await evaluateAndCoach(intro, introAnswer, 0)
      }

      // Continue with AI-generated questions starting from index 1
      runInterviewLoop(1)
    }

    const t = setTimeout(start, 800)
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
