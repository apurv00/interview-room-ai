import { describe, it, expect } from 'vitest'
import {
  AnswerEvaluationSchema,
  GenerateQuestionSchema,
  EvaluateAnswerSchema,
} from '@interview/validators/interview'

// ─── Helpers ────────────────────────────────────────────────────────────────

const baseEvaluation = {
  questionIndex: 0,
  question: 'Tell me about a challenge',
  answer: 'I faced a challenge when...',
  relevance: 75,
  structure: 70,
  specificity: 65,
  ownership: 80,
  needsFollowUp: false,
  flags: [],
}

const baseGenerateQuestion = {
  config: {
    role: 'SWE',
    experience: '3-6' as const,
    duration: 20 as const,
  },
  questionIndex: 1,
  previousQA: [],
}

const baseEvaluateAnswer = {
  config: {
    role: 'SWE',
    experience: '3-6' as const,
    duration: 20 as const,
  },
  question: 'Tell me about...',
  answer: 'I once had to...',
  questionIndex: 0,
}

// ─── ProbeDecision (via AnswerEvaluationSchema) ─────────────────────────────

describe('ProbeDecision validation', () => {
  it('accepts valid probeDecision with all fields', () => {
    const result = AnswerEvaluationSchema.safeParse({
      ...baseEvaluation,
      probeDecision: {
        shouldProbe: true,
        probeType: 'clarify',
        probeQuestion: 'Can you give a specific example?',
        probingRationale: 'Answer was vague',
      },
    })
    expect(result.success).toBe(true)
  })

  it('accepts probeDecision with only shouldProbe', () => {
    const result = AnswerEvaluationSchema.safeParse({
      ...baseEvaluation,
      probeDecision: { shouldProbe: false },
    })
    expect(result.success).toBe(true)
  })

  it('rejects invalid probeType', () => {
    const result = AnswerEvaluationSchema.safeParse({
      ...baseEvaluation,
      probeDecision: {
        shouldProbe: true,
        probeType: 'invalid_type',
      },
    })
    expect(result.success).toBe(false)
  })

  it('accepts all valid probeTypes', () => {
    for (const probeType of ['clarify', 'challenge', 'expand', 'quantify']) {
      const result = AnswerEvaluationSchema.safeParse({
        ...baseEvaluation,
        probeDecision: { shouldProbe: true, probeType },
      })
      expect(result.success).toBe(true)
    }
  })

  it('enforces probeQuestion max 2000 chars', () => {
    const result = AnswerEvaluationSchema.safeParse({
      ...baseEvaluation,
      probeDecision: {
        shouldProbe: true,
        probeQuestion: 'x'.repeat(2001),
      },
    })
    expect(result.success).toBe(false)
  })

  it('enforces probingRationale max 1000 chars', () => {
    const result = AnswerEvaluationSchema.safeParse({
      ...baseEvaluation,
      probeDecision: {
        shouldProbe: true,
        probingRationale: 'x'.repeat(1001),
      },
    })
    expect(result.success).toBe(false)
  })

  it('evaluation is valid without probeDecision (backward compat)', () => {
    const result = AnswerEvaluationSchema.safeParse(baseEvaluation)
    expect(result.success).toBe(true)
  })
})

// ─── Pushback (via AnswerEvaluationSchema) ──────────────────────────────────

describe('Pushback validation', () => {
  it('accepts valid pushback', () => {
    const result = AnswerEvaluationSchema.safeParse({
      ...baseEvaluation,
      pushback: {
        line: 'Could you walk me through a specific instance?',
        targetDimension: 'specificity',
        tone: 'curious',
      },
    })
    expect(result.success).toBe(true)
  })

  it('accepts all valid tones', () => {
    for (const tone of ['curious', 'probing', 'encouraging']) {
      const result = AnswerEvaluationSchema.safeParse({
        ...baseEvaluation,
        pushback: { line: 'Test', targetDimension: 'test', tone },
      })
      expect(result.success).toBe(true)
    }
  })

  it('rejects invalid tone', () => {
    const result = AnswerEvaluationSchema.safeParse({
      ...baseEvaluation,
      pushback: { line: 'Test', targetDimension: 'test', tone: 'aggressive' },
    })
    expect(result.success).toBe(false)
  })

  it('enforces line max 1000 chars', () => {
    const result = AnswerEvaluationSchema.safeParse({
      ...baseEvaluation,
      pushback: { line: 'x'.repeat(1001), targetDimension: 'test', tone: 'curious' },
    })
    expect(result.success).toBe(false)
  })

  it('enforces targetDimension max 100 chars', () => {
    const result = AnswerEvaluationSchema.safeParse({
      ...baseEvaluation,
      pushback: { line: 'Test', targetDimension: 'x'.repeat(101), tone: 'curious' },
    })
    expect(result.success).toBe(false)
  })

  it('evaluation is valid without pushback (backward compat)', () => {
    const result = AnswerEvaluationSchema.safeParse(baseEvaluation)
    expect(result.success).toBe(true)
  })
})

// ─── ThreadSummary (via GenerateQuestionSchema) ─────────────────────────────

describe('ThreadSummary validation in GenerateQuestionSchema', () => {
  const threadSummary = {
    topicIndex: 0,
    topicQuestion: 'Tell me about a time you led a team',
    summary: 'Discussed leadership experience',
    avgScore: 72,
    probeCount: 1,
    probeTypes: ['clarify'],
  }

  it('accepts valid lastThreadSummary', () => {
    const result = GenerateQuestionSchema.safeParse({
      ...baseGenerateQuestion,
      lastThreadSummary: threadSummary,
    })
    expect(result.success).toBe(true)
  })

  it('accepts valid completedThreads array', () => {
    const result = GenerateQuestionSchema.safeParse({
      ...baseGenerateQuestion,
      completedThreads: [threadSummary, { ...threadSummary, topicIndex: 1 }],
    })
    expect(result.success).toBe(true)
  })

  it('enforces completedThreads max 20 items', () => {
    const threads = Array.from({ length: 21 }, (_, i) => ({ ...threadSummary, topicIndex: i }))
    const result = GenerateQuestionSchema.safeParse({
      ...baseGenerateQuestion,
      completedThreads: threads,
    })
    expect(result.success).toBe(false)
  })

  it('valid without thread data (backward compat)', () => {
    const result = GenerateQuestionSchema.safeParse(baseGenerateQuestion)
    expect(result.success).toBe(true)
  })
})

// ─── GenerateQuestionSchema extensions ──────────────────────────────────────

describe('GenerateQuestionSchema extensions', () => {
  it('accepts valid performanceSignal', () => {
    for (const signal of ['calibrating', 'struggling', 'on_track', 'strong']) {
      const result = GenerateQuestionSchema.safeParse({
        ...baseGenerateQuestion,
        performanceSignal: signal,
      })
      expect(result.success).toBe(true)
    }
  })

  it('rejects invalid performanceSignal', () => {
    const result = GenerateQuestionSchema.safeParse({
      ...baseGenerateQuestion,
      performanceSignal: 'excellent',
    })
    expect(result.success).toBe(false)
  })

  it('accepts all new fields together', () => {
    const result = GenerateQuestionSchema.safeParse({
      ...baseGenerateQuestion,
      performanceSignal: 'strong',
      lastThreadSummary: {
        topicIndex: 0,
        topicQuestion: 'Test',
        summary: 'Summary',
        avgScore: 80,
        probeCount: 0,
        probeTypes: [],
      },
      completedThreads: [{
        topicIndex: 0,
        topicQuestion: 'Test',
        summary: 'Summary',
        avgScore: 80,
        probeCount: 0,
        probeTypes: [],
      }],
    })
    expect(result.success).toBe(true)
  })

  it('all new fields are optional (backward compat)', () => {
    const result = GenerateQuestionSchema.safeParse(baseGenerateQuestion)
    expect(result.success).toBe(true)
  })
})

// ─── EvaluateAnswerSchema extensions ────────────────────────────────────────

describe('EvaluateAnswerSchema extensions', () => {
  it('accepts valid probeDepth', () => {
    const result = EvaluateAnswerSchema.safeParse({
      ...baseEvaluateAnswer,
      probeDepth: 2,
    })
    expect(result.success).toBe(true)
  })

  it('accepts probeDepth = 0', () => {
    const result = EvaluateAnswerSchema.safeParse({
      ...baseEvaluateAnswer,
      probeDepth: 0,
    })
    expect(result.success).toBe(true)
  })

  it('accepts probeDepth = 10', () => {
    const result = EvaluateAnswerSchema.safeParse({
      ...baseEvaluateAnswer,
      probeDepth: 10,
    })
    expect(result.success).toBe(true)
  })

  it('rejects probeDepth > 20', () => {
    const result = EvaluateAnswerSchema.safeParse({
      ...baseEvaluateAnswer,
      probeDepth: 21,
    })
    expect(result.success).toBe(false)
  })

  it('rejects negative probeDepth', () => {
    const result = EvaluateAnswerSchema.safeParse({
      ...baseEvaluateAnswer,
      probeDepth: -1,
    })
    expect(result.success).toBe(false)
  })

  it('valid without probeDepth (backward compat)', () => {
    const result = EvaluateAnswerSchema.safeParse(baseEvaluateAnswer)
    expect(result.success).toBe(true)
  })
})
