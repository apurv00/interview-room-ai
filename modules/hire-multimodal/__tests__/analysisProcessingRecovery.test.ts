import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  connect: vi.fn(),
  analysisUpdateOne: vi.fn(),
  analysisFind: vi.fn(),
}))

vi.mock('@hire', () => ({
  HireMediaAsset: {},
  HirePrivacyRequest: {},
  HireRound: {},
  assertHireMediaKeyScope: vi.fn(),
  connectHireControlDB: mocks.connect,
}))
vi.mock('@interview', () => ({
  aggregateFacialData: vi.fn(),
  extractProsody: vi.fn(),
}))
vi.mock('../models', () => ({
  HireMultimodalAnalysis: {
    updateOne: mocks.analysisUpdateOne,
    find: mocks.analysisFind,
  },
}))
vi.mock('../services/hireMultimodalFusionService', () => ({
  runHireMultimodalFusion: vi.fn(),
}))

import {
  __hireMultimodalAnalysisProcessing,
  markHireMultimodalAnalysisFailed,
  recoverPendingHireMultimodalAnalyses,
} from '../services/analysisProcessingService'

const WORKSPACE_ID = 'a'.repeat(24)
const ANALYSIS_ID = 'b'.repeat(24)

beforeEach(() => {
  vi.clearAllMocks()
  mocks.connect.mockResolvedValue(undefined)
  mocks.analysisUpdateOne.mockResolvedValue({ matchedCount: 1 })
  mocks.analysisFind.mockReturnValue({
    sort: () => ({
      limit: () => ({
        select: () => ({ lean: async () => [] }),
      }),
    }),
  })
})

describe('Hire multimodal analysis processing recovery', () => {
  it('claims a processing report at its exact lease expiry and includes due retryable failures', () => {
    const now = new Date('2026-08-17T10:00:00.000Z')
    const clauses = __hireMultimodalAnalysisProcessing.dueAnalysisClaimClauses(now)

    expect(clauses).toContainEqual({
      status: 'processing',
      processingLeaseExpiresAt: { $lte: now },
    })
    expect(clauses).toContainEqual({
      status: 'failed',
      retryAt: { $lte: now },
      $or: [
        { retryAttemptCount: { $lt: __hireMultimodalAnalysisProcessing.MAX_AUTOMATIC_RETRY_ATTEMPTS } },
        { retryAttemptCount: { $exists: false } },
      ],
    })
  })

  it('marks a transient worker failure retryable with a bounded next retry', async () => {
    const now = new Date('2026-08-17T10:00:00.000Z')
    await markHireMultimodalAnalysisFailed({
      workspaceId: WORKSPACE_ID,
      analysisId: ANALYSIS_ID,
      errorCode: 'ProviderUnavailable',
      now,
    })

    expect(mocks.analysisUpdateOne).toHaveBeenCalledWith(
      expect.objectContaining({
        _id: ANALYSIS_ID,
        status: { $in: ['pending', 'processing'] },
      }),
      expect.objectContaining({
        $set: expect.objectContaining({
          status: 'failed',
          retryAt: new Date(now.getTime() + __hireMultimodalAnalysisProcessing.RETRY_BASE_MS),
        }),
        $inc: { retryAttemptCount: 1 },
      }),
    )
  })

  it('leaves an exhausted recovery visibly failed rather than stranded in processing', async () => {
    mocks.analysisUpdateOne
      .mockResolvedValueOnce({ matchedCount: 0 })
      .mockResolvedValueOnce({ matchedCount: 1 })

    await markHireMultimodalAnalysisFailed({
      workspaceId: WORKSPACE_ID,
      analysisId: ANALYSIS_ID,
    })

    expect(mocks.analysisUpdateOne).toHaveBeenCalledTimes(2)
    expect(mocks.analysisUpdateOne.mock.calls[1][1]).toEqual(expect.objectContaining({
      $set: expect.objectContaining({ status: 'failed' }),
      $unset: expect.objectContaining({ processingLeaseExpiresAt: 1, retryAt: 1 }),
    }))
  })

  it('queries the recovery sweep for due failed analyses as well as pending/expired leases', async () => {
    await recoverPendingHireMultimodalAnalyses({
      workspaceId: WORKSPACE_ID,
      batchSize: 25,
    })

    const filter = mocks.analysisFind.mock.calls[0][0]
    expect(filter.workspaceId).toBe(WORKSPACE_ID)
    expect(filter.$or).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ status: 'pending' }),
        expect.objectContaining({ status: 'processing' }),
        expect.objectContaining({ status: 'failed' }),
      ]),
    )
  })
})
