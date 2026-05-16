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
