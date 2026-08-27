import mongoose from 'mongoose'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  itemDistinct: vi.fn(),
  itemUpdateMany: vi.fn(),
  operationUpdateMany: vi.fn(),
  deleteSelections: vi.fn(),
}))

vi.mock('../../hire-operations/purge-boundary', () => ({
  deleteHireCandidateSelectionSubjectData: mocks.deleteSelections,
}))

vi.mock('../models', () => ({
  HIRE_CANDIDATE_BULK_ITEM_RETENTION_MS: 90 * 24 * 60 * 60 * 1000,
  HireCandidateBulkOperationItem: {
    distinct: mocks.itemDistinct,
    updateMany: mocks.itemUpdateMany,
  },
  HireCandidateBulkOperation: { updateMany: mocks.operationUpdateMany },
}))

import { redactHireCandidateActionSubjectData } from '../subject-lifecycle-boundary'

const WORKSPACE_ID = new mongoose.Types.ObjectId('1'.repeat(24))
const APPLICATION_ID = new mongoose.Types.ObjectId('2'.repeat(24))
const OPERATION_ID = new mongoose.Types.ObjectId('3'.repeat(24))
const NOW = new Date('2026-08-25T12:00:00.000Z')

describe('candidate action subject lifecycle boundary', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.itemDistinct.mockReturnValue({
      session: vi.fn().mockResolvedValue([OPERATION_ID]),
    })
    mocks.itemUpdateMany.mockResolvedValue({ matchedCount: 1 })
    mocks.operationUpdateMany.mockResolvedValue({ matchedCount: 1 })
    mocks.deleteSelections.mockResolvedValue(undefined)
  })

  it('fails closed outside a transaction', async () => {
    await expect(
      redactHireCandidateActionSubjectData({
        workspaceId: WORKSPACE_ID,
        applicationIds: [APPLICATION_ID],
        at: NOW,
        session: { inTransaction: () => false } as never,
      }),
    ).rejects.toThrow('requires a transaction')
    expect(mocks.itemDistinct).not.toHaveBeenCalled()
    expect(mocks.deleteSelections).not.toHaveBeenCalled()
  })

  it('terminally settles live work and removes the subject join coordinate', async () => {
    const session = { inTransaction: () => true } as never
    await redactHireCandidateActionSubjectData({
      workspaceId: WORKSPACE_ID,
      applicationIds: [APPLICATION_ID],
      at: NOW,
      session,
    })

    expect(mocks.deleteSelections).toHaveBeenCalledWith({
      workspaceId: WORKSPACE_ID,
      applicationIds: [APPLICATION_ID],
      session,
    })

    const scope = {
      workspaceId: WORKSPACE_ID,
      applicationId: { $in: [APPLICATION_ID] },
      privacyRedactedAt: { $exists: false },
    }
    expect(mocks.itemUpdateMany).toHaveBeenNthCalledWith(
      1,
      { ...scope, status: { $in: ['queued', 'processing'] } },
      {
        $set: {
          status: 'conflict',
          outcomeCode: 'CANDIDATE_PRIVACY_UNAVAILABLE',
          processedAt: NOW,
        },
      },
      { session },
    )
    expect(mocks.itemUpdateMany).toHaveBeenNthCalledWith(
      2,
      scope,
      expect.objectContaining({
        $set: { privacyRedactedAt: NOW },
        $unset: expect.objectContaining({ applicationId: 1, rowOperationId: 1 }),
      }),
      { session, overwriteImmutable: true },
    )
    expect(mocks.operationUpdateMany).toHaveBeenCalledWith(
      expect.objectContaining({ _id: { $in: [OPERATION_ID] } }),
      { $set: { nextRecoveryAt: NOW } },
      { session },
    )
  })
})
