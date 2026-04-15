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
}

/**
 * Encapsulates API calls for question generation and answer evaluation.
 */
export function useInterviewAPI({ config, getSessionId }: UseInterviewAPIOptions): UseInterviewAPIReturn {
  const usedFallbackIndicesRef = useRef(new Set<number>())
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
            previousQA: transcript.slice(-10),
            performanceSignal,
            lastThreadSummary: lastThread,
            completedThreads: completedThreads.length > 0 ? completedThreads : undefined,
            sessionId: getSessionId?.() ?? undefined,
          }),
        })
        if (!res.ok) {
          console.error(`[generateQuestion] API returned ${res.status}`, await res.text().catch(() => ''))
          return getNextFallbackQuestion(usedFallbackIndicesRef.current)
        }
        const data = await res.json()
        if (data.flowHints) flowHintsRef.current = data.flowHints as FlowHints
        return data.question as string
      } catch (err) {
        console.error('[generateQuestion] fetch failed', err)
        return getNextFallbackQuestion(usedFallbackIndicesRef.current)
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
    ): Promise<AnswerEvaluation> => {
      const timeoutController = new AbortController()
      const timeoutId = setTimeout(() => timeoutController.abort(), 5000)
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
            sessionId: getSessionId?.() ?? undefined,
            // G.12: only include when true — keeps the body minimal and
            // the server's Zod schema treats absence = false.
            ...(wasTruncatedByTimer && { wasTruncatedByTimer: true }),
          }),
        })
        clearTimeout(timeoutId)
        if (!res.ok) {
          return {
            questionIndex: qIdx,
            question,
            answer,
            relevance: 60,
            structure: 55,
            specificity: 55,
            ownership: 60,
            probeDecision: { shouldProbe: false },
          }
        }
        return res.json()
      } catch (err) {
        clearTimeout(timeoutId)
        if (timeoutController.signal.aborted) {
          // Timeout — return quick fallback scores
          return {
            questionIndex: qIdx,
            question,
            answer,
            relevance: 50,
            structure: 50,
            specificity: 50,
            ownership: 50,
            probeDecision: { shouldProbe: false },
          }
        }
        return {
          questionIndex: qIdx,
          question,
          answer,
          relevance: 60,
          structure: 55,
          specificity: 55,
          ownership: 60,
          probeDecision: { shouldProbe: false },
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
          body: JSON.stringify({ question, answer, probeDepth, questionIndex, interviewType, interruptContext }),
        })
        if (!res.ok) return TURN_ROUTER_FALLBACK
        return (await res.json()) as TurnRouterResult
      } catch {
        return TURN_ROUTER_FALLBACK
      }
    },
    [], // no deps — pure fetch
  )

  return { generateQuestion, evaluateAnswer, callTurnRouter, flowHintsRef }
}
