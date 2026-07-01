'use client'

import { useCallback, useRef } from 'react'
import type {
  InterviewConfig,
  TranscriptEntry,
  AnswerEvaluation,
  PerformanceSignal,
  ThreadSummary,
} from '@shared/types'
import { getNextFallbackQuestion } from '../config/fallbackQuestions'
import { buildPreviousQA } from './interviewUtils'

interface UseInterviewAPIOptions {
  config: InterviewConfig | null
  /**
   * Lazy getter for the current session id. Used to pass `sessionId` in the
   * body of generate-question / evaluate-answer requests so the server-side
   * Document Intelligence Layer can look up cached JD/resume context. A
   * getter (rather than a value) is used because `sessionIdRef` is populated
   * asynchronously after `createDbSession` resolves, and we want the latest
   * value at the moment of the fetch call.
   */
  getSessionId?: () => string | null
}

export interface PreviousAnswerSummary {
  question: string
  answerSummary: string
}

export const EVALUATE_ANSWER_BLOCKING_TIMEOUT_MS = 10_000
export const EVALUATE_ANSWER_BACKGROUND_TIMEOUT_MS = 15_000
export const ANSWER_CANDIDATE_QUESTION_TIMEOUT_MS = 8_000
export const CLARIFY_CASE_CONTEXT_TIMEOUT_MS = 8_000

export type CandidateQuestionContext = 'wrap_up' | 'mid_interview'

type EvaluationFallbackScores = Pick<AnswerEvaluation, 'relevance' | 'structure' | 'specificity' | 'ownership'>

export function buildFailedAnswerEvaluation(
  question: string,
  answer: string,
  qIdx: number,
  scores: EvaluationFallbackScores,
  failure?: AnswerEvaluation['failure'],
): AnswerEvaluation {
  return {
    questionIndex: qIdx,
    question,
    answer,
    ...scores,
    status: 'failed',
    ...(failure && { failure }),
    probeDecision: { shouldProbe: false },
  }
}

function errorDetails(err: unknown): { name?: string; message: string } {
  if (err instanceof Error) return { name: err.name, message: err.message }
  return { message: String(err) }
}

export interface TurnRouterResult {
  nextAction: 'probe' | 'advance'
  probeQuestion?: string
  style: 'curious' | 'probing' | 'encouraging' | 'neutral'
  isNonsensical: boolean
  isPivot: boolean
  interruptResolution?: import('@shared/types').InterruptResolution
}

/** Lightweight flow metadata returned by generate-question for client-side probe decisions. */
export interface FlowHints {
  maxProbes: number
  phase: string
  totalSlots: number
  remainingMustSlots: number
  /** Active template slot id — used by QA harness for answer routing */
  slotId?: string
  /** Competency bucket for diversity + QA strong-answer routing */
  competencyBucket?: string
  slotLabel?: string
  slotIndex?: number
  domain?: string
  depth?: string
}

export interface UseInterviewAPIReturn {
  generateQuestion: (
    qIdx: number,
    transcript: TranscriptEntry[],
    performanceSignal: PerformanceSignal,
    completedThreads: ThreadSummary[],
    signal?: AbortSignal,
  ) => Promise<string>
  /** Last flow hints received from generate-question. Updated on every successful call. */
  flowHintsRef: React.RefObject<FlowHints | null>
  evaluateAnswer: (
    question: string,
    answer: string,
    qIdx: number,
    probeDepth?: number,
    signal?: AbortSignal,
    previousSummaries?: PreviousAnswerSummary[],
    /**
     * G.12: true when the answer was cut off by the interview timer
     * expiring. Route injects a "don't penalize incompleteness" hint
     * into the user prompt and stamps 'truncated_by_timer' onto the
     * evaluation's flags array.
     */
    wasTruncatedByTimer?: boolean,
    timeoutMs?: number,
  ) => Promise<AnswerEvaluation>
  callTurnRouter: (params: {
    question: string
    answer: string
    probeDepth: number
    questionIndex: number
    interviewType: string
    signal?: AbortSignal
    interruptContext?: { interruptSpeech: string; interruptedUtterance: string; spokenPortion: string }
  }) => Promise<TurnRouterResult>
  answerCandidateQuestion: (
    candidateQuestion: string,
    context: CandidateQuestionContext,
    signal?: AbortSignal,
  ) => Promise<string>
  clarifyCaseContext: (
    candidateQuestion: string,
    activeQuestion: string,
    questionIndex?: number,
    threadSummary?: string,
    signal?: AbortSignal,
  ) => Promise<string>
}

export function fallbackCandidateQuestionAnswer(context: CandidateQuestionContext): string {
  if (context === 'mid_interview') {
    return "I don't have the exact company-specific details here, but generally that depends on the role and hiring team."
  }
  return "I don't have the exact company-specific details here, but generally the recruiter or hiring team will share the confirmed process and timing after the interview."
}

export function fallbackCaseContextAnswer(interviewType?: string): string {
  if (interviewType === 'system-design') {
    return 'For this mock design, assume a mid-scale product with enough traffic to require scalable components and standard constraints around latency, reliability, and cost. Take a moment to structure your approach, then walk me through it.'
  }
  return 'For this mock case, assume a realistic product scenario with a measurable goal, clear customer segment, and practical timeline and resource constraints. Take a moment to structure your approach, then walk me through it.'
}

/**
 * Encapsulates API calls for question generation and answer evaluation.
 */
export function useInterviewAPI({ config, getSessionId }: UseInterviewAPIOptions): UseInterviewAPIReturn {
  const usedFallbackIndicesRef = useRef(new Set<string>())
  const flowHintsRef = useRef<FlowHints | null>(null)

  const generateQuestion = useCallback(
    async (
      qIdx: number,
      transcript: TranscriptEntry[],
      performanceSignal: PerformanceSignal,
      completedThreads: ThreadSummary[],
      signal?: AbortSignal,
    ): Promise<string> => {
      try {
        const lastThread = completedThreads.length > 0
          ? completedThreads[completedThreads.length - 1]
          : undefined
        const res = await fetch('/api/generate-question', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          signal,
          body: JSON.stringify({
            config,
            questionIndex: qIdx,
            // Cap previousQA to last 10 entries (~2 recent topics with probes).
            // Older topics are already summarized in completedThreads (topic
            // question, avg score, probe count, company). Sending the full
            // transcript caused unbounded input growth: ~11.5K tokens at Q16
            // in a 30-min interview, adding 500-800ms TTFT latency.
            // Academics also PINS the intro Q&A (the named subject) — see buildPreviousQA.
            previousQA: buildPreviousQA(transcript, config?.interviewType),
            performanceSignal,
            lastThreadSummary: lastThread,
            // Send the most recent 30 topic summaries (matches the 30-question ceiling +
            // GenerateQuestionSchema.max(30)). The server derives the flow-slot cursor + coverage from
            // completedThreads.length, so slicing to 20 froze that count and dropped the earliest topics
            // from the anti-repeat context on long sessions (Codex #484 P2). slice(-30) keeps the full
            // session while still bounding an over-length body (e.g. a future 45/60-min duration).
            completedThreads: completedThreads.length > 0 ? completedThreads.slice(-30) : undefined,
            sessionId: getSessionId?.() ?? undefined,
          }),
        })
        if (!res.ok) {
          console.error(`[generateQuestion] API returned ${res.status}`, await res.text().catch(() => ''))
          return getNextFallbackQuestion(usedFallbackIndicesRef.current, config?.role)
        }
        const data = await res.json()
        if (data.flowHints) flowHintsRef.current = data.flowHints as FlowHints
        return data.question as string
      } catch (err) {
        console.error('[generateQuestion] fetch failed', err)
        return getNextFallbackQuestion(usedFallbackIndicesRef.current, config?.role)
      }
    },
    [config, getSessionId]
  )

  const evaluateAnswer = useCallback(
    async (
      question: string,
      answer: string,
      qIdx: number,
      probeDepth?: number,
      signal?: AbortSignal,
      previousSummaries?: PreviousAnswerSummary[],
      wasTruncatedByTimer?: boolean,
      timeoutMs = EVALUATE_ANSWER_BLOCKING_TIMEOUT_MS,
    ): Promise<AnswerEvaluation> => {
      const timeoutController = new AbortController()
      let didTimeout = false
      const timeoutId = setTimeout(() => {
        didTimeout = true
        timeoutController.abort()
      }, timeoutMs)
      const sessionId = getSessionId?.() ?? undefined
      let externalAbortListener: (() => void) | undefined
      if (signal && !AbortSignal.any) {
        externalAbortListener = () => timeoutController.abort()
        signal.addEventListener('abort', externalAbortListener, { once: true })
      }
      try {
        const combinedSignal = signal && AbortSignal.any
          ? AbortSignal.any([signal, timeoutController.signal])
          : timeoutController.signal
        const res = await fetch('/api/evaluate-answer', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          signal: combinedSignal,
          body: JSON.stringify({
            config,
            question,
            answer,
            questionIndex: qIdx,
            probeDepth,
            previousAnswerSummaries: previousSummaries,
            sessionId,
            // G.12: only include when true — keeps the body minimal and
            // the server's Zod schema treats absence = false.
            ...(wasTruncatedByTimer && { wasTruncatedByTimer: true }),
          }),
        })
        if (!res.ok) {
          console.warn('[evaluateAnswer] API returned non-OK', {
            status: res.status,
            questionIndex: qIdx,
            sessionId,
          })
          return buildFailedAnswerEvaluation(question, answer, qIdx, {
            relevance: 60,
            structure: 55,
            specificity: 55,
            ownership: 60,
          }, {
            source: 'client',
            reason: 'client_http_non_ok',
            httpStatus: res.status,
            message: `HTTP ${res.status}`,
            taskSlot: 'interview.evaluate-answer',
          })
        }
        return res.json()
      } catch (err) {
        if (didTimeout) {
          console.warn('[evaluateAnswer] timed out', {
            questionIndex: qIdx,
            sessionId,
            timeoutMs,
          })
          return buildFailedAnswerEvaluation(question, answer, qIdx, {
            relevance: 50,
            structure: 50,
            specificity: 50,
            ownership: 50,
          }, {
            source: 'client',
            reason: 'client_timeout',
            timeoutMs,
            taskSlot: 'interview.evaluate-answer',
          })
        }

        const details = errorDetails(err)
        if (!signal?.aborted) {
          console.warn('[evaluateAnswer] fetch failed', {
            questionIndex: qIdx,
            sessionId,
            error: details,
          })
        }
        return buildFailedAnswerEvaluation(question, answer, qIdx, {
          relevance: 60,
          structure: 55,
          specificity: 55,
          ownership: 60,
        }, {
          source: 'client',
          reason: 'client_fetch_error',
          message: details.message,
          taskSlot: 'interview.evaluate-answer',
        })
      } finally {
        clearTimeout(timeoutId)
        if (signal && externalAbortListener) {
          signal.removeEventListener('abort', externalAbortListener)
        }
      }
    },
    [config, getSessionId]
  )

  const TURN_ROUTER_FALLBACK: TurnRouterResult = {
    nextAction: 'advance',
    probeQuestion: undefined,
    style: 'neutral',
    isNonsensical: false,
    isPivot: false,
  }

  const callTurnRouter = useCallback(
    async ({
      question,
      answer,
      probeDepth,
      questionIndex,
      interviewType,
      signal,
      interruptContext,
    }: {
      question: string
      answer: string
      probeDepth: number
      questionIndex: number
      interviewType: string
      signal?: AbortSignal
      interruptContext?: { interruptSpeech: string; interruptedUtterance: string; spokenPortion: string }
    }): Promise<TurnRouterResult> => {
      try {
        const res = await fetch('/api/turn-router', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          signal,
          // role lets the router pull the per-domain×depth persona + question strategy so probes
          // are framework-aware (config is stable for the session; null on older/edge cases → generic).
          body: JSON.stringify({ question, answer, probeDepth, questionIndex, interviewType, role: config?.role, interruptContext }),
        })
        if (!res.ok) return TURN_ROUTER_FALLBACK
        return (await res.json()) as TurnRouterResult
      } catch {
        return TURN_ROUTER_FALLBACK
      }
    },
    [config], // config for role-based probe grounding
  )

  const answerCandidateQuestion = useCallback(
    async (
      candidateQuestion: string,
      context: CandidateQuestionContext,
      signal?: AbortSignal,
    ): Promise<string> => {
      if (!config) return fallbackCandidateQuestionAnswer(context)

      const timeoutController = new AbortController()
      let didTimeout = false
      const timeoutId = setTimeout(() => {
        didTimeout = true
        timeoutController.abort()
      }, ANSWER_CANDIDATE_QUESTION_TIMEOUT_MS)

      let externalAbortListener: (() => void) | undefined
      if (signal && !AbortSignal.any) {
        externalAbortListener = () => timeoutController.abort()
        signal.addEventListener('abort', externalAbortListener, { once: true })
      }

      try {
        const combinedSignal = signal && AbortSignal.any
          ? AbortSignal.any([signal, timeoutController.signal])
          : timeoutController.signal
        const res = await fetch('/api/interview/answer-candidate-question', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          signal: combinedSignal,
          body: JSON.stringify({
            candidateQuestion,
            config,
            sessionId: getSessionId?.() ?? undefined,
            context,
          }),
        })

        if (!res.ok) {
          console.warn('[answerCandidateQuestion] API returned non-OK', {
            status: res.status,
            context,
          })
          return fallbackCandidateQuestionAnswer(context)
        }

        const data = await res.json() as { answer?: unknown }
        return typeof data.answer === 'string' && data.answer.trim()
          ? data.answer.trim()
          : fallbackCandidateQuestionAnswer(context)
      } catch (err) {
        if (!signal?.aborted) {
          console.warn(didTimeout ? '[answerCandidateQuestion] timed out' : '[answerCandidateQuestion] fetch failed', {
            context,
            error: errorDetails(err),
          })
        }
        return fallbackCandidateQuestionAnswer(context)
      } finally {
        clearTimeout(timeoutId)
        if (signal && externalAbortListener) {
          signal.removeEventListener('abort', externalAbortListener)
        }
      }
    },
    [config, getSessionId],
  )

  const clarifyCaseContext = useCallback(
    async (
      candidateQuestion: string,
      activeQuestion: string,
      questionIndex?: number,
      threadSummary?: string,
      signal?: AbortSignal,
    ): Promise<string> => {
      if (!config) return fallbackCaseContextAnswer()

      const timeoutController = new AbortController()
      let didTimeout = false
      const timeoutId = setTimeout(() => {
        didTimeout = true
        timeoutController.abort()
      }, CLARIFY_CASE_CONTEXT_TIMEOUT_MS)

      let externalAbortListener: (() => void) | undefined
      if (signal && !AbortSignal.any) {
        externalAbortListener = () => timeoutController.abort()
        signal.addEventListener('abort', externalAbortListener, { once: true })
      }

      try {
        const combinedSignal = signal && AbortSignal.any
          ? AbortSignal.any([signal, timeoutController.signal])
          : timeoutController.signal
        const res = await fetch('/api/interview/clarify-case-context', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          signal: combinedSignal,
          body: JSON.stringify({
            candidateQuestion,
            activeQuestion,
            config,
            sessionId: getSessionId?.() ?? undefined,
            questionIndex,
            threadSummary,
          }),
        })

        if (!res.ok) {
          console.warn('[clarifyCaseContext] API returned non-OK', {
            status: res.status,
            questionIndex,
          })
          return fallbackCaseContextAnswer(config.interviewType)
        }

        const data = await res.json() as { answer?: unknown }
        return typeof data.answer === 'string' && data.answer.trim()
          ? data.answer.trim()
          : fallbackCaseContextAnswer(config.interviewType)
      } catch (err) {
        if (!signal?.aborted) {
          console.warn(didTimeout ? '[clarifyCaseContext] timed out' : '[clarifyCaseContext] fetch failed', {
            questionIndex,
            error: errorDetails(err),
          })
        }
        return fallbackCaseContextAnswer(config.interviewType)
      } finally {
        clearTimeout(timeoutId)
        if (signal && externalAbortListener) {
          signal.removeEventListener('abort', externalAbortListener)
        }
      }
    },
    [config, getSessionId],
  )

  return { generateQuestion, evaluateAnswer, callTurnRouter, answerCandidateQuestion, clarifyCaseContext, flowHintsRef }
}
