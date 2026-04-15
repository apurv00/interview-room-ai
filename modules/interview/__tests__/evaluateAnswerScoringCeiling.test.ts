/**
 * Work Item G.11 — evaluate-answer prompt score-ceiling swap.
 *
 * Validates that the scoring-guide block in the user prompt swaps
 * between the legacy "41-80 anchor + every-dim gate" copy and the
 * G.11 "calibrated distribution + 3-of-4 gate" copy based on the
 * `scoring_v2_ceiling` flag. Captures the actual prompt sent to
 * the model and asserts on its contents — the cleanest way to
 * verify a prompt change without an LLM call.
 *
 * Behavior invariants held across both paths:
 *   - All 5 score bands (0-20, 21-40, 41-60, 61-80, 81-100) remain
 *     documented in either prompt.
 *   - The "every dimension" gate appears ONLY in the OFF path.
 *   - The 3-of-4 calibration appears ONLY in the ON path.
 *   - The "41-80 anchor" (bias phrase) appears ONLY in the OFF path.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'
import { NextRequest } from 'next/server'

const { mockCompletionStream, mockIsFeatureEnabled } = vi.hoisted(() => ({
  mockCompletionStream: vi.fn(),
  mockIsFeatureEnabled: vi.fn(),
}))

vi.mock('@shared/middleware/composeApiRoute', () => ({
  composeApiRoute: (opts: {
    schema?: { parse: (x: unknown) => unknown }
    handler: (
      req: NextRequest,
      ctx: { user: unknown; body: unknown; params: Record<string, string> },
    ) => Promise<Response>
  }) => async (req: NextRequest) => {
    const raw = await req.json()
    const body = opts.schema ? opts.schema.parse(raw) : raw
    return opts.handler(req, {
      user: { id: 'test-user-1', role: 'candidate', plan: 'free', email: 't@example.com' },
      body,
      params: {},
    })
  },
}))

vi.mock('@shared/logger', () => ({
  aiLogger: { warn: vi.fn(), error: vi.fn(), info: vi.fn(), debug: vi.fn() },
  logger: { warn: vi.fn(), error: vi.fn(), info: vi.fn(), debug: vi.fn() },
}))

vi.mock('@shared/services/modelRouter', () => ({
  completion: mockCompletionStream,
  completionStream: mockCompletionStream,
}))

vi.mock('@shared/services/usageTracking', () => ({
  trackUsage: vi.fn().mockResolvedValue(undefined),
}))

vi.mock('@shared/db/connection', () => ({
  connectDB: vi.fn().mockResolvedValue(undefined),
}))

vi.mock('@shared/db/models', () => ({
  User: { findById: () => ({ select: () => ({ lean: () => Promise.resolve(null) }) }) },
  InterviewDepth: { findOne: () => ({ lean: () => Promise.resolve(null) }) },
}))

vi.mock('@shared/db/seed', () => ({
  FALLBACK_DEPTHS: [
    {
      slug: 'screening',
      evaluationCriteria: '',
      scoringDimensions: [
        { name: 'relevance', label: 'Relevance', weight: 0.25 },
        { name: 'structure', label: 'STAR', weight: 0.25 },
        { name: 'specificity', label: 'Specificity', weight: 0.25 },
        { name: 'ownership', label: 'Ownership', weight: 0.25 },
      ],
    },
  ],
}))

vi.mock('@shared/featureFlags', () => ({
  isFeatureEnabled: (flag: string) => mockIsFeatureEnabled(flag),
}))

vi.mock('@shared/services/promptSecurity', () => ({
  DATA_BOUNDARY_RULE: '',
  JSON_OUTPUT_RULE: '',
}))

vi.mock('@interview/config/interviewConfig', () => ({
  getDomainLabel: () => 'Product Manager',
}))

vi.mock('@interview/services/core/skillLoader', () => ({
  getSkillSections: vi.fn().mockResolvedValue(null),
}))

vi.mock('@interview/config/companyProfiles', () => ({
  findCompanyProfile: () => null,
}))

vi.mock('@interview/services/eval/evaluationEngine', () => ({
  getScoringDimensions: vi.fn().mockResolvedValue([]),
  buildRubricPromptSection: () => '',
}))

vi.mock('@interview/services/persona/documentContextCache', () => ({
  getOrLoadJDContext: vi.fn().mockResolvedValue(null),
  getOrLoadResumeContext: vi.fn().mockResolvedValue(null),
}))

vi.mock('@interview/services/core/sessionConfigCache', () => ({
  getOrLoadSessionConfig: vi.fn().mockResolvedValue(null),
}))

import { POST } from '@/app/api/evaluate-answer/route'

const validScores = JSON.stringify({
  relevance: 75, structure: 70, specificity: 65, ownership: 80,
  shouldProbe: false, probeType: null, probeTarget: null, isPivot: false,
})

function completionResult(text: string, truncated = false) {
  return {
    text,
    model: 'test-model',
    provider: 'test-provider',
    inputTokens: 100,
    outputTokens: 120,
    usedFallback: false,
    truncated,
  }
}

function makeRequest() {
  return new NextRequest('http://localhost:3000/api/evaluate-answer', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      config: { role: 'pm', experience: '0-2', duration: 30, interviewType: 'screening' },
      question: 'Tell me about a time you resolved a conflict.',
      answer: 'I led a 3-person team through a blocked release by negotiating a staged rollout.',
      questionIndex: 0,
      sessionId: '507f1f77bcf86cd799439011',
    }),
  })
}

async function runAndCaptureUserPrompt(flagOn: boolean): Promise<string> {
  mockIsFeatureEnabled.mockReset()
  mockIsFeatureEnabled.mockImplementation((flag: string) =>
    flagOn ? flag === 'scoring_v2_ceiling' : false,
  )

  let capturedUserPrompt = ''
  mockCompletionStream.mockImplementationOnce(async (opts: { messages: Array<{ content: string }> }) => {
    capturedUserPrompt = opts.messages[0]?.content || ''
    return completionResult(validScores)
  })

  await POST(makeRequest())
  return capturedUserPrompt
}

describe('POST /api/evaluate-answer — G.11 scoring ceiling prompt swap', () => {
  beforeEach(() => {
    mockCompletionStream.mockReset()
    mockIsFeatureEnabled.mockReset()
  })

  describe('flag OFF (legacy prompt)', () => {
    it('includes the "Most real answers fall in 41–80" anchor', async () => {
      const prompt = await runAndCaptureUserPrompt(false)
      expect(prompt).toContain('Most real answers fall in 41–80')
    })

    it('includes the "genuinely strong on every dimension" gate', async () => {
      const prompt = await runAndCaptureUserPrompt(false)
      expect(prompt).toContain('genuinely strong on every dimension')
    })

    it('does NOT contain the G.11 "3 of 4 dimensions" language', async () => {
      const prompt = await runAndCaptureUserPrompt(false)
      expect(prompt).not.toContain('3 of 4 dimensions')
    })

    it('does NOT contain the G.11 "do not cluster" language', async () => {
      const prompt = await runAndCaptureUserPrompt(false)
      expect(prompt).not.toContain('do not cluster')
    })
  })

  describe('flag ON (G.11 prompt)', () => {
    it('removes the "Most real answers fall in 41–80" anchor', async () => {
      const prompt = await runAndCaptureUserPrompt(true)
      expect(prompt).not.toContain('Most real answers fall in 41–80')
    })

    it('removes the "genuinely strong on every dimension" gate', async () => {
      const prompt = await runAndCaptureUserPrompt(true)
      expect(prompt).not.toContain('genuinely strong on every dimension')
    })

    it('includes the "3 of 4 dimensions" calibration', async () => {
      const prompt = await runAndCaptureUserPrompt(true)
      expect(prompt).toContain('3 of 4 dimensions are excellent')
    })

    it('includes the "do not cluster answers in 55-75" instruction', async () => {
      const prompt = await runAndCaptureUserPrompt(true)
      expect(prompt).toContain('do not cluster answers in 55–75')
    })

    it('includes the "85-92" calibration example', async () => {
      const prompt = await runAndCaptureUserPrompt(true)
      expect(prompt).toContain('85–92')
    })
  })

  describe('invariants — both paths', () => {
    it('both prompts document all 5 score bands', async () => {
      for (const flagOn of [false, true]) {
        const prompt = await runAndCaptureUserPrompt(flagOn)
        expect(prompt).toContain('0–20')
        expect(prompt).toContain('21–40')
        expect(prompt).toContain('41–60')
        expect(prompt).toContain('61–80')
        expect(prompt).toContain('81–100')
      }
    })

    it('both prompts still ask for the JSON output schema', async () => {
      for (const flagOn of [false, true]) {
        const prompt = await runAndCaptureUserPrompt(flagOn)
        // JSON_OUTPUT_RULE is mocked to '' in this test harness but
        // the dimension schema text still appears via dimensionSchema.
        expect(prompt).toContain('relevance')
        expect(prompt).toContain('structure')
      }
    })
  })
})
