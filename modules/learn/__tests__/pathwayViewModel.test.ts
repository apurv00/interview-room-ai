import { describe, expect, it } from 'vitest'
import { buildPathwayViewModel } from '../services/pathwayViewModel'
import type { IPathwayPlan } from '@shared/db/models'

const NOW = new Date('2026-05-14T00:00:00.000Z')

function makePathway(overrides: Partial<IPathwayPlan> = {}): IPathwayPlan {
  return {
    _id: 'plan-1',
    userId: 'user-1',
    readinessLevel: 'developing',
    readinessScore: 62,
    topBlockingWeaknesses: [{
      competency: 'specificity',
      currentScore: 42,
      targetScore: 70,
      reason: 'Needs concrete examples',
    }],
    strengthsToPreserve: ['structure'],
    nextSessionRecommendation: {
      domain: 'pm',
      interviewType: 'behavioral',
      focusCompetencies: ['specificity'],
      difficulty: 'medium',
      reason: 'Continue behavioral practice with concrete examples',
    },
    practiceTasks: [{
      taskId: 'task-1',
      type: 'drill',
      title: 'Practice specificity',
      description: 'Add metrics to your strongest story.',
      targetCompetency: 'specificity',
      difficulty: 'medium',
      estimatedMinutes: 15,
      completed: false,
    }],
    milestones: [{
      name: 'Foundation',
      description: 'Score 50+',
      targetScore: 50,
      currentScore: 62,
      achieved: true,
    }],
    difficultyProgression: [],
    generatedFromSessionId: 'session-1',
    generatedAt: new Date('2026-05-14T00:00:00.000Z'),
    userGoal: 'improve',
    targetRole: 'pm',
    createdAt: new Date('2026-05-14T00:00:00.000Z'),
    updatedAt: new Date('2026-05-14T00:00:00.000Z'),
    ...overrides,
  } as unknown as IPathwayPlan
}

describe('buildPathwayViewModel — Pathway P2 Wave 4 (activityRhythm + decayProfile)', () => {
  it('returns nulls when lastSessionAt is undefined (never had a session)', () => {
    const result = buildPathwayViewModel({
      pathway: null,
      competencySummary: null,
      weaknesses: [],
      now: NOW,
    })
    expect(result.activityRhythm).toEqual({
      lastSessionAt: null,
      daysSinceLastSession: null,
      decayProfile: null,
    })
  })

  it('returns "fresh" when the user took an interview today or up to 2 days ago', () => {
    const result = buildPathwayViewModel({
      pathway: null,
      competencySummary: null,
      weaknesses: [],
      lastSessionAt: new Date('2026-05-13T00:00:00Z'), // 1 day before NOW
      now: NOW,
    })
    expect(result.activityRhythm.decayProfile).toBe('fresh')
    expect(result.activityRhythm.daysSinceLastSession).toBe(1)
  })

  it('returns "warmup" at 3-7 days', () => {
    const result = buildPathwayViewModel({
      pathway: null,
      competencySummary: null,
      weaknesses: [],
      lastSessionAt: new Date('2026-05-09T00:00:00Z'), // 5 days before NOW
      now: NOW,
    })
    expect(result.activityRhythm.decayProfile).toBe('warmup')
    expect(result.activityRhythm.daysSinceLastSession).toBe(5)
  })

  it('returns "rusty" at 8-21 days', () => {
    const result = buildPathwayViewModel({
      pathway: null,
      competencySummary: null,
      weaknesses: [],
      lastSessionAt: new Date('2026-05-02T00:00:00Z'), // 12 days before NOW
      now: NOW,
    })
    expect(result.activityRhythm.decayProfile).toBe('rusty')
    expect(result.activityRhythm.daysSinceLastSession).toBe(12)
  })

  it('returns "cold" at >21 days', () => {
    const result = buildPathwayViewModel({
      pathway: null,
      competencySummary: null,
      weaknesses: [],
      lastSessionAt: new Date('2026-04-01T00:00:00Z'), // 43 days before NOW
      now: NOW,
    })
    expect(result.activityRhythm.decayProfile).toBe('cold')
    expect(result.activityRhythm.daysSinceLastSession).toBe(43)
  })

  it('falls back to null nulls when lastSessionAt is not a valid date', () => {
    const result = buildPathwayViewModel({
      pathway: null,
      competencySummary: null,
      weaknesses: [],
      lastSessionAt: 'not-a-real-date',
      now: NOW,
    })
    expect(result.activityRhythm).toEqual({
      lastSessionAt: null,
      daysSinceLastSession: null,
      decayProfile: null,
    })
  })

  it('caps daysSinceLastSession at 0 (does not return negatives for future timestamps)', () => {
    const result = buildPathwayViewModel({
      pathway: null,
      competencySummary: null,
      weaknesses: [],
      lastSessionAt: new Date('2026-05-20T00:00:00Z'), // 6 days AFTER NOW
      now: NOW,
    })
    expect(result.activityRhythm.daysSinceLastSession).toBe(0)
    expect(result.activityRhythm.decayProfile).toBe('fresh')
  })

  it('attaches activityRhythm to every state, including pending and failed', () => {
    const pending = buildPathwayViewModel({
      pathway: makePathway({ generatedFromSessionId: 'older-session' } as Partial<IPathwayPlan>),
      competencySummary: null,
      weaknesses: [],
      fromFeedback: 'newer-session',
      lastSessionAt: new Date('2026-04-25T00:00:00Z'),
      now: NOW,
    })
    expect(pending.state).toBe('pending')
    expect(pending.activityRhythm.decayProfile).toBe('rusty')

    const failed = buildPathwayViewModel({
      pathway: makePathway({ generatedFromSessionId: 'older' } as Partial<IPathwayPlan>),
      competencySummary: null,
      weaknesses: [],
      fromFeedback: 'newer',
      feedbackSessionStatus: 'failed',
      lastSessionAt: new Date('2026-05-10T00:00:00Z'),
      now: NOW,
    })
    expect(failed.state).toBe('failed')
    expect(failed.activityRhythm.decayProfile).toBe('warmup')
  })
})

describe('buildPathwayViewModel — Pathway P2 Wave 3 (milestones + blockerInsights)', () => {
  it('exposes milestones as a UI-safe array (#9)', () => {
    const result = buildPathwayViewModel({
      pathway: makePathway({
        milestones: [
          {
            name: 'Foundation',
            description: 'Score 50+',
            targetScore: 50,
            currentScore: 62,
            achieved: true,
            achievedAt: new Date('2026-05-13T00:00:00.000Z'),
          },
          {
            name: 'Approaching ready',
            description: 'Score 70+',
            targetScore: 70,
            currentScore: 62,
            achieved: false,
          },
        ],
      } as Partial<IPathwayPlan>),
      competencySummary: null,
      weaknesses: [],
      now: NOW,
    })

    expect(result.progress.milestones).toHaveLength(2)
    expect(result.progress.milestones[0]).toMatchObject({
      name: 'Foundation',
      description: 'Score 50+',
      currentScore: 62,
      targetScore: 50,
      achieved: true,
      achievedAt: '2026-05-13T00:00:00.000Z',
    })
    expect(result.progress.milestones[1].achievedAt).toBeNull()
  })

  it('counts unique prior plans containing each current blocker (#8)', () => {
    const result = buildPathwayViewModel({
      pathway: makePathway({
        topBlockingWeaknesses: [
          { competency: 'specificity', currentScore: 42, targetScore: 70, reason: '' },
          { competency: 'structure', currentScore: 55, targetScore: 70, reason: '' },
        ],
      } as Partial<IPathwayPlan>),
      competencySummary: null,
      weaknesses: [],
      priorPlans: [
        // Plan A: both blockers appear
        {
          topBlockingWeaknesses: [
            { competency: 'specificity' },
            { competency: 'structure' },
          ],
        },
        // Plan B: specificity appears twice — should count once
        {
          topBlockingWeaknesses: [
            { competency: 'specificity' },
            { competency: 'specificity' },
            { competency: 'unrelated' },
          ],
        },
        // Plan C: structure only
        { topBlockingWeaknesses: [{ competency: 'structure' }] },
      ],
      now: NOW,
    })

    expect(result.progress.blockerInsights['specificity']?.recurrenceCount).toBe(2)
    expect(result.progress.blockerInsights['structure']?.recurrenceCount).toBe(2)
  })

  it('produces oldest-to-newest momentum capped to momentumWindow (#2)', () => {
    const result = buildPathwayViewModel({
      pathway: makePathway({
        topBlockingWeaknesses: [
          { competency: 'specificity', currentScore: 60, targetScore: 70, reason: '' },
        ],
      } as Partial<IPathwayPlan>),
      competencySummary: null,
      weaknesses: [],
      competencyStates: [
        {
          competencyName: 'specificity',
          scoreHistory: [
            { score: 30, timestamp: new Date('2026-04-01') },
            { score: 40, timestamp: new Date('2026-04-15') },
            { score: 45, timestamp: new Date('2026-05-01') },
            { score: 60, timestamp: new Date('2026-05-10') },
          ],
        },
      ],
      momentumWindow: 3,
      now: NOW,
    })

    const momentum = result.progress.blockerInsights['specificity']?.momentum ?? []
    expect(momentum).toHaveLength(3)
    expect(momentum[0].score).toBe(40)
    expect(momentum[2].score).toBe(60)
    // Sorted ascending by timestamp regardless of input order
    expect(momentum[0].at < momentum[1].at).toBe(true)
  })

  it('falls back to empty insight when no priors / states are passed', () => {
    const result = buildPathwayViewModel({
      pathway: makePathway(),
      competencySummary: null,
      weaknesses: [],
      now: NOW,
    })
    expect(result.progress.blockerInsights['specificity']).toEqual({
      recurrenceCount: 0,
      momentum: [],
    })
  })

  it('returns empty blockerInsights when blockers are empty', () => {
    const result = buildPathwayViewModel({
      pathway: makePathway({ topBlockingWeaknesses: [] } as Partial<IPathwayPlan>),
      competencySummary: null,
      weaknesses: [],
      priorPlans: [{ topBlockingWeaknesses: [{ competency: 'specificity' }] }],
      competencyStates: [
        {
          competencyName: 'specificity',
          scoreHistory: [{ score: 50, timestamp: new Date('2026-05-10') }],
        },
      ],
      now: NOW,
    })
    expect(result.progress.blockerInsights).toEqual({})
  })
})

describe('buildPathwayViewModel', () => {
  it('returns empty state with baseline interview action when no standard plan exists', () => {
    const result = buildPathwayViewModel({
      pathway: null,
      competencySummary: null,
      weaknesses: [],
      now: NOW,
    })

    expect(result.state).toBe('empty')
    expect(result.nextAction.href).toContain('/interview/setup?')
    expect(result.nextAction.href).toContain('actionId=baseline')
    expect(result.planItems).toEqual([])
  })

  it('returns active state with the first open plan action', () => {
    const result = buildPathwayViewModel({
      pathway: makePathway(),
      competencySummary: null,
      weaknesses: [],
      now: NOW,
    })

    expect(result.state).toBe('active')
    expect(result.nextAction.id).toBe('task-1')
    expect(result.nextAction.href).toContain('/practice/drill?')
    expect(result.progress.completedTasks).toBe(0)
  })

  it('returns pending from feedback until the generated session matches', () => {
    const result = buildPathwayViewModel({
      pathway: makePathway({ generatedFromSessionId: 'older-session' } as Partial<IPathwayPlan>),
      competencySummary: null,
      weaknesses: [],
      fromFeedback: 'session-2',
      now: NOW,
    })

    expect(result.state).toBe('pending')
    expect(result.nextAction.href).toBe('/feedback/session-2')
  })

  it('returns completed state when all tasks are done and blockers are cleared', () => {
    const result = buildPathwayViewModel({
      pathway: makePathway({
        readinessScore: 88,
        topBlockingWeaknesses: [],
        practiceTasks: [{
          taskId: 'task-1',
          type: 'review',
          title: 'Review feedback',
          description: 'Capture takeaways.',
          targetCompetency: 'self_awareness',
          difficulty: 'easy',
          estimatedMinutes: 10,
          completed: true,
        }],
      } as Partial<IPathwayPlan>),
      competencySummary: null,
      weaknesses: [],
      now: NOW,
    })

    expect(result.state).toBe('completed')
    expect(result.nextAction.id).toBe('challenge')
    expect(result.nextAction.href).toContain('difficulty=hard')
  })

  it('separates returning and abandoned states by plan age', () => {
    const returning = buildPathwayViewModel({
      pathway: makePathway({ generatedAt: new Date('2026-05-11T00:00:00.000Z') } as Partial<IPathwayPlan>),
      competencySummary: null,
      weaknesses: [],
      now: NOW,
    })

    const abandoned = buildPathwayViewModel({
      pathway: makePathway({ generatedAt: new Date('2026-05-01T00:00:00.000Z') } as Partial<IPathwayPlan>),
      competencySummary: null,
      weaknesses: [],
      now: NOW,
    })

    expect(returning.state).toBe('returning')
    expect(abandoned.state).toBe('abandoned')
  })

  // Bug B fix (2026-05-16) — when the upstream session's pathway
  // generation job has terminally failed (status: 'failed'), the view
  // model should expose a 'failed' state with a Retry CTA rather than
  // hanging on the perpetual 'pending' banner.
  describe('failed state from feedbackSessionStatus', () => {
    it('returns state="failed" when fromFeedback session has status="failed" and pathway is stale', () => {
      const result = buildPathwayViewModel({
        // pathway exists but for an EARLIER session, so isPendingForFeedback is true
        pathway: makePathway({ generatedFromSessionId: 'old-session' } as Partial<IPathwayPlan>),
        competencySummary: null,
        weaknesses: [],
        fromFeedback: 'new-session',
        feedbackSessionStatus: 'failed',
        feedbackSessionError: 'LLM call timed out',
        now: NOW,
      })
      expect(result.state).toBe('failed')
      expect(result.nextAction.id).toBe('retry-pathway')
      expect(result.nextAction.ctaLabel).toMatch(/retry/i)
      // sessionId must be available in metadata so the UI can POST to retry
      expect(result.nextAction.metadata?.sessionId).toBe('new-session')
    })

    it('surfaces the error message in the action description', () => {
      const result = buildPathwayViewModel({
        pathway: makePathway({ generatedFromSessionId: 'old' } as Partial<IPathwayPlan>),
        competencySummary: null,
        weaknesses: [],
        fromFeedback: 'new',
        feedbackSessionStatus: 'failed',
        feedbackSessionError: 'evaluateSession returned null',
        now: NOW,
      })
      expect(result.nextAction.description).toContain('evaluateSession returned null')
    })

    it('does NOT surface failed state when the pathway is already in sync (regen succeeded after the fail)', () => {
      const result = buildPathwayViewModel({
        // pathway IS for this session — no longer pending, no need for failed UI
        pathway: makePathway({ generatedFromSessionId: 'new' } as Partial<IPathwayPlan>),
        competencySummary: null,
        weaknesses: [],
        fromFeedback: 'new',
        feedbackSessionStatus: 'failed', // stale status; pathway was regenerated since
        now: NOW,
      })
      expect(result.state).not.toBe('failed')
    })

    // Bug: pre-fix, the catching-up banner stuck forever whenever the
    // user came from a feedback link whose pathway regen had already
    // SUCCEEDED (and the plan moved on to a newer session) or had been
    // SKIPPED (flag was off). The mismatch on generatedFromSessionId
    // alone wasn't enough to distinguish "regen still in flight" from
    // "regen already terminal".
    it('does NOT show pending banner when fromFeedback session has status="succeeded" but the plan has moved on', () => {
      const result = buildPathwayViewModel({
        // Plan has been regenerated for a NEWER session
        pathway: makePathway({ generatedFromSessionId: 'newer-session' } as Partial<IPathwayPlan>),
        competencySummary: null,
        weaknesses: [],
        // User came from the OLDER feedback page, whose regen succeeded long ago
        fromFeedback: 'older-session',
        feedbackSessionStatus: 'succeeded',
        now: NOW,
      })
      expect(result.state).not.toBe('pending')
    })

    it('does NOT show pending banner when fromFeedback session has status="skipped" (flag was off)', () => {
      const result = buildPathwayViewModel({
        pathway: makePathway({ generatedFromSessionId: 'some-other-session' } as Partial<IPathwayPlan>),
        competencySummary: null,
        weaknesses: [],
        fromFeedback: 'skipped-session',
        feedbackSessionStatus: 'skipped',
        now: NOW,
      })
      expect(result.state).not.toBe('pending')
    })

    it('falls through to pending banner when status is "running" (not failed)', () => {
      const result = buildPathwayViewModel({
        pathway: makePathway({ generatedFromSessionId: 'old' } as Partial<IPathwayPlan>),
        competencySummary: null,
        weaknesses: [],
        fromFeedback: 'new',
        feedbackSessionStatus: 'running',
        now: NOW,
      })
      expect(result.state).toBe('pending')
    })

    it('ignores feedbackSessionStatus when fromFeedback is absent', () => {
      const result = buildPathwayViewModel({
        pathway: makePathway(),
        competencySummary: null,
        weaknesses: [],
        feedbackSessionStatus: 'failed', // but no fromFeedback
        now: NOW,
      })
      expect(result.state).not.toBe('failed')
    })
  })
})
