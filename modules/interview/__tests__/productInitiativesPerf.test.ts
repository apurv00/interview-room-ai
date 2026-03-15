import { describe, it, expect } from 'vitest'
import {
  computePerformanceSignal,
  buildThreadSummary,
} from '../hooks/interviewUtils'
import { GenerateQuestionSchema, AnswerEvaluationSchema } from '@interview/validators/interview'
import type { AnswerEvaluation, ThreadEntry } from '@shared/types'

// ─── Helpers ────────────────────────────────────────────────────────────────

function makeEval(index: number): AnswerEvaluation {
  return {
    questionIndex: index,
    question: `Question ${index}`,
    answer: `Answer ${index}`,
    relevance: 60 + (index % 20),
    structure: 55 + (index % 25),
    specificity: 50 + (index % 30),
    ownership: 65 + (index % 15),
    needsFollowUp: false,
    flags: [],
  }
}

function makeThreadEntry(index: number): ThreadEntry {
  return {
    role: index % 2 === 0 ? 'interviewer' : 'candidate',
    text: `Entry ${index} with some realistic length text that simulates a real conversation turn`,
    isProbe: index > 1 && index % 3 === 0,
    probeType: index % 3 === 0 ? 'clarify' : undefined,
    probeDepth: index > 1 ? Math.floor(index / 3) : 0,
  }
}

// ─── Performance Tests ──────────────────────────────────────────────────────

describe('Performance', () => {
  describe('computePerformanceSignal', () => {
    it('handles 1000 evaluations within 10ms', () => {
      const evals = Array.from({ length: 1000 }, (_, i) => makeEval(i))
      const start = performance.now()
      const result = computePerformanceSignal(evals)
      const elapsed = performance.now() - start
      expect(elapsed).toBeLessThan(10)
      expect(['calibrating', 'struggling', 'on_track', 'strong']).toContain(result)
    })

    it('handles 10000 evaluations within 50ms', () => {
      const evals = Array.from({ length: 10000 }, (_, i) => makeEval(i))
      const start = performance.now()
      const result = computePerformanceSignal(evals)
      const elapsed = performance.now() - start
      expect(elapsed).toBeLessThan(50)
      expect(['calibrating', 'struggling', 'on_track', 'strong']).toContain(result)
    })
  })

  describe('buildThreadSummary', () => {
    it('handles thread with 50 entries within 5ms', () => {
      const thread = Array.from({ length: 50 }, (_, i) => makeThreadEntry(i))
      const evals = Array.from({ length: 10 }, (_, i) => makeEval(i))

      const start = performance.now()
      const result = buildThreadSummary(0, 'Test topic', thread, evals)
      const elapsed = performance.now() - start

      expect(elapsed).toBeLessThan(5)
      expect(result.topicIndex).toBe(0)
      expect(result.topicQuestion).toBe('Test topic')
    })

    it('builds 20 summaries (10 entries each) within 15ms', () => {
      const start = performance.now()

      for (let t = 0; t < 20; t++) {
        const thread = Array.from({ length: 10 }, (_, i) => makeThreadEntry(i))
        const evals = Array.from({ length: 3 }, (_, i) => makeEval(i))
        buildThreadSummary(t, `Topic ${t}`, thread, evals)
      }

      const elapsed = performance.now() - start
      expect(elapsed).toBeLessThan(15)
    })
  })

  describe('Validator performance', () => {
    it('parses GenerateQuestionSchema with full completedThreads within 10ms', () => {
      const completedThreads = Array.from({ length: 20 }, (_, i) => ({
        topicIndex: i,
        topicQuestion: `Topic question ${i} with realistic length`,
        summary: `Summary of topic ${i} covering main points discussed`,
        avgScore: 65 + (i % 20),
        probeCount: i % 3,
        probeTypes: i % 3 > 0 ? ['clarify', 'expand'].slice(0, i % 3) : [],
      }))

      const input = {
        config: {
          role: 'SWE',
          experience: '3-6' as const,
          duration: 30 as const,
        },
        questionIndex: 5,
        previousQA: Array.from({ length: 10 }, (_, i) => ({
          speaker: i % 2 === 0 ? 'interviewer' as const : 'candidate' as const,
          text: `Conversation entry ${i} with realistic text`,
          timestamp: Date.now() + i * 1000,
        })),
        performanceSignal: 'on_track' as const,
        lastThreadSummary: completedThreads[completedThreads.length - 1],
        completedThreads,
      }

      const start = performance.now()
      const result = GenerateQuestionSchema.safeParse(input)
      const elapsed = performance.now() - start

      expect(elapsed).toBeLessThan(10)
      expect(result.success).toBe(true)
    })

    it('parses 100 evaluations through schema within 50ms', () => {
      const evaluations = Array.from({ length: 100 }, (_, i) => ({
        questionIndex: i,
        question: `Question ${i}`,
        answer: `Answer ${i} with some detail`,
        relevance: 70,
        structure: 65,
        specificity: 60,
        ownership: 75,
        needsFollowUp: false,
        flags: [],
        probeDecision: {
          shouldProbe: i % 3 === 0,
          probeType: 'clarify' as const,
          probeQuestion: 'Can you elaborate?',
        },
        pushback: i % 5 === 0 ? {
          line: 'Could you be more specific?',
          targetDimension: 'specificity',
          tone: 'curious' as const,
        } : undefined,
      }))

      const start = performance.now()
      for (const eval_ of evaluations) {
        AnswerEvaluationSchema.safeParse(eval_)
      }
      const elapsed = performance.now() - start

      expect(elapsed).toBeLessThan(50)
    })
  })
})
