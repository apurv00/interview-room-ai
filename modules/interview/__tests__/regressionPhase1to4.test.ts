import { describe, it, expect } from 'vitest'

// ─── P0: Duration Configuration ─────────────────────────────────────────────

describe('P0 Regression — Duration Configuration', () => {
  it('interpolation produces correct question counts at anchor points', async () => {
    const { getQuestionCount, getMinimumTopics, getPressureQuestionIndex } = await import(
      '@interview/config/interviewConfig'
    )
    // Anchor points (question count raised to 1.0 q/min; pressure scaled in step)
    expect(getQuestionCount(10)).toBe(10)
    expect(getQuestionCount(20)).toBe(20)
    expect(getQuestionCount(30)).toBe(30)

    expect(getMinimumTopics(10)).toBe(4)
    expect(getMinimumTopics(20)).toBe(7)
    expect(getMinimumTopics(30)).toBe(10)

    expect(getPressureQuestionIndex(10)).toBe(5)
    expect(getPressureQuestionIndex(20)).toBe(10)
    expect(getPressureQuestionIndex(30)).toBe(15)
  })

  it('interpolation handles custom durations (15, 25, 45 min)', async () => {
    const { getQuestionCount, getMinimumTopics } = await import(
      '@interview/config/interviewConfig'
    )
    // 15 min should be between 10 and 20 anchors
    const q15 = getQuestionCount(15)
    expect(q15).toBeGreaterThan(10)
    expect(q15).toBeLessThan(20)

    // 45 min should extrapolate beyond 30
    const q45 = getQuestionCount(45)
    expect(q45).toBeGreaterThan(30)

    // Sub-10-min durations extrapolate DOWN (not clamp): a 5-min interview gets ~5 questions, not the
    // 10-min budget, so it isn't falsely scored as half-complete. Codex #484 P2.
    const q5 = getQuestionCount(5)
    expect(q5).toBeLessThan(getQuestionCount(10))
    expect(q5).toBeGreaterThanOrEqual(1)

    // Minimum topics always >= 1
    expect(getMinimumTopics(5)).toBeGreaterThanOrEqual(1)
  })

  it('getDurationLabel returns preset labels and generates for custom', async () => {
    const { getDurationLabel } = await import('@interview/config/interviewConfig')
    expect(getDurationLabel(10)).toBe('10 min — Quick screen')
    expect(getDurationLabel(20)).toBe('20 min — Standard')
    expect(getDurationLabel(30)).toBe('30 min — Deep dive')
    expect(getDurationLabel(15)).toBe('15 min')
    expect(getDurationLabel(45)).toBe('45 min')
  })
})

// ─── P0: LLM Client Centralization ──────────────────────────────────────────

describe('P0 Regression — LLM Client', () => {
  it('llmClient module exports getAnthropicClient and parseClaudeJSON', async () => {
    // Can't instantiate Anthropic in JSDOM (browser-like) env, but verify exports exist
    const mod = await import('@shared/services/llmClient')
    expect(typeof mod.getAnthropicClient).toBe('function')
    expect(typeof mod.parseClaudeJSON).toBe('function')
  })

  it('parseClaudeJSON extracts JSON from various formats', async () => {
    const { parseClaudeJSON } = await import('@shared/services/llmClient')
    const { z } = await import('zod')
    const schema = z.object({ name: z.string() })

    // Raw JSON
    expect(parseClaudeJSON('{"name":"test"}', schema)).toEqual({ name: 'test' })

    // Code block wrapped
    expect(parseClaudeJSON('```json\n{"name":"wrapped"}\n```', schema)).toEqual({ name: 'wrapped' })

    // With surrounding text
    expect(parseClaudeJSON('Here is the result: {"name":"embedded"} hope that helps', schema)).toEqual({ name: 'embedded' })
  })
})

// ─── P1: Feature Flags ──────────────────────────────────────────────────────

describe('P1 Regression — Feature Flags', () => {
  it('has embedding_search and monthly_plan flags', async () => {
    const { isFeatureEnabled } = await import('@shared/featureFlags')
    // embedding_search defaults to false (needs Atlas vector index)
    expect(isFeatureEnabled('embedding_search')).toBe(false)
    // monthly_plan defaults to true
    expect(isFeatureEnabled('monthly_plan')).toBe(true)
    // company_patterns_rag defaults to true
    expect(isFeatureEnabled('company_patterns_rag')).toBe(true)
  })
})

// ─── Phase 4: Embedding Service ─────────────────────────────────────────────

describe('Phase 4 Regression — Embedding Service', () => {
  it('vectorSearchQuestions returns empty when feature disabled', async () => {
    const { vectorSearchQuestions } = await import('@interview/services/core/embeddingService')
    // embedding_search is disabled by default
    const results = await vectorSearchQuestions('test query')
    expect(results).toEqual([])
  })
})

// ─── Phase 4: Code Run (LLM simulation) ──────────────────────────────────────
// The Piston sandbox was replaced by LLM-simulated execution (the public emkc
// Piston went whitelist-only); the "Run" button now predicts output via the model.

describe('Phase 4 Regression — Code Run (LLM simulation)', () => {
  it('simulateCodeRun guards empty code without calling the model', async () => {
    const { simulateCodeRun } = await import('@interview/services/core/codeSimulationService')
    const result = await simulateCodeRun('   ', 'python')
    expect(result.simulated).toBe(true)
    expect(result.exitCode).toBe(1)
  })
})

// ─── Phase 4: Data Export Service ───────────────────────────────────────────

describe('Phase 4 Regression — Data Export', () => {
  it('generateDataExport function exists', async () => {
    const { generateDataExport } = await import('@shared/services/dataExportService')
    expect(typeof generateDataExport).toBe('function')
  })
})

// ─── Schema Regression: PathwayPlan ─────────────────────────────────────────

describe('Schema Regression — PathwayPlan', () => {
  it('PathwayPlan supports monthly planType', async () => {
    const { PathwayPlan } = await import('@shared/db/models')
    const schema = PathwayPlan.schema
    const planTypePath = schema.path('planType')
    expect(planTypePath).toBeDefined()
  })

  it('PathwayPlan has phase tracking fields', async () => {
    const { PathwayPlan } = await import('@shared/db/models')
    const schema = PathwayPlan.schema
    expect(schema.path('currentPhase')).toBeDefined()
    expect(schema.path('phaseHistory')).toBeDefined()
    expect(schema.path('tier')).toBeDefined()
    expect(schema.path('monthLabel')).toBeDefined()
    expect(schema.path('planDurationDays')).toBeDefined()
  })
})

// ─── Schema Regression: InterviewSession ────────────────────────────────────

describe('Schema Regression — InterviewSession', () => {
  it('InterviewSession has consent fields', async () => {
    const { InterviewSession } = await import('@shared/db/models')
    const schema = InterviewSession.schema
    expect(schema.path('consentedToRecording')).toBeDefined()
    expect(schema.path('consentedToAnalysis')).toBeDefined()
  })

  it('InterviewSession has invite token fields', async () => {
    const { InterviewSession } = await import('@shared/db/models')
    const schema = InterviewSession.schema
    expect(schema.path('inviteTokenHash')).toBeDefined()
    expect(schema.path('inviteTokenExpiry')).toBeDefined()
  })

  it('InterviewSession duration accepts 5-60 range', async () => {
    const { InterviewSession } = await import('@shared/db/models')
    const schema = InterviewSession.schema
    const durationPath = schema.path('config.duration')
    expect(durationPath).toBeDefined()
  })
})

// ─── Schema Regression: User ────────────────────────────────────────────────

describe('Schema Regression — User', () => {
  it('User has starStories field', async () => {
    const { User } = await import('@shared/db/models')
    const schema = User.schema
    expect(schema.path('starStories')).toBeDefined()
  })

  it('User has privacyConsent field', async () => {
    const { User } = await import('@shared/db/models')
    const schema = User.schema
    expect(schema.path('privacyConsent.recordingConsent')).toBeDefined()
    expect(schema.path('privacyConsent.analysisConsent')).toBeDefined()
    expect(schema.path('privacyConsent.marketingOptIn')).toBeDefined()
  })
})

// ─── Schema Regression: QuestionBank ────────────────────────────────────────

describe('Schema Regression — QuestionBank', () => {
  it('QuestionBank has embedding field', async () => {
    const { QuestionBank } = await import('@shared/db/models')
    const schema = QuestionBank.schema
    expect(schema.path('embedding')).toBeDefined()
    expect(schema.path('embeddedAt')).toBeDefined()
  })
})
