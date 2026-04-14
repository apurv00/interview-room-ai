/**
 * Integration test for app/api/generate-question/route.ts JD overlay wiring.
 *
 * Phase 4 of Work Item E wires the JD overlay (built in Phases 1–3 + E.5)
 * into the live generate-question route. When the feature flag
 * `jd_flow_overlay` is off (default), the route must behave identically
 * to pre-Phase-4 — no overlay call, no logger emission, no extra Mongo
 * reads. When the flag is on AND a parsedJD is cached on the session,
 * the route computes an overlay via buildJDOverlayWithObservability and
 * passes it into resolveFlow.
 *
 * Mocks follow the same pattern as generateQuestionTruncation.test.ts:
 * passthrough composeApiRoute, stubbed DB, stubbed downstream helpers.
 * The feature flag + sessionConfigCache + @interview/flow seams are the
 * only ones whose behavior matters to these assertions.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'
import { NextRequest } from 'next/server'
import type { IParsedJobDescription, ParsedRequirement } from '@shared/db/models/SavedJobDescription'
import type { FlowTemplate, JDOverlay, ResolvedFlow } from '@interview/flow'

// ─── Hoisted mocks ─────────────────────────────────────────────────────────

const {
  mockCompletion,
  mockWarn,
  mockError,
  mockInfo,
  mockDebug,
  mockIsFeatureEnabled,
  mockGetSessionConfig,
  mockResolveFlow,
  mockBuildFlowPromptContext,
  mockBuildJDOverlay,
  mockTemplateRegistryGet,
} = vi.hoisted(() => ({
  mockCompletion: vi.fn(),
  mockWarn: vi.fn(),
  mockError: vi.fn(),
  mockInfo: vi.fn(),
  mockDebug: vi.fn(),
  mockIsFeatureEnabled: vi.fn(),
  mockGetSessionConfig: vi.fn(),
  mockResolveFlow: vi.fn(),
  mockBuildFlowPromptContext: vi.fn(),
  mockBuildJDOverlay: vi.fn(),
  mockTemplateRegistryGet: vi.fn(),
}))

// Passthrough composeApiRoute — mirrors the pattern from
// generateQuestionTruncation.test.ts
vi.mock('@shared/middleware/composeApiRoute', () => ({
  composeApiRoute: (opts: {
    schema?: { parse: (x: unknown) => unknown }
    handler: (
      req: NextRequest,
      ctx: { user: unknown; body: unknown; params: Record<string, string> },
    ) => Promise<Response>
  }) => {
    return async (req: NextRequest): Promise<Response> => {
      const raw = await req.json()
      const body = opts.schema ? opts.schema.parse(raw) : raw
      return opts.handler(req, {
        user: { id: 'test-user-1', role: 'candidate', plan: 'free', email: 't@example.com' },
        body,
        params: {},
      })
    }
  },
}))

vi.mock('@shared/logger', () => ({
  aiLogger: { warn: mockWarn, error: mockError, info: mockInfo, debug: mockDebug },
  logger: { warn: mockWarn, error: mockError, info: mockInfo, debug: mockDebug },
}))

vi.mock('@shared/services/modelRouter', () => ({
  completion: mockCompletion,
}))

vi.mock('@shared/services/usageTracking', () => ({
  trackUsage: vi.fn().mockResolvedValue(undefined),
}))

vi.mock('@shared/db/connection', () => ({
  connectDB: vi.fn().mockRejectedValue(new Error('test: no db')),
}))

vi.mock('@shared/db/models', () => ({
  User: { findById: () => ({ select: () => ({ lean: () => Promise.reject(new Error('test')) }) }) },
  InterviewDomain: { findOne: () => ({ lean: () => Promise.reject(new Error('test')) }) },
  InterviewDepth: { findOne: () => ({ lean: () => Promise.reject(new Error('test')) }) },
}))

vi.mock('@shared/db/seed', () => ({
  FALLBACK_DOMAINS: [],
  FALLBACK_DEPTHS: [],
}))

vi.mock('@shared/featureFlags', () => ({
  isFeatureEnabled: (flag: string) => mockIsFeatureEnabled(flag),
}))

vi.mock('@shared/services/promptSecurity', () => ({
  DATA_BOUNDARY_RULE: '',
}))

vi.mock('@interview/services/core/skillLoader', () => ({
  getSkillSections: vi.fn().mockResolvedValue(null),
  selectSkillQuestions: vi.fn().mockResolvedValue(null),
}))

vi.mock('@interview/config/companyProfiles', () => ({
  findCompanyProfile: () => null,
  buildCompanyPromptContext: () => '',
}))

vi.mock('@interview/services/persona/personalizationEngine', () => ({
  generateSessionBrief: vi.fn().mockRejectedValue(new Error('test')),
  briefToPromptContext: () => '',
}))

vi.mock('@interview/services/persona/retrievalService', () => ({
  getQuestionBankContext: vi.fn().mockResolvedValue(''),
}))

vi.mock('@interview/services/persona/documentContextCache', () => ({
  getOrLoadJDContext: vi.fn().mockResolvedValue(null),
  getOrLoadResumeContext: vi.fn().mockResolvedValue(null),
}))

vi.mock('@interview/services/core/sessionConfigCache', () => ({
  getOrLoadSessionConfig: (...args: unknown[]) => mockGetSessionConfig(...args),
}))

// Mock @interview/flow module so we can spy on resolveFlow + the overlay
// builder. makeTemplateKey + PHASE_WEIGHTS stay as identity helpers so the
// route code under test can compose keys normally.
vi.mock('@interview/flow', () => ({
  resolveFlow: (...args: unknown[]) => mockResolveFlow(...args),
  buildFlowPromptContext: (...args: unknown[]) => mockBuildFlowPromptContext(...args),
  buildJDOverlayWithObservability: (...args: unknown[]) => mockBuildJDOverlay(...args),
  makeTemplateKey: (d: string, depth: string, exp: string) => `${d}:${depth}:${exp}`,
  TEMPLATE_REGISTRY: {
    get: (key: string) => mockTemplateRegistryGet(key),
  },
  PHASE_WEIGHTS: { 'warm-up': 0.1, exploration: 0.55, 'deep-dive': 0.25, closing: 0.1 },
}))

// Import AFTER mocks.
import { POST } from '@/app/api/generate-question/route'

// ─── Helpers ───────────────────────────────────────────────────────────────

function makeRequest(overrides: Record<string, unknown> = {}): NextRequest {
  const body = {
    config: {
      role: 'pm',
      experience: '0-2',
      duration: 30,
      interviewType: 'behavioral',
    },
    questionIndex: 0,
    previousQA: [],
    sessionId: 'sess-phase4',
    ...overrides,
  }
  return new NextRequest('http://localhost:3000/api/generate-question', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
}

function completionResult(text: string, truncated = false) {
  return {
    text,
    model: 'test-model',
    provider: 'test-provider',
    inputTokens: 100,
    outputTokens: 50,
    usedFallback: false,
    truncated,
  }
}

function req(
  text: string,
  importance: 'must-have' | 'nice-to-have' = 'must-have',
  category: ParsedRequirement['category'] = 'technical',
): ParsedRequirement {
  return {
    id: `r-${Math.random().toString(36).slice(2, 8)}`,
    category,
    requirement: text,
    importance,
    targetCompetencies: [],
  }
}

function makeParsedJD(requirements: ParsedRequirement[]): IParsedJobDescription {
  return {
    rawText: 'test JD',
    company: 'Acme',
    role: 'PM',
    inferredDomain: 'pm',
    requirements,
    keyThemes: [],
  }
}

function makeTemplate(): FlowTemplate {
  return {
    domain: 'pm',
    depth: 'behavioral',
    experience: '0-2',
    slots: [
      {
        id: 'warm-up-a',
        label: 'Warm-up A',
        competencyBucket: 'motivation',
        phase: 'warm-up',
        guidance: 'guidance-a',
        probeGuidance: 'pg-a',
        maxProbes: 0,
        priority: 'must',
      },
      {
        id: 'warm-up-b',
        label: 'Warm-up B',
        competencyBucket: 'motivation',
        phase: 'warm-up',
        guidance: 'guidance-b',
        probeGuidance: 'pg-b',
        maxProbes: 0,
        priority: 'must',
      },
      {
        id: 'incident-response',
        label: 'Production incident response',
        competencyBucket: 'operational',
        phase: 'exploration',
        guidance: 'guidance-ir',
        probeGuidance: 'pg-ir',
        maxProbes: 2,
        priority: 'must',
      },
      {
        id: 'closing-a',
        label: 'Closing',
        competencyBucket: 'motivation',
        phase: 'closing',
        guidance: 'guidance-c',
        probeGuidance: 'pg-c',
        maxProbes: 0,
        priority: 'must',
      },
    ],
    neverAsk: [],
  }
}

function makeResolvedFlow(withAnnotation?: string): ResolvedFlow {
  return {
    domain: 'pm',
    depth: 'behavioral',
    experience: '0-2',
    totalSlots: 2,
    slots: [
      {
        id: 'warm-up-a',
        label: 'Warm-up A',
        competencyBucket: 'motivation',
        phase: 'warm-up',
        guidance: 'guidance-a',
        probeGuidance: 'pg-a',
        maxProbes: 0,
        priority: 'must',
        slotIndex: 0,
        ...(withAnnotation ? { jdAnnotation: withAnnotation } : {}),
      },
      {
        id: 'closing-a',
        label: 'Closing',
        competencyBucket: 'motivation',
        phase: 'closing',
        guidance: 'guidance-c',
        probeGuidance: 'pg-c',
        maxProbes: 0,
        priority: 'must',
        slotIndex: 1,
      },
    ],
  }
}

// ─── Tests ─────────────────────────────────────────────────────────────────

describe('POST /api/generate-question — JD overlay wiring', () => {
  beforeEach(() => {
    mockCompletion.mockReset()
    mockWarn.mockReset()
    mockError.mockReset()
    mockInfo.mockReset()
    mockDebug.mockReset()
    mockIsFeatureEnabled.mockReset()
    mockGetSessionConfig.mockReset()
    mockResolveFlow.mockReset()
    mockBuildFlowPromptContext.mockReset()
    mockBuildJDOverlay.mockReset()
    mockTemplateRegistryGet.mockReset()

    // Sensible defaults: interview_flow_templates on (so resolveFlow runs),
    // everything else off. Individual tests override.
    mockIsFeatureEnabled.mockImplementation((flag: string) => flag === 'interview_flow_templates')
    mockBuildFlowPromptContext.mockReturnValue({ promptBlock: '', currentSlot: null, phase: null, coveragePressure: false })
    mockCompletion.mockResolvedValue(completionResult('Generated question text.'))
  })

  // ── 1. Flag off + parsedJD present → overlay NOT computed ──────────────
  it('does NOT compute overlay when jd_flow_overlay flag is off (parsedJD present)', async () => {
    mockIsFeatureEnabled.mockImplementation((flag: string) => flag === 'interview_flow_templates')
    mockGetSessionConfig.mockResolvedValue({
      domain: null,
      depth: null,
      rubric: null,
      userProfile: null,
      parsedJD: makeParsedJD([req('Leadership of cross-functional teams')]),
    })
    mockResolveFlow.mockReturnValue(makeResolvedFlow())

    const res = await POST(makeRequest())
    expect(res.status).toBe(200)
    expect(mockBuildJDOverlay).not.toHaveBeenCalled()
    expect(mockTemplateRegistryGet).not.toHaveBeenCalled()
    // resolveFlow called without a jdOverlay (or with null/undefined)
    expect(mockResolveFlow).toHaveBeenCalledTimes(1)
    const callArgs = mockResolveFlow.mock.calls[0][0]
    expect(callArgs.jdOverlay == null).toBe(true)
  })

  // ── 2. Flag on + NO parsedJD → overlay NOT computed ────────────────────
  it('does NOT compute overlay when flag is on but parsedJD is absent', async () => {
    mockIsFeatureEnabled.mockImplementation(
      (flag: string) => flag === 'interview_flow_templates' || flag === 'jd_flow_overlay',
    )
    mockGetSessionConfig.mockResolvedValue({
      domain: null,
      depth: null,
      rubric: null,
      userProfile: null,
      parsedJD: null,
    })
    mockResolveFlow.mockReturnValue(makeResolvedFlow())

    const res = await POST(makeRequest())
    expect(res.status).toBe(200)
    expect(mockBuildJDOverlay).not.toHaveBeenCalled()
    expect(mockResolveFlow).toHaveBeenCalledTimes(1)
    const callArgs = mockResolveFlow.mock.calls[0][0]
    expect(callArgs.jdOverlay == null).toBe(true)
  })

  // ── 3. Flag on + parsedJD + template found → overlay IS computed ───────
  it('computes overlay and passes it to resolveFlow when flag on + parsedJD + template', async () => {
    mockIsFeatureEnabled.mockImplementation(
      (flag: string) => flag === 'interview_flow_templates' || flag === 'jd_flow_overlay',
    )
    const parsedJD = makeParsedJD([req('Lead incident response rotations'), req('Cross-functional collaboration')])
    mockGetSessionConfig.mockResolvedValue({
      domain: null,
      depth: null,
      rubric: null,
      userProfile: null,
      parsedJD,
    })
    const template = makeTemplate()
    mockTemplateRegistryGet.mockReturnValue(template)
    const overlay: JDOverlay = {
      promotions: ['incident-response'],
      annotations: [{ slotId: 'incident-response', jdContext: 'JD requires incident response' }],
      insertions: [],
    }
    mockBuildJDOverlay.mockReturnValue(overlay)
    mockResolveFlow.mockReturnValue(makeResolvedFlow())

    const res = await POST(makeRequest())
    expect(res.status).toBe(200)

    // Template was looked up via the registry
    expect(mockTemplateRegistryGet).toHaveBeenCalledWith('pm:behavioral:0-2')

    // Overlay builder called with the structured params shape
    expect(mockBuildJDOverlay).toHaveBeenCalledTimes(1)
    const overlayArgs = mockBuildJDOverlay.mock.calls[0][0]
    expect(overlayArgs.parsed).toBe(parsedJD)
    expect(overlayArgs.existingSlotIds).toEqual([
      'warm-up-a',
      'warm-up-b',
      'incident-response',
      'closing-a',
    ])
    // LAST warm-up slot id — E.5 front-splice invariant
    expect(overlayArgs.warmUpSlotId).toBe('warm-up-b')
    expect(overlayArgs.sessionId).toBe('sess-phase4')

    // resolveFlow received the overlay
    expect(mockResolveFlow).toHaveBeenCalledTimes(1)
    const resolveArgs = mockResolveFlow.mock.calls[0][0]
    expect(resolveArgs.jdOverlay).toBe(overlay)
  })

  // ── 4. buildFlowPromptContext surfaces jdAnnotation → prompt includes "JD ALIGNMENT:" ──
  // This exercises the same promptBuilder path at promptBuilder.ts:63-65.
  // We simulate buildFlowPromptContext having already rendered the overlay's
  // annotation into its promptBlock (the real function does this; our mock
  // echoes the expected string) and assert the final system prompt carries
  // it through to the LLM call.
  it('includes JD ALIGNMENT line in system prompt when buildFlowPromptContext surfaces annotation', async () => {
    mockIsFeatureEnabled.mockImplementation(
      (flag: string) => flag === 'interview_flow_templates' || flag === 'jd_flow_overlay',
    )
    mockGetSessionConfig.mockResolvedValue({
      domain: null,
      depth: null,
      rubric: null,
      userProfile: null,
      parsedJD: makeParsedJD([req('Incident response')]),
    })
    mockTemplateRegistryGet.mockReturnValue(makeTemplate())
    mockBuildJDOverlay.mockReturnValue({
      promotions: ['incident-response'],
      annotations: [{ slotId: 'incident-response', jdContext: 'JD requires incident response' }],
      insertions: [],
    })
    mockResolveFlow.mockReturnValue(makeResolvedFlow('JD requires incident response'))
    mockBuildFlowPromptContext.mockReturnValue({
      promptBlock: 'INTERVIEW FLOW PLAN:\nJD ALIGNMENT: JD requires incident response',
      currentSlot: null,
      phase: null,
      coveragePressure: false,
    })

    const res = await POST(makeRequest())
    expect(res.status).toBe(200)

    const systemPrompt = mockCompletion.mock.calls[0][0].system as string
    expect(systemPrompt).toContain('JD ALIGNMENT: JD requires incident response')
  })

  // ── 5. Overlay builder throws → fall through to no-overlay path ────────
  it('falls through to no-overlay path when overlay builder throws', async () => {
    mockIsFeatureEnabled.mockImplementation(
      (flag: string) => flag === 'interview_flow_templates' || flag === 'jd_flow_overlay',
    )
    mockGetSessionConfig.mockResolvedValue({
      domain: null,
      depth: null,
      rubric: null,
      userProfile: null,
      parsedJD: makeParsedJD([req('Incident response')]),
    })
    mockTemplateRegistryGet.mockReturnValue(makeTemplate())
    mockBuildJDOverlay.mockImplementation(() => {
      throw new Error('synthetic overlay failure')
    })
    mockResolveFlow.mockReturnValue(makeResolvedFlow())

    const res = await POST(makeRequest())
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.question).toBe('Generated question text.')
    // resolveFlow still called, but without an overlay
    expect(mockResolveFlow).toHaveBeenCalledTimes(1)
    const resolveArgs = mockResolveFlow.mock.calls[0][0]
    expect(resolveArgs.jdOverlay == null).toBe(true)
    // Debug log emitted for the swallowed error
    const debugCalls = mockDebug.mock.calls
    const overlayDebug = debugCalls.find(([, msg]) =>
      typeof msg === 'string' && msg.toLowerCase().includes('overlay'),
    )
    expect(overlayDebug).toBeDefined()
  })

  // ── 6. Flag on + template not found in registry → no overlay call ─────
  it('skips overlay when template registry returns undefined', async () => {
    mockIsFeatureEnabled.mockImplementation(
      (flag: string) => flag === 'interview_flow_templates' || flag === 'jd_flow_overlay',
    )
    mockGetSessionConfig.mockResolvedValue({
      domain: null,
      depth: null,
      rubric: null,
      userProfile: null,
      parsedJD: makeParsedJD([req('Leadership')]),
    })
    mockTemplateRegistryGet.mockReturnValue(undefined)
    mockResolveFlow.mockReturnValue(makeResolvedFlow())

    const res = await POST(makeRequest())
    expect(res.status).toBe(200)
    // Template lookup happens, but overlay builder does not
    expect(mockTemplateRegistryGet).toHaveBeenCalledTimes(1)
    expect(mockBuildJDOverlay).not.toHaveBeenCalled()
    const resolveArgs = mockResolveFlow.mock.calls[0][0]
    expect(resolveArgs.jdOverlay == null).toBe(true)
  })

  // ── 7. Flag on + no sessionId → overlay NOT computed ──────────────────
  it('skips overlay entirely when sessionId is absent', async () => {
    mockIsFeatureEnabled.mockImplementation(
      (flag: string) => flag === 'interview_flow_templates' || flag === 'jd_flow_overlay',
    )
    mockResolveFlow.mockReturnValue(makeResolvedFlow())

    const res = await POST(makeRequest({ sessionId: undefined }))
    expect(res.status).toBe(200)
    expect(mockGetSessionConfig).not.toHaveBeenCalled()
    expect(mockBuildJDOverlay).not.toHaveBeenCalled()
    const resolveArgs = mockResolveFlow.mock.calls[0][0]
    expect(resolveArgs.jdOverlay == null).toBe(true)
  })

  // ── 8. Truncation retry path still works with flag on ──────────────────
  // Guards against a regression where overlay logic leaks into the
  // truncation-retry codepath from Work Item A.
  it('preserves Work Item A truncation retry when overlay flag is on', async () => {
    mockIsFeatureEnabled.mockImplementation(
      (flag: string) => flag === 'interview_flow_templates' || flag === 'jd_flow_overlay',
    )
    mockGetSessionConfig.mockResolvedValue({
      domain: null,
      depth: null,
      rubric: null,
      userProfile: null,
      parsedJD: makeParsedJD([req('Incident response')]),
    })
    mockTemplateRegistryGet.mockReturnValue(makeTemplate())
    mockBuildJDOverlay.mockReturnValue({
      promotions: ['incident-response'],
      annotations: [],
      insertions: [],
    })
    mockResolveFlow.mockReturnValue(makeResolvedFlow())
    mockCompletion
      .mockReset()
      .mockResolvedValueOnce(completionResult('Cut off', true))
      .mockResolvedValueOnce(completionResult('Full retry.', false))

    const res = await POST(makeRequest())
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.question).toBe('Full retry.')
    expect(mockCompletion).toHaveBeenCalledTimes(2)
    // Retry call still carries the expanded maxTokens from Work Item A
    expect(mockCompletion.mock.calls[1][0].maxTokens).toBe(500)
  })
})
