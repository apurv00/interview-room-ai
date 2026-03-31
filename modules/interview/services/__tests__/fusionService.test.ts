import { describe, it, expect, vi, beforeEach } from 'vitest'

// Mock Anthropic SDK
vi.mock('@anthropic-ai/sdk', () => ({
  default: class {
    messages = {
      create: vi.fn().mockResolvedValue({
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
  })
})
