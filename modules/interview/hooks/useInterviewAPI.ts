'use client'

import { useCallback } from 'react'
import type {
  InterviewConfig,
  TranscriptEntry,
  AnswerEvaluation,
  PerformanceSignal,
  ThreadSummary,
} from '@shared/types'

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
  keyClaimsFromAnswer: string
}

export interface TurnRouterResult {
  nextAction: 'probe' | 'advance'
  probeQuestion?: string
  style: 'curious' | 'probing' | 'encouraging' | 'neutral'
  isNonsensical: boolean
  isPivot: boolean
}

export interface UseInterviewAPIReturn {
  generateQuestion: (
    qIdx: number,
    transcript: TranscriptEntry[],
    performanceSignal: PerformanceSignal,
    completedThreads: ThreadSummary[],
    signal?: AbortSignal,
  ) => Promise<string>
  evaluateAnswer: (
    question: string,
    answer: string,
    qIdx: number,
    probeDepth?: number,
    signal?: AbortSignal,
    previousSummaries?: PreviousAnswerSummary[],
  ) => Promise<AnswerEvaluation>
  callTurnRouter: (params: {
    question: string
    answer: string
    probeDepth: number
    questionIndex: number
    interviewType: string
    signal?: AbortSignal
  }) => Promise<TurnRouterResult>
}

/**
 * Encapsulates API calls for question generation and answer evaluation.
 */
export function useInterviewAPI({ config, getSessionId }: UseInterviewAPIOptions): UseInterviewAPIReturn {
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
            previousQA: transcript,
            performanceSignal,
            lastThreadSummary: lastThread,
            completedThreads: completedThreads.length > 0 ? completedThreads : undefined,
            sessionId: getSessionId?.() ?? undefined,
          }),
        })
        const data = await res.json()
        return data.question as string
      } catch {
        return 'Tell me about a challenge you faced recently and how you handled it.'
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
          }),
        })
        clearTimeout(timeoutId)
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
            needsFollowUp: false,
            flags: ['Evaluation timed out — approximate scores'],
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
          needsFollowUp: false,
          flags: [],
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
    }: {
      question: string
      answer: string
      probeDepth: number
      questionIndex: number
      interviewType: string
      signal?: AbortSignal
    }): Promise<TurnRouterResult> => {
      try {
        const res = await fetch('/api/turn-router', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          signal,
          body: JSON.stringify({ question, answer, probeDepth, questionIndex, interviewType }),
        })
        if (!res.ok) return TURN_ROUTER_FALLBACK
        return (await res.json()) as TurnRouterResult
      } catch {
        return TURN_ROUTER_FALLBACK
      }
    },
    [], // no deps — pure fetch
  )

  return { generateQuestion, evaluateAnswer, callTurnRouter }
}
