import { describe, it, expect } from 'vitest'
import {
  GenerateQuestionSchema,
  EvaluateAnswerSchema,
  AnswerEvaluationSchema,
  GenerateFeedbackSchema,
  UpdateSessionSchema,
} from '../validators/interview'
import { getMainQuestionBudget } from '../config/interviewConfig'
import type { Duration } from '@shared/types'

// After the main-question / exchange-index decouple (2026-07-03), `qIdx` (the API
// `questionIndex`) keeps incrementing per probe/pivot/deferred turn and is NO LONGER bounded by
// getQuestionCount. The validators must therefore accept exchange indices well above the question
// count for long sessions, or generate/evaluate/persist calls 400 mid-interview (Codex PR #495 P1).
describe('questionIndex exchange-index bound accommodates the decoupled loop', () => {
  // Structural worst case: the longest supported interview (60 min → duration.max in the request
  // schema) with heavy probing. getMainQuestionBudget(60) main topics, each costing up to ~5 probes
  // + a pivot + the advance, plus a couple of deferred bridges.
  const MAX_DURATION = 60 as Duration
  const MAX_PROBES_PER_TOPIC = 5 // case-study type fallback (the largest)
  const worstCaseExchangeIndex =
    getMainQuestionBudget(MAX_DURATION) * (MAX_PROBES_PER_TOPIC + 2) + 4

  const fields = [
    ['GenerateQuestionSchema', GenerateQuestionSchema.shape.questionIndex],
    ['EvaluateAnswerSchema', EvaluateAnswerSchema.shape.questionIndex],
    ['AnswerEvaluationSchema', AnswerEvaluationSchema.shape.questionIndex],
  ] as const

  it('the worst-case exchange index is above the OLD cap of 100 (regression proof)', () => {
    expect(worstCaseExchangeIndex).toBeGreaterThan(100)
  })

  it.each(fields)('%s accepts the worst-case exchange index', (_name, field) => {
    expect(field.safeParse(worstCaseExchangeIndex).success).toBe(true)
  })

  it.each(fields)('%s still accepts a realistic long-session index (200) and 0', (_name, field) => {
    expect(field.safeParse(200).success).toBe(true)
    expect(field.safeParse(0).success).toBe(true)
  })

  it.each(fields)('%s still rejects garbage (negative and absurdly large)', (_name, field) => {
    expect(field.safeParse(-1).success).toBe(false)
    expect(field.safeParse(100_000).success).toBe(false)
  })
})

// answeredCount = evaluations.length (intro + main + probe answers) and wasTruncatedByTimer (one
// flag per answer) scale with total interactions, not the question count. finishInterview sends both
// to /api/generate-feedback and the session PATCH, so their caps must track the exchange bound too or
// long probed sessions are rejected at completion — losing DB persistence and feedback (Codex #495 P1).
describe('completion-count fields accept long/probed sessions', () => {
  const worstCaseAnswered = getMainQuestionBudget(60 as Duration) * 7 + 4 // ~417

  const countFields = [
    ['GenerateFeedback.answeredCount', GenerateFeedbackSchema.shape.answeredCount],
    ['UpdateSession.answeredCount', UpdateSessionSchema.shape.answeredCount],
  ] as const

  it.each(countFields)('%s accepts the worst-case answered count', (_name, field) => {
    expect(field.safeParse(worstCaseAnswered).success).toBe(true)
    expect(worstCaseAnswered).toBeGreaterThan(100) // above the OLD cap
  })

  const flagArrayFields = [
    ['GenerateFeedback.wasTruncatedByTimer', GenerateFeedbackSchema.shape.wasTruncatedByTimer],
    ['UpdateSession.wasTruncatedByTimer', UpdateSessionSchema.shape.wasTruncatedByTimer],
  ] as const

  it.each(flagArrayFields)('%s accepts one flag per answer on a long session', (_name, field) => {
    const flags = Array.from({ length: worstCaseAnswered }, () => false)
    expect(field.safeParse(flags).success).toBe(true)
  })
})
