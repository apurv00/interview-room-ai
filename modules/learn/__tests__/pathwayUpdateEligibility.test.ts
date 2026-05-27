import { describe, expect, it } from 'vitest'
import { getPathwayUpdateEligibility } from '../services/pathwayUpdateEligibility'

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

  it('blocks when feedback is not scored', () => {
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
