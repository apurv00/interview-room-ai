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
}

export interface PreviousAnswerSummary {
  question: string
  keyClaimsFromAnswer: string
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
}

/**
 * Encapsulates API calls for question generation and answer evaluation.
 */
export function useInterviewAPI({ config }: UseInterviewAPIOptions): UseInterviewAPIReturn {
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
    [config]
  )

  return { generateQuestion, evaluateAnswer }
}
