import { describe, it, expect, vi, beforeEach } from 'vitest'

const { mockInngestSend, mockFindByIdAndUpdate, mockIsFeatureEnabled } = vi.hoisted(() => ({
  mockInngestSend: vi.fn().mockResolvedValue({ ids: ['evt-1'] }),
  mockFindByIdAndUpdate: vi.fn().mockResolvedValue(undefined),
  mockIsFeatureEnabled: vi.fn((flag: string) => flag === 'pathway_planner'),
}))

vi.mock('@shared/db/connection', () => ({ connectDB: vi.fn().mockResolvedValue(undefined) }))
vi.mock('@shared/db/models', () => ({
  InterviewSession: { findByIdAndUpdate: mockFindByIdAndUpdate },
}))
vi.mock('@shared/services/inngest', () => ({
  inngest: { send: mockInngestSend },
}))
vi.mock('@shared/featureFlags', () => ({
  isFeatureEnabled: (flag: string) => mockIsFeatureEnabled(flag),
}))
vi.mock('@shared/logger', () => ({
  aiLogger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}))

import {
  canEnqueuePathwayRegeneration,
  enqueuePathwayRegeneration,
  synthesizeFeedbackForPathway,
} from '../services/pathwayRegeneration'

describe('synthesizeFeedbackForPathway', () => {
  it('returns null when evaluations are empty', () => {
    expect(synthesizeFeedbackForPathway([])).toBeNull()
  })

  it('builds a full FeedbackData shape from evaluations without persisting degraded', () => {
    const fb = synthesizeFeedbackForPathway([
      { questionIndex: 0, relevance: 60, structure: 55, specificity: 50, ownership: 65 } as never,
    ])
    expect(fb).not.toBeNull()
    expect(fb!.overall_score).toBeGreaterThan(0)
    expect(fb!.dimensions?.communication?.wpm).toBeDefined()
    expect(fb!.degraded).toBeUndefined()
  })
})

describe('canEnqueuePathwayRegeneration', () => {
  it('requires sessionId, evaluations, and pathway_planner flag', () => {
    expect(canEnqueuePathwayRegeneration('sess-1', [{ questionIndex: 0 }])).toBe(true)
    expect(canEnqueuePathwayRegeneration(undefined, [{ questionIndex: 0 }])).toBe(false)
    expect(canEnqueuePathwayRegeneration('sess-1', [])).toBe(false)
    mockIsFeatureEnabled.mockReturnValueOnce(false)
    expect(canEnqueuePathwayRegeneration('sess-1', [{ questionIndex: 0 }])).toBe(false)
  })
})

describe('enqueuePathwayRegeneration', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockInngestSend.mockResolvedValue({ ids: ['evt-1'] })
    mockFindByIdAndUpdate.mockResolvedValue(undefined)
    mockIsFeatureEnabled.mockImplementation((flag: string) => flag === 'pathway_planner')
  })

  it('marks pending then emits pathway/regenerate', async () => {
    await enqueuePathwayRegeneration('sess-1', 'user-1', { source: 'test' })
    expect(mockFindByIdAndUpdate).toHaveBeenCalledWith('sess-1', {
      $set: { pathwayGenerationStatus: 'pending' },
    })
    expect(mockInngestSend).toHaveBeenCalledWith({
      name: 'pathway/regenerate',
      data: { sessionId: 'sess-1', userId: 'user-1' },
    })
  })

  it('rolls status back to failed when inngest.send throws', async () => {
    mockInngestSend.mockRejectedValueOnce(new Error('Inngest down'))
    await expect(enqueuePathwayRegeneration('sess-1', 'user-1')).rejects.toThrow('Inngest down')
    expect(mockFindByIdAndUpdate.mock.calls[1][1]).toEqual({
      $set: {
        pathwayGenerationStatus: 'failed',
        pathwayGenerationError: 'Inngest down',
      },
    })
  })
})
