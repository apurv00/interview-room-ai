import { describe, it, expect, vi, beforeEach } from 'vitest'

// Captured contextData from each mock completion call — inspected by the
// dual-pipeline tests to verify what the model actually sees.
const capturedPrompts: string[] = []
const capturedContextData: Array<Record<string, unknown> | undefined> = []

// Mock the model router's completion function
vi.mock('@shared/services/modelRouter', () => ({
  completion: vi.fn().mockImplementation(async (opts: { messages: Array<{ content: string }>; contextData?: Record<string, unknown> }) => {
    capturedPrompts.push(opts.messages[0].content + (opts.contextData ? JSON.stringify(opts.contextData) : ''))
    capturedContextData.push(opts.contextData)
    return {
      text: JSON.stringify({
                timeline: [
                  {
                    startSec: 10,
                    endSec: 30,
                    type: 'strength',
                    signal: 'fused',
                    title: 'Strong opening answer',
                    description: 'Good eye contact with structured response.',
                    severity: 'positive',
                    questionIndex: 0,
                  },
                ],
                fusionSummary: {
                  overallBodyLanguageScore: 72,
                  eyeContactScore: 78,
                  confidenceProgression: 'Started nervous but built confidence.',
                  topMoments: [],
                  improvementMoments: [],
                  coachingTips: ['Reduce filler words in opening.'],
                },
              }),
      model: 'mock-model',
      provider: 'anthropic' as const,
      inputTokens: 500,
      outputTokens: 300,
      usedFallback: false,
    }
  }),
}))

vi.mock('@shared/logger', () => ({
  aiLogger: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() },
}))

import { runFusionAnalysis } from '../fusionService'

describe('fusionService', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    capturedPrompts.length = 0
    capturedContextData.length = 0
  })

  it('returns timeline events and fusion summary', async () => {
    const result = await runFusionAnalysis({
      prosodySegments: [
        {
          startSec: 0,
          endSec: 60,
          wpm: 140,
          fillerWords: [],
          pauseDurationSec: 2,
          confidenceMarker: 'high',
          questionIndex: 0,
        },
      ],
      facialSegments: [
        {
          startSec: 0,
          endSec: 60,
          avgEyeContact: 0.78,
          dominantExpression: 'neutral',
          headStability: 0.85,
          gestureLevel: 'moderate',
          questionIndex: 0,
        },
      ],
      evaluations: [
        {
          questionIndex: 0,
          question: 'Tell me about yourself',
          answer: 'I am a software engineer...',
          relevance: 80,
          structure: 75,
          specificity: 70,
          ownership: 85,
          needsFollowUp: false,
          flags: [],
        },
      ],
      transcript: [
        { speaker: 'interviewer', text: 'Tell me about yourself', timestamp: 5, questionIndex: 0 },
        { speaker: 'candidate', text: 'I am a software engineer...', timestamp: 10, questionIndex: 0 },
      ],
      config: { role: 'SWE', experience: '3-6', duration: 10 },
    })

    expect(result.timeline).toHaveLength(1)
    expect(result.timeline[0].type).toBe('strength')
    expect(result.fusionSummary.overallBodyLanguageScore).toBe(72)
    expect(result.fusionSummary.eyeContactScore).toBe(78)
    expect(result.fusionSummary.coachingTips).toHaveLength(1)
    expect(result.inputTokens).toBe(500)
    expect(result.outputTokens).toBe(300)
    expect(result.model).toBe('mock-model')
    expect(result.promptLength).toBeGreaterThan(0)
  })

  describe('dual-pipeline (Option B)', () => {
    const enrichedFacialSegment = {
      startSec: 0,
      endSec: 60,
      avgEyeContact: 0.78,
      dominantExpression: 'neutral',
      headStability: 0.85,
      gestureLevel: 'moderate' as const,
      questionIndex: 0,
      meanBlendshapes: {
        mouthSmileLeft: 0.35,
        mouthSmileRight: 0.38,
        browDownLeft: 0.12,
        eyeBlinkLeft: 0.08,
      },
      maxBlendshapes: {
        mouthSmileLeft: 0.6,
        mouthSmileRight: 0.62,
        browDownLeft: 0.2,
        eyeBlinkLeft: 0.9,
      },
    }

    const baseInput = {
      prosodySegments: [
        {
          startSec: 0,
          endSec: 60,
          wpm: 140,
          fillerWords: [],
          pauseDurationSec: 2,
          confidenceMarker: 'high' as const,
          questionIndex: 0,
        },
      ],
      evaluations: [
        {
          questionIndex: 0,
          question: 'Tell me about yourself',
          answer: 'I am a software engineer...',
          relevance: 80,
          structure: 75,
          specificity: 70,
          ownership: 85,
          needsFollowUp: false,
          flags: [],
        },
      ],
      transcript: [
        { speaker: 'interviewer' as const, text: 'Tell me about yourself', timestamp: 5, questionIndex: 0 },
        { speaker: 'candidate' as const, text: 'I am a software engineer...', timestamp: 10, questionIndex: 0 },
      ],
      config: { role: 'SWE', experience: '3-6' as const, duration: 10 },
    }

    it('baseline variant omits blendshape data from the prompt', async () => {
      await runFusionAnalysis({
        ...baseInput,
        facialSegments: [enrichedFacialSegment],
        includeBlendshapes: false,
      })

      expect(capturedContextData).toHaveLength(1)
      const ctx = capturedContextData[0]
      expect(ctx).toBeDefined()
      // Baseline: facial signals present but without blendshape enrichment
      const facialSignals = (ctx!.facialSignals as Array<Record<string, unknown>>)
      expect(facialSignals).toBeDefined()
      expect(facialSignals[0]).toHaveProperty('dominantExpression')
      expect(facialSignals[0]).not.toHaveProperty('topBlendshapes')
    })

    it('enhanced variant includes top blendshapes in the prompt', async () => {
      await runFusionAnalysis({
        ...baseInput,
        facialSegments: [enrichedFacialSegment],
        includeBlendshapes: true,
      })

      expect(capturedContextData).toHaveLength(1)
      const ctx = capturedContextData[0]
      expect(ctx).toBeDefined()
      const facialSignals = (ctx!.facialSignals as Array<Record<string, unknown>>)
      expect(facialSignals[0]).toHaveProperty('topBlendshapes')
      // Top blendshape by mean value (0.38) should be in the top list
      const topBlendshapes = facialSignals[0].topBlendshapes as Record<string, number>
      expect(topBlendshapes).toHaveProperty('mouthSmileRight')
      // Categorical label still present (shared across both variants)
      expect(facialSignals[0]).toHaveProperty('dominantExpression')
    })

    it('baseline and enhanced produce measurably different prompts', async () => {
      const baseline = await runFusionAnalysis({
        ...baseInput,
        facialSegments: [enrichedFacialSegment],
        includeBlendshapes: false,
      })
      const enhanced = await runFusionAnalysis({
        ...baseInput,
        facialSegments: [enrichedFacialSegment],
        includeBlendshapes: true,
      })

      expect(capturedPrompts).toHaveLength(2)
      expect(enhanced.promptLength).toBeGreaterThan(baseline.promptLength)
      expect(capturedPrompts[0]).not.toBe(capturedPrompts[1])
    })

    it('enhanced variant with no blendshape stats falls back to baseline-equivalent prompt', async () => {
      const plainSegment = {
        startSec: 0,
        endSec: 60,
        avgEyeContact: 0.78,
        dominantExpression: 'neutral',
        headStability: 0.85,
        gestureLevel: 'moderate' as const,
        questionIndex: 0,
      }

      await runFusionAnalysis({
        ...baseInput,
        facialSegments: [plainSegment],
        includeBlendshapes: true,
      })

      expect(capturedPrompts[0]).not.toContain('topBlendshapes')
    })

    it('sentinel facial segments (avgEyeContact === -1) are excluded from the prompt', async () => {
      const sentinelSegment = {
        startSec: 30,
        endSec: 60,
        avgEyeContact: -1,  // sentinel: no data in this window
        dominantExpression: 'neutral',
        headStability: -1,  // sentinel: no data
        gestureLevel: 'minimal' as const,
        questionIndex: 1,
      }

      await runFusionAnalysis({
        ...baseInput,
        facialSegments: [enrichedFacialSegment, sentinelSegment],
        includeBlendshapes: false,
      })

      expect(capturedContextData).toHaveLength(1)
      const ctx = capturedContextData[0]
      expect(ctx).toBeDefined()
      const facialSignals = ctx!.facialSignals as Array<Record<string, unknown>>
      // Only the real segment should appear — sentinel filtered out
      expect(facialSignals).toHaveLength(1)
      expect(facialSignals[0].eyeContact).toBe(78) // Math.round(0.78 * 100)
      // Sentinel values (-100) should never appear
      expect(facialSignals.some((s) => (s.eyeContact as number) < 0)).toBe(false)
    })

    it('all-sentinel facial data produces no facialSignals in context', async () => {
      const sentinelOnly = {
        startSec: 0,
        endSec: 60,
        avgEyeContact: -1,
        dominantExpression: 'neutral',
        headStability: -1,
        gestureLevel: 'minimal' as const,
        questionIndex: 0,
      }

      await runFusionAnalysis({
        ...baseInput,
        facialSegments: [sentinelOnly],
        includeBlendshapes: false,
      })

      expect(capturedContextData).toHaveLength(1)
      const ctx = capturedContextData[0]
      // When all segments are sentinel, no facialSignals key should exist
      expect(ctx!.facialSignals).toBeUndefined()
    })

    it('filters out near-zero blendshapes from the top list', async () => {
      const noisySegment = {
        ...enrichedFacialSegment,
        meanBlendshapes: {
          mouthSmileLeft: 0.35,
          noiseA: 0.005,  // below 0.02 threshold, should drop
          noiseB: 0.003,
          browDownLeft: 0.12,
        },
      }

      await runFusionAnalysis({
        ...baseInput,
        facialSegments: [noisySegment],
        includeBlendshapes: true,
      })

      const prompt = capturedPrompts[0]
      expect(prompt).toContain('mouthSmileLeft')
      expect(prompt).toContain('browDownLeft')
      expect(prompt).not.toContain('noiseA')
      expect(prompt).not.toContain('noiseB')
    })
  })

  describe('JSON parse resilience', () => {
    it('throws a clear error when LLM returns truncated/malformed JSON', async () => {
      const { completion } = await import('@shared/services/modelRouter')
      const mockCompletion = vi.mocked(completion)
      // Simulate truncated output where the regex matches braces but
      // the interior JSON is malformed (e.g. array bracket missing)
      mockCompletion.mockResolvedValueOnce({
        text: '{"timeline":[{"startSec":10,"endSec":30,"type":"stre}',
        model: 'mock-model',
        provider: 'anthropic' as const,
        inputTokens: 500,
        outputTokens: 300,
        usedFallback: false,
      })

      await expect(
        runFusionAnalysis({
          prosodySegments: [],
          facialSegments: [],
          evaluations: [],
          transcript: [],
          config: { role: 'SWE', experience: '3-6', duration: 10 },
        })
      ).rejects.toThrow('malformed JSON')
    })

    it('throws when LLM returns no JSON at all', async () => {
      const { completion } = await import('@shared/services/modelRouter')
      const mockCompletion = vi.mocked(completion)
      mockCompletion.mockResolvedValueOnce({
        text: 'I cannot generate the analysis due to content filters.',
        model: 'mock-model',
        provider: 'anthropic' as const,
        inputTokens: 200,
        outputTokens: 50,
        usedFallback: false,
      })

      await expect(
        runFusionAnalysis({
          prosodySegments: [],
          facialSegments: [],
          evaluations: [],
          transcript: [],
          config: { role: 'SWE', experience: '3-6', duration: 10 },
        })
      ).rejects.toThrow('no valid JSON')
    })
  })
})
