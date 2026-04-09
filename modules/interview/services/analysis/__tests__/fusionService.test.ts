import { describe, it, expect, vi, beforeEach } from 'vitest'

// Captured prompts from each mock Anthropic call — inspected by the
// dual-pipeline tests to verify what the model actually sees.
const capturedPrompts: string[] = []

// Mock Anthropic SDK
vi.mock('@anthropic-ai/sdk', () => ({
  default: class {
    messages = {
      create: vi.fn().mockImplementation(async (req: { messages: Array<{ content: string }> }) => {
        capturedPrompts.push(req.messages[0].content)
        return {
          content: [
            {
              type: 'text',
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
            },
          ],
          usage: { input_tokens: 500, output_tokens: 300 },
        }
      }),
    }
  },
}))

vi.mock('@shared/logger', () => ({
  aiLogger: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() },
}))

import { runFusionAnalysis } from '../fusionService'

describe('fusionService', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    capturedPrompts.length = 0
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

      expect(capturedPrompts).toHaveLength(1)
      const prompt = capturedPrompts[0]
      expect(prompt).toContain('<facial_signals>')
      expect(prompt).toContain('dominantExpression')
      expect(prompt).not.toContain('topBlendshapes')
      expect(prompt).not.toContain('mouthSmileLeft')
    })

    it('enhanced variant includes top blendshapes in the prompt', async () => {
      await runFusionAnalysis({
        ...baseInput,
        facialSegments: [enrichedFacialSegment],
        includeBlendshapes: true,
      })

      expect(capturedPrompts).toHaveLength(1)
      const prompt = capturedPrompts[0]
      expect(prompt).toContain('topBlendshapes')
      // Top blendshape by mean value (0.38) should be in the top list
      expect(prompt).toContain('mouthSmileRight')
      // Categorical label still present (shared across both variants)
      expect(prompt).toContain('dominantExpression')
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
})
