import { describe, expect, it } from 'vitest'
import {
  buildRetryablePathwayStatusFilter,
  getPathwayUpdateEligibility,
  isStalePathwayGeneration,
} from '../services/pathwayUpdateEligibility'

describe('getPathwayUpdateEligibility', () => {
  it('blocks enqueue and retry when fewer than three answers', () => {
    const result = getPathwayUpdateEligibility({
      answeredCount: 2,
      pathwayPlannerEnabled: true,
      feedback: { overall_score: 72 },
      evaluationCount: 2,
    })
    expect(result).toMatchObject({
      reason: 'insufficient_answers',
      canEnqueue: false,
      poll: false,
      allowPathwayRetry: false,
    })
  })

  it('blocks when feedback is not scored and no job is in flight', () => {
    const result = getPathwayUpdateEligibility({
      answeredCount: 5,
      pathwayPlannerEnabled: true,
      feedback: null,
      evaluationCount: 5,
      pathwayGenerationStatus: null,
    })
    expect(result.reason).toBe('no_scored_feedback')
    expect(result.canEnqueue).toBe(false)
  })

  it('polls for in-flight jobs without persisted feedback when synthesized flag is set', () => {
    const result = getPathwayUpdateEligibility({
      answeredCount: 5,
      pathwayPlannerEnabled: true,
      feedback: null,
      evaluationCount: 5,
      pathwayGenerationStatus: 'pending',
      useSynthesizedFeedback: true,
    })
    expect(result.reason).toBe('pathway_in_flight')
    expect(result.poll).toBe(true)
  })

  it('allows degraded feedback with evaluations as pathway input', () => {
    const result = getPathwayUpdateEligibility({
      answeredCount: 4,
      pathwayPlannerEnabled: true,
      feedback: { overall_score: 55, degraded: true },
      evaluationCount: 4,
      pathwayGenerationStatus: 'pending',
    })
    expect(result.reason).toBe('pathway_in_flight')
    expect(result.poll).toBe(true)
    expect(result.allowPathwayRetry).toBe(true)
  })

  it('polls while pathway job is in flight', () => {
    const result = getPathwayUpdateEligibility({
      answeredCount: 6,
      pathwayPlannerEnabled: true,
      feedback: { overall_score: 80 },
      evaluationCount: 6,
      pathwayGenerationStatus: 'running',
    })
    expect(result).toMatchObject({
      reason: 'pathway_in_flight',
      poll: true,
      allowPathwayRetry: true,
    })
  })
})

describe('isStalePathwayGeneration', () => {
  it('does not treat pending as stale when retry set a fresh startedAt on an old interview', () => {
    const oldCompleted = new Date(Date.now() - 30 * 60 * 1000)
    const freshStarted = new Date(Date.now() - 30 * 1000)
    expect(
      isStalePathwayGeneration('pending', oldCompleted, freshStarted),
    ).toBe(false)
  })

  it('treats unstarted pending as stale only when completedAt is old', () => {
    const oldCompleted = new Date(Date.now() - 20 * 60 * 1000)
    expect(isStalePathwayGeneration('pending', oldCompleted, null)).toBe(true)
    expect(isStalePathwayGeneration('pending', new Date(), null)).toBe(false)
  })
})

describe('buildRetryablePathwayStatusFilter', () => {
  it('does not match fresh unstarted pending without a stale completedAt', () => {
    const filter = buildRetryablePathwayStatusFilter() as {
      $or: Array<Record<string, unknown>>
    }
    const pendingBranch = filter.$or.find(
      (b) => b.pathwayGenerationStatus === 'pending',
    ) as { $or: Array<Record<string, unknown>> }
    const branches = pendingBranch.$or.map((b) => JSON.stringify(b))
    expect(branches.some((b) => b.includes('pathwayGenerationStartedAt') && b.includes('$exists'))).toBe(
      true,
    )
    expect(branches.some((b) => b === '{"pathwayGenerationStartedAt":null}')).toBe(false)
  })
})
