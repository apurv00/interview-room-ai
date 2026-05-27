/**
 * Local integration (no deploy) — eligibility → view model → retry contract.
 */
import { describe, expect, it } from 'vitest'
import { getPathwayUpdateEligibility } from '../services/pathwayUpdateEligibility'
import { buildPathwayViewModel } from '../services/pathwayViewModel'
import { canEnqueuePathwayRegeneration } from '../services/pathwayRegeneration'
import type { IPathwayPlan } from '@shared/db/models'

const makePathway = (overrides: Partial<IPathwayPlan> = {}): IPathwayPlan =>
  ({
    _id: 'plan-1',
    userId: 'user-1',
    targetRole: 'pm',
    readinessScore: 55,
    readinessLevel: 'developing',
    generatedAt: new Date('2026-05-01T00:00:00Z'),
    generatedFromSessionId: 'older-session',
    practiceTasks: [
      {
        id: 't1',
        type: 'drill',
        title: 'STAR drill',
        description: 'Practice structure',
        targetCompetency: 'structure',
        difficulty: 'medium',
        estimatedMinutes: 15,
        completed: false,
      },
    ],
    topBlockingWeaknesses: [],
    milestones: [],
    nextSessionRecommendation: null,
    ...overrides,
  }) as IPathwayPlan

describe('pathway loader — local integration', () => {
  it('coding session with one substantive submission: eligible enqueue and pathway update', () => {
    expect(
      canEnqueuePathwayRegeneration(
        'sess',
        [{ questionIndex: 0 }],
        1,
        'coding',
      ),
    ).toBe(true)

    const update = getPathwayUpdateEligibility({
      answeredCount: 1,
      interviewType: 'coding',
      pathwayPlannerEnabled: true,
      feedback: { overall_score: 78 },
      evaluationCount: 1,
      pathwayGenerationStatus: null,
    })
    expect(update.reason).toBe('eligible')
    expect(update.canEnqueue).toBe(true)

    const vm = buildPathwayViewModel({
      pathway: makePathway(),
      competencySummary: null,
      weaknesses: [],
      fromFeedback: 'coding-session',
      pathwayUpdate: update,
    })
    expect(vm.pathwayUpdate?.reason).toBe('eligible')
    expect(vm.pathwayUpdate?.canEnqueue).toBe(true)
    expect(vm.state).not.toBe('unchanged')
  })

  it('behavioral session with two answers: still insufficient for pathway', () => {
    expect(
      canEnqueuePathwayRegeneration(
        'sess',
        [{ questionIndex: 0 }, { questionIndex: 1 }],
        2,
        'behavioral',
      ),
    ).toBe(false)

    const update = getPathwayUpdateEligibility({
      answeredCount: 2,
      interviewType: 'behavioral',
      pathwayPlannerEnabled: true,
      feedback: null,
      evaluationCount: 2,
      pathwayGenerationStatus: null,
    })
    expect(update.reason).toBe('insufficient_answers')
    expect(update.poll).toBe(false)
  })

  it('eligible session in flight: pending + poll, plan items preserved', () => {
    const update = getPathwayUpdateEligibility({
      answeredCount: 5,
      pathwayPlannerEnabled: true,
      feedback: { overall_score: 72 },
      evaluationCount: 5,
      pathwayGenerationStatus: 'pending',
    })
    expect(update.poll).toBe(true)

    const vm = buildPathwayViewModel({
      pathway: makePathway({ generatedFromSessionId: 'older-session' }),
      competencySummary: null,
      weaknesses: [],
      fromFeedback: 'new-session',
      feedbackSessionStatus: 'pending',
      pathwayUpdate: update,
    })
    expect(vm.state).toBe('pending')
    expect(vm.pathwayUpdate?.poll).toBe(true)
    expect(vm.planItems.length).toBeGreaterThan(0)
  })

  it('terminal succeeded: not pending even when generatedFrom differs', () => {
    const update = getPathwayUpdateEligibility({
      answeredCount: 6,
      pathwayPlannerEnabled: true,
      feedback: { overall_score: 80 },
      evaluationCount: 6,
      pathwayGenerationStatus: 'succeeded',
    })
    const now = new Date('2026-05-20T00:00:00Z')
    const vm = buildPathwayViewModel({
      pathway: makePathway({
        generatedFromSessionId: 'older-session',
        generatedAt: new Date('2026-05-19T00:00:00Z'),
      }),
      competencySummary: null,
      weaknesses: [],
      fromFeedback: 'newer-session',
      feedbackSessionStatus: 'succeeded',
      pathwayUpdate: update,
      now,
    })
    expect(vm.state).not.toBe('pending')
    expect(vm.state).not.toBe('unchanged')
  })

  it('no scored feedback: unchanged with feedback CTA, not pending', () => {
    const update = getPathwayUpdateEligibility({
      answeredCount: 4,
      pathwayPlannerEnabled: true,
      feedback: null,
      evaluationCount: 4,
      pathwayGenerationStatus: null,
    })
    const vm = buildPathwayViewModel({
      pathway: makePathway(),
      competencySummary: null,
      weaknesses: [],
      fromFeedback: 'no-fb-session',
      pathwayUpdate: update,
    })
    expect(vm.state).toBe('unchanged')
    expect(vm.nextAction.id).toBe('regenerate-feedback')
  })
})
