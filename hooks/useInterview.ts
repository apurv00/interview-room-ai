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
  try {
    await fetch(`/api/interviews/${sessionId}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    })
  } catch {
    // Fail silently — localStorage is the fallback
  }
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
  transcript: TranscriptEntry[]
  evaluations: AnswerEvaluation[]
  speechMetrics: SpeechMetrics[]
  avatarEmotion: AvatarEmotion
  isAvatarTalking: boolean
  timeRemaining: number
  liveAnswer: string
  sessionId: string | null
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
  const [transcript, setTranscript] = useState<TranscriptEntry[]>([])
  const transcriptRef = useRef<TranscriptEntry[]>([])
  const [evaluations, setEvaluations] = useState<AnswerEvaluation[]>([])
  const evaluationsRef = useRef<AnswerEvaluation[]>([])
  const [speechMetrics, setSpeechMetrics] = useState<SpeechMetrics[]>([])
  const speechMetricsRef = useRef<SpeechMetrics[]>([])

  // ── Live answer capture ──
  const [liveAnswer, setLiveAnswer] = useState('')

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
        const preferred = voices.find(
          (v) =>
            v.name.includes('Samantha') ||
            v.name.includes('Google UK English Female') ||
            v.name.includes('Karen') ||
            v.name.includes('Moira')
        )
        if (preferred) utterance.voice = preferred
        utterance.rate = 0.93
        utterance.pitch = 1.05
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
      setTranscript([...transcriptRef.current])
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

  // ─── Finish interview ──────────────────────────────────────────────────────

  const finishInterview = useCallback(() => {
    transitionTo('SCORING')
    window.speechSynthesis.cancel()
    stopListening()
    onRecordingStop?.()

    const data = {
      config,
      transcript: transcriptRef.current,
      evaluations: evaluationsRef.current,
      speechMetrics: speechMetricsRef.current,
    }
    // Keep localStorage as fallback
    localStorage.setItem('interviewData', JSON.stringify(data))

    // Persist to DB and navigate with sessionId
    const sid = sessionIdRef.current
    if (sid) {
      persistSession(sid, {
        status: 'completed',
        completedAt: new Date().toISOString(),
        durationActualSeconds: config ? config.duration * 60 - timeRemainingRef.current : 0,
        transcript: transcriptRef.current,
        evaluations: evaluationsRef.current,
        speechMetrics: speechMetricsRef.current,
      }).then(() => {
        router.push(`/feedback/${sid}`)
      })
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
        if (
          (phaseRef.current as string) === 'SCORING' ||
          (phaseRef.current as string) === 'ENDED'
        )
          return

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

        const answer: string = await new Promise((resolve) => {
          startListening((result) => {
            if (result.metrics) {
              speechMetricsRef.current = [...speechMetricsRef.current, result.metrics]
              setSpeechMetrics([...speechMetricsRef.current])
            }
            setLiveAnswer(result.text)
            resolve(result.text)
          })
        })

        if (
          (phaseRef.current as string) === 'SCORING' ||
          (phaseRef.current as string) === 'ENDED'
        )
          return

        // Process
        transitionTo('PROCESSING')
        setLiveAnswer('')

        if (!answer) continue

        addToTranscript('candidate', answer, qIdx)

        // Evaluate
        const evaluation = await evaluateAnswer(question, answer, qIdx)
        const updated = [...evaluationsRef.current, { ...evaluation, question, answer }]
        evaluationsRef.current = updated
        setEvaluations([...updated])

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
          const followUpAnswer: string = await new Promise((resolve) => {
            startListening((result) => {
              if (result.metrics) {
                speechMetricsRef.current = [...speechMetricsRef.current, result.metrics]
                setSpeechMetrics([...speechMetricsRef.current])
              }
              resolve(result.text)
            })
          })

          if (followUpAnswer) {
            addToTranscript('candidate', followUpAnswer, qIdx)
          }
          transitionTo('PROCESSING')
          setAvatarEmotion(responseEmotion)
          await new Promise((r) => setTimeout(r, 600))
        } else {
          setAvatarEmotion(responseEmotion)
          await new Promise((r) => setTimeout(r, 600))
        }
      }

      // Wrap-up
      if (
        (phaseRef.current as string) === 'SCORING' ||
        (phaseRef.current as string) === 'ENDED'
      )
        return
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
      addToTranscript('interviewer', intro)
      await avatarSpeak(intro, 'friendly')
      runInterviewLoop(0)
    }

    const t = setTimeout(start, 800)
    return () => clearTimeout(t)
  }, [config, voicesReady]) // eslint-disable-line react-hooks/exhaustive-deps

  return {
    phase,
    questionIndex,
    currentQuestion,
    transcript,
    evaluations,
    speechMetrics,
    avatarEmotion,
    isAvatarTalking,
    timeRemaining,
    liveAnswer,
    sessionId: sessionIdRef.current,
    finishInterview,
  }
}
