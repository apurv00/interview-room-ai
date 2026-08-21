import { describe, expect, it } from 'vitest'
import { presentHireMultimodalAnalysis } from '../services/analysisPresenter'

const objectId = (value: string) => ({ toString: () => value })

describe('Hire multimodal recruiter presenter', () => {
  it('exposes every derived report field but omits raw storage and transport internals', () => {
    const view = presentHireMultimodalAnalysis({
      _id: objectId('a'.repeat(24)),
      roundId: objectId('b'.repeat(24)),
      attemptId: objectId('c'.repeat(24)),
      status: 'completed',
      capturedAt: new Date('2026-08-17T12:00:00.000Z'),
      completedAt: new Date('2026-08-17T12:05:00.000Z'),
      durationMs: 12_000,
      facialFrameCount: 60,
      prosodySegments: [],
      facialSegments: [],
      facialTimeseries: [],
      timeline: [{
        startMs: 0,
        endMs: 1_000,
        type: 'observation',
        signal: 'audio',
        title: 'Speech delivery signal',
        description: '145 words per minute.',
        severity: 'neutral',
      }],
      summary: {
        bodyLanguageScore: 70,
        eyeContactScore: 72,
        deliverySummary: 'Complete report.',
        reviewerNotes: ['Review alongside the recording.'],
        topMoments: [],
        attentionMoments: [],
      },
    })
    expect(view.report).toEqual(expect.objectContaining({
      prosodySegments: [],
      facialSegments: [],
      facialTimeseries: [],
      timeline: expect.any(Array),
      summary: expect.any(Object),
    }))
    expect(view.manualRetryAvailable).toBe(false)
    expect(JSON.stringify(view)).not.toMatch(/objectKey|landmarksAssetId|inputTranscript|liveTranscriptWords|sha256/i)
  })

  it('marks only exhausted failures as manually retryable', () => {
    const base = {
      _id: objectId('a'.repeat(24)),
      roundId: objectId('b'.repeat(24)),
      attemptId: objectId('c'.repeat(24)),
      status: 'failed' as const,
      capturedAt: new Date('2026-08-17T12:00:00.000Z'),
      durationMs: 12_000,
    }
    expect(presentHireMultimodalAnalysis({
      ...base,
      retryAttemptCount: 2,
    }).manualRetryAvailable).toBe(false)
    expect(presentHireMultimodalAnalysis({
      ...base,
      retryAttemptCount: 3,
      retryAt: new Date('2026-08-17T13:00:00.000Z'),
    }).manualRetryAvailable).toBe(true)
  })
})
