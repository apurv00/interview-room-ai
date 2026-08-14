import mongoose from 'mongoose'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  find: vi.fn(),
  updateMany: vi.fn(),
  objectKey: vi.fn(),
  storageDelete: vi.fn(),
  ensureCleanup: vi.fn(),
  cleanupNotBeforeAt: vi.fn(),
}))

vi.mock('@hire-decisions/models', () => ({
  HireAssessmentExport: {
    find: (...args: unknown[]) => mocks.find(...args),
    updateMany: (...args: unknown[]) => mocks.updateMany(...args),
  },
  hireAssessmentExportObjectKey: (...args: unknown[]) => mocks.objectKey(...args),
}))

vi.mock('@hire-decisions/services/hireAssessmentExportStorage', () => ({
  hireAssessmentExportStorage: {
    delete: (...args: unknown[]) => mocks.storageDelete(...args),
  },
}))
vi.mock('@hire-decisions/services/hireAssessmentExportCleanupService', () => ({
  ensureHireAssessmentExportCleanupTombstone: (...args: unknown[]) => mocks.ensureCleanup(...args),
  hireAssessmentExportCleanupNotBeforeAt: (...args: unknown[]) => mocks.cleanupNotBeforeAt(...args),
}))

import {
  cancelHireAssessmentExports,
  deleteHireAssessmentExportObjects,
} from '../services/assessmentExportLifecycleService'

const WORKSPACE_ID = new mongoose.Types.ObjectId('111111111111111111111111')
const JOB_ID = new mongoose.Types.ObjectId('222222222222222222222222')
const APPLICATION_ID = new mongoose.Types.ObjectId('333333333333333333333333')
const CANDIDATE_ID = new mongoose.Types.ObjectId('444444444444444444444444')
const EXPORT_ID = new mongoose.Types.ObjectId('555555555555555555555555')
const NOW = new Date('2026-08-10T12:00:00.000Z')
const SESSION = {} as mongoose.ClientSession

function exportQuery(rows: unknown[]) {
  const query = {
    select: vi.fn(),
    session: vi.fn(),
    lean: vi.fn().mockResolvedValue(rows),
  }
  query.select.mockReturnValue(query)
  query.session.mockReturnValue(query)
  return query
}

describe('assessment export lifecycle cleanup', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.storageDelete.mockResolvedValue(undefined)
    mocks.updateMany.mockResolvedValue({ modifiedCount: 1 })
    mocks.objectKey.mockReturnValue('derived-key')
    mocks.cleanupNotBeforeAt.mockReturnValue(new Date(NOW.getTime() + 10 * 60_000))
    mocks.ensureCleanup.mockResolvedValue(new Date(NOW.getTime() + 10 * 60_000))
  })

  it('persists an immutable cleanup obligation before atomically cancelling and redacting it', async () => {
    const query = exportQuery([{
      _id: EXPORT_ID,
      workspaceId: WORKSPACE_ID,
      jobId: JOB_ID,
      applicationId: APPLICATION_ID,
      candidateId: CANDIDATE_ID,
    }])
    mocks.find.mockReturnValue(query)

    const targets = await cancelHireAssessmentExports({
      scope: { workspaceId: WORKSPACE_ID, candidateId: CANDIDATE_ID },
      cancelledAt: NOW,
      privacyRedactedAt: NOW,
      session: SESSION,
    })

    const coordinate = {
      workspaceId: WORKSPACE_ID.toString(),
      jobId: JOB_ID.toString(),
      applicationId: APPLICATION_ID.toString(),
      candidateId: CANDIDATE_ID.toString(),
      exportId: EXPORT_ID.toString(),
    }
    expect(mocks.find).toHaveBeenCalledWith({
      workspaceId: WORKSPACE_ID,
      candidateId: CANDIDATE_ID,
      status: { $ne: 'cancelled' },
    })
    expect(query.select).toHaveBeenCalledWith('_id workspaceId applicationId jobId candidateId')
    expect(query.session).toHaveBeenCalledWith(SESSION)
    expect(mocks.ensureCleanup).toHaveBeenCalledWith({
      coordinate,
      requestedAt: NOW,
      session: SESSION,
    })
    expect(mocks.ensureCleanup.mock.invocationCallOrder[0]).toBeLessThan(
      mocks.updateMany.mock.invocationCallOrder[0],
    )
    expect(mocks.updateMany).toHaveBeenCalledWith(
      {
        workspaceId: WORKSPACE_ID,
        candidateId: CANDIDATE_ID,
        status: { $ne: 'cancelled' },
      },
      {
        $set: {
          status: 'cancelled',
          cancelledAt: NOW,
          privacyRedactedAt: NOW,
          objectCleanupPendingAt: NOW,
        },
        $unset: {
          decisionSnapshot: 1,
          objectKey: 1,
          claimToken: 1,
          leaseExpiresAt: 1,
          nextRetryAt: 1,
          objectCleanupCompletedAt: 1,
          objectCleanupClaimToken: 1,
          objectCleanupLeaseExpiresAt: 1,
        },
      },
      { session: SESSION, overwriteImmutable: true },
    )
    expect(targets).toEqual([{
      key: 'derived-key',
      coordinate,
      cleanupNotBeforeAt: new Date(NOW.getTime() + 10 * 60_000),
    }])
    expect(mocks.storageDelete).not.toHaveBeenCalled()
  })

  it('derives the deterministic scoped key only when a legacy row has no selected key', async () => {
    const query = exportQuery([{
      _id: EXPORT_ID,
      workspaceId: WORKSPACE_ID,
      jobId: JOB_ID,
      applicationId: APPLICATION_ID,
      candidateId: CANDIDATE_ID,
    }])
    mocks.find.mockReturnValue(query)
    mocks.objectKey.mockReturnValue('derived-private-key')

    const targets = await cancelHireAssessmentExports({
      scope: { workspaceId: WORKSPACE_ID },
      cancelledAt: NOW,
      session: SESSION,
    })

    expect(mocks.objectKey).toHaveBeenCalledWith({
      workspaceId: WORKSPACE_ID.toString(),
      jobId: JOB_ID.toString(),
      applicationId: APPLICATION_ID.toString(),
      candidateId: CANDIDATE_ID.toString(),
      exportId: EXPORT_ID.toString(),
    })
    expect(targets).toEqual([expect.objectContaining({
      key: 'derived-private-key',
      cleanupNotBeforeAt: new Date(NOW.getTime() + 10 * 60_000),
    })])
  })

  it('runs a prompt post-commit delete but deliberately leaves the tombstone for late-upload recovery', async () => {
    const target = {
      key: 'persisted-key',
      coordinate: {
        workspaceId: WORKSPACE_ID.toString(),
        jobId: JOB_ID.toString(),
        applicationId: APPLICATION_ID.toString(),
        candidateId: CANDIDATE_ID.toString(),
        exportId: EXPORT_ID.toString(),
      },
      cleanupNotBeforeAt: new Date(NOW.getTime() + 10 * 60_000),
    }

    await deleteHireAssessmentExportObjects([target])

    expect(mocks.storageDelete).toHaveBeenCalledWith(target)
    // `deleteHireAssessmentExportObjects` has no tombstone settlement path:
    // an old worker could upload after this first delete. Global recovery owns
    // the later delete-and-settle operation after the quiescence horizon.
    expect(mocks.ensureCleanup).not.toHaveBeenCalled()
  })
})
