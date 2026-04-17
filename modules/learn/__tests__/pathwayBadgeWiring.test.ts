import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('@shared/logger', () => ({
  logger: { error: vi.fn(), warn: vi.fn(), info: vi.fn() },
}))

const mockCheckAndAward = vi.fn().mockResolvedValue([])
vi.mock('@learn/services/badgeService', () => ({
  checkAndAwardBadges: (...args: unknown[]) => mockCheckAndAward(...args),
}))

import {
  registerPathwayBadgeWiring,
  resetPathwayBadgeWiring,
} from '../services/pathwayBadgeWiring'
import {
  clearPathwayEventHandlers,
  emitPathwayEvent,
} from '../services/pathwayEvents'

describe('pathwayBadgeWiring', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    clearPathwayEventHandlers()
    resetPathwayBadgeWiring()
  })

  it('translates phase_graduated event into badge check', async () => {
    registerPathwayBadgeWiring()
    await emitPathwayEvent({
      type: 'phase_graduated',
      userId: 'u1',
      timestamp: new Date(),
      payload: { graduatedPhase: 'foundation' },
    })

    expect(mockCheckAndAward).toHaveBeenCalledOnce()
    expect(mockCheckAndAward).toHaveBeenCalledWith('u1', {
      type: 'phase_graduated',
      graduatedPhase: 'foundation',
    })
  })

  it('translates competency_mastered event into badge check', async () => {
    registerPathwayBadgeWiring()
    await emitPathwayEvent({
      type: 'competency_mastered',
      userId: 'u1',
      timestamp: new Date(),
      payload: { competencyName: 'structure', consecutiveAtTarget: 5 },
    })

    expect(mockCheckAndAward).toHaveBeenCalledOnce()
    expect(mockCheckAndAward).toHaveBeenCalledWith('u1', {
      type: 'competency_mastered',
      consecutiveAtTarget: 5,
      masteredCompetency: 'structure',
    })
  })

  it('translates first_drill_completed event', async () => {
    registerPathwayBadgeWiring()
    await emitPathwayEvent({
      type: 'first_drill_completed',
      userId: 'u1',
      timestamp: new Date(),
      payload: {},
    })

    expect(mockCheckAndAward).toHaveBeenCalledWith('u1', { type: 'drill_complete' })
  })

  it('ignores non-actionable event types', async () => {
    registerPathwayBadgeWiring()
    await emitPathwayEvent({
      type: 'pathway_created',
      userId: 'u1',
      timestamp: new Date(),
      payload: {},
    })
    await emitPathwayEvent({
      type: 'phase_entered',
      userId: 'u1',
      timestamp: new Date(),
      payload: { phase: 'foundation' },
    })

    expect(mockCheckAndAward).not.toHaveBeenCalled()
  })

  it('registerPathwayBadgeWiring is idempotent', async () => {
    registerPathwayBadgeWiring()
    registerPathwayBadgeWiring()
    registerPathwayBadgeWiring()

    await emitPathwayEvent({
      type: 'phase_graduated',
      userId: 'u1',
      timestamp: new Date(),
      payload: { graduatedPhase: 'foundation' },
    })

    expect(mockCheckAndAward).toHaveBeenCalledOnce()
  })

  it('swallows badge-service errors without crashing the emitter', async () => {
    mockCheckAndAward.mockRejectedValueOnce(new Error('badge exploded'))
    registerPathwayBadgeWiring()

    await expect(emitPathwayEvent({
      type: 'phase_graduated',
      userId: 'u1',
      timestamp: new Date(),
      payload: { graduatedPhase: 'foundation' },
    })).resolves.toBeUndefined()
  })
})
