import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('@shared/db/connection', () => ({
  connectDB: vi.fn().mockResolvedValue(undefined),
}))

vi.mock('@shared/featureFlags', () => ({
  isFeatureEnabled: vi.fn().mockReturnValue(true),
}))

vi.mock('@shared/logger', () => ({
  logger: { error: vi.fn(), warn: vi.fn(), info: vi.fn() },
}))

const mockFindOne = vi.fn()
const mockFindOneAndUpdate = vi.fn()
const mockUpdateOne = vi.fn()

vi.mock('@shared/db/models', () => ({
  PathwayPlan: {
    findOne: (...args: unknown[]) => {
      const chain = mockFindOne(...args)
      if (chain && typeof chain === 'object' && 'lean' in chain) return chain
      // Simulate a chainable query returning the final value directly when no chain
      return Object.assign(Promise.resolve(chain), {
        lean: () => Promise.resolve(chain),
      })
    },
    findOneAndUpdate: (...args: unknown[]) => mockFindOneAndUpdate(...args),
    updateOne: (...args: unknown[]) => mockUpdateOne(...args),
  },
  User: {},
}))

const mockCompetencySummary = vi.fn()
vi.mock('@learn/services/competencyService', () => ({
  getUserCompetencySummary: (...args: unknown[]) => mockCompetencySummary(...args),
  getUserWeaknesses: vi.fn().mockResolvedValue([]),
}))

vi.mock('@learn/services/sessionSummaryService', () => ({
  getRecentSummaries: vi.fn().mockResolvedValue([]),
}))

const mockEmit = vi.fn().mockResolvedValue(undefined)
vi.mock('@learn/services/pathwayEvents', () => ({
  emitPathwayEvent: (...args: unknown[]) => mockEmit(...args),
}))

vi.mock('@shared/services/modelRouter', () => ({
  completion: vi.fn(),
}))

vi.mock('@shared/services/promptSecurity', () => ({
  JSON_OUTPUT_RULE: '',
}))

import {
  generateUniversalPlan,
  advanceUniversalPlan,
  markLessonComplete,
} from '../services/pathwayPlanner'

describe('universalPlan', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockCompetencySummary.mockResolvedValue({
      weakAreas: ['specificity', 'ownership', 'structure'],
      strongAreas: ['communication', 'confidence'],
      overallReadiness: 60,
    })
  })

  describe('generateUniversalPlan', () => {
    it('creates a new plan at assessment phase with focused lessons', async () => {
      mockFindOne.mockReturnValue(null)
      mockFindOneAndUpdate.mockResolvedValue({
        _id: 'plan-1',
        planType: 'universal',
        currentPhase: 'assessment',
        lessons: [
          { competency: 'specificity', lessonId: 'k1', completed: false },
          { competency: 'ownership', lessonId: 'k2', completed: false },
          { competency: 'structure', lessonId: 'k3', completed: false },
        ],
      })

      const plan = await generateUniversalPlan({
        userId: '507f1f77bcf86cd799439011',
        domain: 'pm',
        depth: 'behavioral',
      })

      expect(plan).toBeTruthy()
      expect(plan!.currentPhase).toBe('assessment')
      expect(plan!.lessons).toHaveLength(3)
    })

    it('emits pathway_created event when plan is new', async () => {
      mockFindOne.mockReturnValue(null)
      mockFindOneAndUpdate.mockResolvedValue({ _id: 'plan-1', planType: 'universal', currentPhase: 'assessment', lessons: [] })

      await generateUniversalPlan({
        userId: '507f1f77bcf86cd799439011',
        domain: 'pm',
        depth: 'behavioral',
      })

      expect(mockEmit).toHaveBeenCalledOnce()
      expect(mockEmit.mock.calls[0][0].type).toBe('pathway_created')
    })

    it('does NOT emit pathway_created when plan already exists', async () => {
      mockFindOne.mockReturnValue({ _id: 'plan-1', sessionsCompleted: 3, planType: 'universal' })
      mockFindOneAndUpdate.mockResolvedValue({ _id: 'plan-1', planType: 'universal', currentPhase: 'foundation' })

      await generateUniversalPlan({
        userId: '507f1f77bcf86cd799439011',
        domain: 'pm',
        depth: 'behavioral',
      })

      expect(mockEmit).not.toHaveBeenCalled()
    })
  })

  describe('advanceUniversalPlan', () => {
    it('returns null when no universal plan exists', async () => {
      mockFindOne.mockReturnValue(null)
      const result = await advanceUniversalPlan('507f1f77bcf86cd799439011')
      expect(result).toBeNull()
    })

    it('increments sessionsCompleted and saves', async () => {
      const save = vi.fn().mockResolvedValue(undefined)
      const plan = { sessionsCompleted: 3, currentPhase: 'foundation', phaseHistory: [], save }
      mockFindOne.mockReturnValue(plan)

      await advanceUniversalPlan('507f1f77bcf86cd799439011')

      expect(plan.sessionsCompleted).toBe(4)
      expect(save).toHaveBeenCalledOnce()
    })

    it('emits phase_graduated + phase_entered when crossing threshold', async () => {
      const save = vi.fn().mockResolvedValue(undefined)
      // At 5 sessions, crossing to 6 graduates from foundation to building
      const plan = { sessionsCompleted: 5, currentPhase: 'foundation', phaseHistory: [], save }
      mockFindOne.mockReturnValue(plan)

      await advanceUniversalPlan('507f1f77bcf86cd799439011')

      expect(plan.sessionsCompleted).toBe(6)
      expect(plan.currentPhase).toBe('building')
      expect(mockEmit).toHaveBeenCalledTimes(2)
      expect(mockEmit.mock.calls[0][0].type).toBe('phase_graduated')
      expect(mockEmit.mock.calls[0][0].payload.graduatedPhase).toBe('foundation')
      expect(mockEmit.mock.calls[1][0].type).toBe('phase_entered')
      expect(mockEmit.mock.calls[1][0].payload.phase).toBe('building')
    })

    it('emits extra phase_graduated(review) when entering review phase', async () => {
      const save = vi.fn().mockResolvedValue(undefined)
      // At 27 sessions, crossing to 28 graduates mastery (threshold 28) → enters review
      const plan = { sessionsCompleted: 27, currentPhase: 'mastery', phaseHistory: [], save }
      mockFindOne.mockReturnValue(plan)

      await advanceUniversalPlan('507f1f77bcf86cd799439011')

      expect(plan.sessionsCompleted).toBe(28)
      expect(plan.currentPhase).toBe('review')
      expect(mockEmit).toHaveBeenCalledTimes(3)
      expect(mockEmit.mock.calls[0][0].type).toBe('phase_graduated')
      expect(mockEmit.mock.calls[0][0].payload.graduatedPhase).toBe('mastery')
      expect(mockEmit.mock.calls[1][0].type).toBe('phase_entered')
      expect(mockEmit.mock.calls[1][0].payload.phase).toBe('review')
      expect(mockEmit.mock.calls[2][0].type).toBe('phase_graduated')
      expect(mockEmit.mock.calls[2][0].payload.graduatedPhase).toBe('review')
    })

    it('does NOT emit review graduation for non-review transitions', async () => {
      const save = vi.fn().mockResolvedValue(undefined)
      // foundation → building (not review)
      const plan = { sessionsCompleted: 5, currentPhase: 'foundation', phaseHistory: [], save }
      mockFindOne.mockReturnValue(plan)

      await advanceUniversalPlan('507f1f77bcf86cd799439011')

      expect(mockEmit).toHaveBeenCalledTimes(2)
      const eventTypes = mockEmit.mock.calls.map((c: unknown[]) => (c[0] as { type: string }).type)
      expect(eventTypes).toEqual(['phase_graduated', 'phase_entered'])
    })

    it('does NOT emit events when staying in same phase', async () => {
      const save = vi.fn().mockResolvedValue(undefined)
      const plan = { sessionsCompleted: 3, currentPhase: 'foundation', phaseHistory: [], save }
      mockFindOne.mockReturnValue(plan)

      await advanceUniversalPlan('507f1f77bcf86cd799439011')

      expect(mockEmit).not.toHaveBeenCalled()
    })

    it('appends to phaseHistory on graduation', async () => {
      const save = vi.fn().mockResolvedValue(undefined)
      const plan = { sessionsCompleted: 1, currentPhase: 'assessment', phaseHistory: [], generatedAt: new Date(), save }
      mockFindOne.mockReturnValue(plan)

      await advanceUniversalPlan('507f1f77bcf86cd799439011')

      expect(plan.phaseHistory).toHaveLength(1)
      expect(plan.phaseHistory[0].phase).toBe('assessment')
    })
  })

  describe('markLessonComplete', () => {
    it('returns true when a lesson was updated', async () => {
      mockUpdateOne.mockResolvedValue({ modifiedCount: 1 })
      expect(await markLessonComplete('507f1f77bcf86cd799439011', 'lesson-1')).toBe(true)
    })

    it('returns false when no lesson matched', async () => {
      mockUpdateOne.mockResolvedValue({ modifiedCount: 0 })
      expect(await markLessonComplete('507f1f77bcf86cd799439011', 'missing')).toBe(false)
    })
  })
})
