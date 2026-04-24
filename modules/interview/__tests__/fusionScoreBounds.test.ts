/**
 * Audit fix (2026-04-24): guards the fusion-score honesty contract.
 *
 * Before this fix, `runFusionAnalysis` had two silent-garbage modes:
 *
 *   1. No facial data (privacy mode, camera off, or all MediaPipe
 *      segments were sentinel `-1`). The server built `contextData`
 *      WITHOUT a `facialSignals` block, but the prompt still asked
 *      Claude to "Score body language based on eye contact, expressions,
 *      and head stability" and "Score eye contact based on facial data
 *      averages" — so the LLM fabricated plausible 65-80 scores and
 *      they landed in Mongo, then rendered on the feedback page as
 *      real measurements.
 *
 *   2. Out-of-range scores from Claude. `FusionLlmSchema` had
 *      `z.number().optional()` with no `.min(0).max(100)`, and the
 *      `.passthrough()` modifier plus `safeParse`+continue meant a
 *      hallucinated 152 or -30 survived to the UI as "152/100".
 *
 * Fix: (a) prompt now tells Claude to return `null` when no facial
 * data is available, (b) server post-parse sanitize nulls any score
 * outside [0,100] or not a finite number, (c) server-side override
 * forces both scores to `null` whenever `facialSegments` has zero
 * usable entries, regardless of what Claude returned.
 *
 * These tests pin each branch of the sanitize → no-data-override flow.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'

const { mockCompletion } = vi.hoisted(() => ({
  mockCompletion: vi.fn(),
}))

vi.mock('@shared/services/modelRouter', () => ({
  completion: mockCompletion,
}))

vi.mock('@shared/logger', () => ({
  aiLogger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}))

vi.mock('@shared/services/promptSecurity', () => ({
  DATA_BOUNDARY_RULE: '',
  JSON_OUTPUT_RULE: '',
}))

import { runFusionAnalysis } from '@interview/services/analysis/fusionService'
import type { FacialSegment, ProsodySegment } from '@shared/types/multimodal'
import type { AnswerEvaluation, TranscriptEntry, InterviewConfig } from '@shared/types'

// ─── Fixtures ──────────────────────────────────────────────────────────────

const baseConfig: InterviewConfig = {
  role: 'pm',
  experience: '3-5',
  interviewType: 'behavioral',
  duration: 30,
}

function validFacialSegment(qIdx: number, startSec: number): FacialSegment {
  return {
    questionIndex: qIdx,
    startSec,
    endSec: startSec + 60,
    avgEyeContact: 0.75,
    headStability: 0.8,
    dominantExpression: 'neutral',
    gestureLevel: 'medium',
    frameCount: 1800,
  } as unknown as FacialSegment
}

function sentinelFacialSegment(qIdx: number, startSec: number): FacialSegment {
  return {
    questionIndex: qIdx,
    startSec,
    endSec: startSec + 60,
    // -1 is the aggregator's "no valid frames in this window" sentinel.
    avgEyeContact: -1,
    headStability: -1,
    dominantExpression: 'unknown',
    gestureLevel: 'low',
    frameCount: 0,
  } as unknown as FacialSegment
}

const prosody: ProsodySegment[] = [
  {
    questionIndex: 0,
    startSec: 0,
    endSec: 60,
    wpm: 140,
    fillerWords: [],
    pauseDurationSec: 2,
    confidenceMarker: 'high',
  } as unknown as ProsodySegment,
]

const evaluations: AnswerEvaluation[] = [
  {
    questionIndex: 0,
    question: 'Tell me about a challenge',
    answer: 'I led a team…',
    relevance: 80,
    structure: 75,
    specificity: 78,
    ownership: 82,
    flags: [],
  } as unknown as AnswerEvaluation,
]

const transcript: TranscriptEntry[] = [
  { speaker: 'interviewer', text: 'Tell me about a challenge', timestamp: 0 },
  { speaker: 'candidate', text: 'I led a team…', timestamp: 10 },
] as TranscriptEntry[]

function makeCompletionResponse(bodyScore: unknown, eyeScore: unknown) {
  return {
    text: JSON.stringify({
      timeline: [
        {
          startSec: 0,
          endSec: 60,
          type: 'observation',
          signal: 'content',
          title: 'clear framing',
          description: 'answered with a clear STAR structure.',
          severity: 'positive',
          questionIndex: 0,
        },
      ],
      fusionSummary: {
        overallBodyLanguageScore: bodyScore,
        eyeContactScore: eyeScore,
        confidenceProgression: 'steady throughout',
        topMoments: [0],
        improvementMoments: [],
        coachingTips: ['Tip 1', 'Tip 2', 'Tip 3'],
      },
    }),
    inputTokens: 1000,
    outputTokens: 500,
    model: 'claude-haiku-4-5',
    provider: 'anthropic',
    usedFallback: false,
    truncated: false,
  }
}

// ─── No-data override ──────────────────────────────────────────────────────

describe('runFusionAnalysis — no facial data override', () => {
  beforeEach(() => vi.clearAllMocks())

  it('forces both scores to null when facialSegments is empty', async () => {
    mockCompletion.mockResolvedValueOnce(makeCompletionResponse(72, 68))

    const out = await runFusionAnalysis({
      prosodySegments: prosody,
      facialSegments: [],
      evaluations,
      transcript,
      config: baseConfig,
    })

    expect(out.fusionSummary.overallBodyLanguageScore).toBeNull()
    expect(out.fusionSummary.eyeContactScore).toBeNull()
  })

  it('forces both scores to null when every facialSegment is a sentinel (-1)', async () => {
    // All windows had zero frames — MediaPipe failed to capture anything
    // usable. Server knows better than whatever Claude hallucinated.
    mockCompletion.mockResolvedValueOnce(makeCompletionResponse(68, 72))

    const out = await runFusionAnalysis({
      prosodySegments: prosody,
      facialSegments: [sentinelFacialSegment(0, 0), sentinelFacialSegment(1, 60)],
      evaluations,
      transcript,
      config: baseConfig,
    })

    expect(out.fusionSummary.overallBodyLanguageScore).toBeNull()
    expect(out.fusionSummary.eyeContactScore).toBeNull()
  })

  it('preserves scores when AT LEAST ONE facialSegment has real data', async () => {
    // Mixed case: a few windows captured nothing (sentinel) but others
    // had real data. This is the common case for a brief camera blip.
    // Scores should flow through (assuming they pass the [0,100] guard).
    mockCompletion.mockResolvedValueOnce(makeCompletionResponse(78, 72))

    const out = await runFusionAnalysis({
      prosodySegments: prosody,
      facialSegments: [sentinelFacialSegment(0, 0), validFacialSegment(1, 60)],
      evaluations,
      transcript,
      config: baseConfig,
    })

    expect(out.fusionSummary.overallBodyLanguageScore).toBe(78)
    expect(out.fusionSummary.eyeContactScore).toBe(72)
  })
})

// ─── Out-of-range sanitization ─────────────────────────────────────────────

describe('runFusionAnalysis — score sanitization', () => {
  beforeEach(() => vi.clearAllMocks())

  it('nulls overallBodyLanguageScore > 100', async () => {
    mockCompletion.mockResolvedValueOnce(makeCompletionResponse(152, 80))

    const out = await runFusionAnalysis({
      prosodySegments: prosody,
      facialSegments: [validFacialSegment(0, 0)],
      evaluations,
      transcript,
      config: baseConfig,
    })

    expect(out.fusionSummary.overallBodyLanguageScore).toBeNull()
    expect(out.fusionSummary.eyeContactScore).toBe(80)
  })

  it('nulls eyeContactScore < 0', async () => {
    mockCompletion.mockResolvedValueOnce(makeCompletionResponse(65, -30))

    const out = await runFusionAnalysis({
      prosodySegments: prosody,
      facialSegments: [validFacialSegment(0, 0)],
      evaluations,
      transcript,
      config: baseConfig,
    })

    expect(out.fusionSummary.overallBodyLanguageScore).toBe(65)
    expect(out.fusionSummary.eyeContactScore).toBeNull()
  })

  it('nulls non-numeric scores', async () => {
    mockCompletion.mockResolvedValueOnce(makeCompletionResponse('high', 'medium'))

    const out = await runFusionAnalysis({
      prosodySegments: prosody,
      facialSegments: [validFacialSegment(0, 0)],
      evaluations,
      transcript,
      config: baseConfig,
    })

    expect(out.fusionSummary.overallBodyLanguageScore).toBeNull()
    expect(out.fusionSummary.eyeContactScore).toBeNull()
  })

  it('nulls NaN / Infinity scores', async () => {
    mockCompletion.mockResolvedValueOnce(makeCompletionResponse(NaN, Infinity))

    const out = await runFusionAnalysis({
      prosodySegments: prosody,
      facialSegments: [validFacialSegment(0, 0)],
      evaluations,
      transcript,
      config: baseConfig,
    })

    expect(out.fusionSummary.overallBodyLanguageScore).toBeNull()
    expect(out.fusionSummary.eyeContactScore).toBeNull()
  })

  it('preserves valid in-range scores verbatim', async () => {
    // Happy path — valid scores, valid facial data. Nothing changes.
    mockCompletion.mockResolvedValueOnce(makeCompletionResponse(82, 75))

    const out = await runFusionAnalysis({
      prosodySegments: prosody,
      facialSegments: [validFacialSegment(0, 0)],
      evaluations,
      transcript,
      config: baseConfig,
    })

    expect(out.fusionSummary.overallBodyLanguageScore).toBe(82)
    expect(out.fusionSummary.eyeContactScore).toBe(75)
  })

  it('preserves explicit null from Claude (schema already allows it)', async () => {
    // Claude followed the prompt's "return null when no facial data"
    // instruction. Server keeps the null; no-facial-data override is
    // a safety net, not the only path.
    mockCompletion.mockResolvedValueOnce(makeCompletionResponse(null, null))

    const out = await runFusionAnalysis({
      prosodySegments: prosody,
      facialSegments: [],
      evaluations,
      transcript,
      config: baseConfig,
    })

    expect(out.fusionSummary.overallBodyLanguageScore).toBeNull()
    expect(out.fusionSummary.eyeContactScore).toBeNull()
  })

  it('treats score === 0 as valid (boundary)', async () => {
    mockCompletion.mockResolvedValueOnce(makeCompletionResponse(0, 0))

    const out = await runFusionAnalysis({
      prosodySegments: prosody,
      facialSegments: [validFacialSegment(0, 0)],
      evaluations,
      transcript,
      config: baseConfig,
    })

    expect(out.fusionSummary.overallBodyLanguageScore).toBe(0)
    expect(out.fusionSummary.eyeContactScore).toBe(0)
  })

  it('treats score === 100 as valid (boundary)', async () => {
    mockCompletion.mockResolvedValueOnce(makeCompletionResponse(100, 100))

    const out = await runFusionAnalysis({
      prosodySegments: prosody,
      facialSegments: [validFacialSegment(0, 0)],
      evaluations,
      transcript,
      config: baseConfig,
    })

    expect(out.fusionSummary.overallBodyLanguageScore).toBe(100)
    expect(out.fusionSummary.eyeContactScore).toBe(100)
  })
})
