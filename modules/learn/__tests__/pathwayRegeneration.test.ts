import { describe, it, expect, vi, beforeEach } from 'vitest'

const { mockInngestSend, mockFindByIdAndUpdate, mockFindOneAndUpdate, mockIsFeatureEnabled } = vi.hoisted(() => ({
  mockInngestSend: vi.fn().mockResolvedValue({ ids: ['evt-1'] }),
  mockFindByIdAndUpdate: vi.fn().mockResolvedValue(undefined),
  mockFindOneAndUpdate: vi.fn().mockResolvedValue({ _id: 'sess-1' }),
  mockIsFeatureEnabled: vi.fn((flag: string) => flag === 'pathway_planner'),
}))

vi.mock('@shared/db/connection', () => ({ connectDB: vi.fn().mockResolvedValue(undefined) }))
vi.mock('@shared/db/models', () => ({
  InterviewSession: {
    findByIdAndUpdate: mockFindByIdAndUpdate,
    findOneAndUpdate: mockFindOneAndUpdate,
  },
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
  // Use a real ObjectId-shaped hex string so `new mongoose.Types.ObjectId(sessionId)`
  // inside the service doesn't throw before reaching the mocked DB call.
  const SESSION_ID = '507f1f77bcf86cd799439011'

  beforeEach(() => {
    vi.clearAllMocks()
    mockInngestSend.mockResolvedValue({ ids: ['evt-1'] })
    mockFindOneAndUpdate.mockResolvedValue({ _id: SESSION_ID })
    mockFindByIdAndUpdate.mockResolvedValue(undefined)
    mockIsFeatureEnabled.mockImplementation((flag: string) => flag === 'pathway_planner')
  })

  it('atomically claims a failed/missing-status session, then emits pathway/regenerate', async () => {
    await enqueuePathwayRegeneration(SESSION_ID, 'user-1', { source: 'test' })

    expect(mockFindOneAndUpdate).toHaveBeenCalledTimes(1)
    const [filter, update] = mockFindOneAndUpdate.mock.calls[0]
    expect(filter.$or).toEqual([
      { pathwayGenerationStatus: 'failed' },
      { pathwayGenerationStatus: { $exists: false } },
      { pathwayGenerationStatus: null },
    ])
    expect(update.$set).toEqual({
      pathwayGenerationStatus: 'pending',
      pathwayGenerationUseSynthesizedFeedback: false,
    })
    expect(update.$unset).toEqual({ pathwayGenerationError: 1 })

    expect(mockInngestSend).toHaveBeenCalledWith({
      name: 'pathway/regenerate',
      data: { sessionId: SESSION_ID, userId: 'user-1' },
    })
  })

  it('sets useSynthesizedFeedback flag for degraded/outer-catch enqueues', async () => {
    await enqueuePathwayRegeneration(SESSION_ID, 'user-1', {
      source: 'generate-feedback-outer-catch',
      useSynthesizedFeedback: true,
    })
    const [, update] = mockFindOneAndUpdate.mock.calls[0]
    expect(update.$set.pathwayGenerationUseSynthesizedFeedback).toBe(true)
  })

  it('skips Inngest send when CAS claim returns null (already pending/running/succeeded)', async () => {
    // Status was already pending/running/succeeded/skipped — filter doesn't match.
    mockFindOneAndUpdate.mockResolvedValueOnce(null)

    await enqueuePathwayRegeneration(SESSION_ID, 'user-1', {
      source: 'generate-feedback-outer-catch',
    })

    expect(mockFindOneAndUpdate).toHaveBeenCalledTimes(1)
    expect(mockInngestSend).not.toHaveBeenCalled()
    // No rollback either — we never claimed.
    expect(mockFindByIdAndUpdate).not.toHaveBeenCalled()
  })

  it('rolls status back to failed when inngest.send throws after a successful claim', async () => {
    mockInngestSend.mockRejectedValueOnce(new Error('Inngest down'))
    await expect(enqueuePathwayRegeneration(SESSION_ID, 'user-1')).rejects.toThrow('Inngest down')

    expect(mockFindByIdAndUpdate).toHaveBeenCalledTimes(1)
    expect(mockFindByIdAndUpdate.mock.calls[0][1]).toEqual({
      $set: {
        pathwayGenerationStatus: 'failed',
        pathwayGenerationError: 'Inngest down',
      },
    })
  })
})
