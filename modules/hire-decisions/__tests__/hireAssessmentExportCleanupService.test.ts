import mongoose from 'mongoose'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const IDS = {
  workspace: '1'.repeat(24),
  application: '2'.repeat(24),
  job: '3'.repeat(24),
  candidate: '4'.repeat(24),
  export: '5'.repeat(24),
  cleanup: '6'.repeat(24),
}

const mocks = vi.hoisted(() => ({
  connect: vi.fn(),
  cleanupFindOneAndUpdate: vi.fn(),
  cleanupUpdateOne: vi.fn(),
  cleanupDeleteOne: vi.fn(),
  cleanupFind: vi.fn(),
  exportFindOneAndUpdate: vi.fn(),
  exportFindOne: vi.fn(),
  exportUpdateOne: vi.fn(),
  storageDelete: vi.fn(),
  warn: vi.fn(),
}))

vi.mock('../services/hireDecisionBoundary', () => ({ connectHireDecisionDB: mocks.connect }))
vi.mock('@shared/logger', () => ({ logger: { warn: mocks.warn } }))
vi.mock('../models/HireAssessmentExport', () => ({
  HIRE_ASSESSMENT_EXPORT_MAX_ATTEMPTS: 5,
  HIRE_ASSESSMENT_EXPORT_LEASE_MS: 5 * 60 * 1000,
  HireAssessmentExport: {
    findOneAndUpdate: mocks.exportFindOneAndUpdate,
    findOne: mocks.exportFindOne,
    updateOne: mocks.exportUpdateOne,
  },
  hireAssessmentExportObjectKey: (coordinate: Record<string, string>) =>
    `hire-assessment-exports/v1/${coordinate.workspaceId}/${coordinate.jobId}/${coordinate.applicationId}/${coordinate.candidateId}/${coordinate.exportId}.pdf`,
}))
vi.mock('../models/HireAssessmentExportCleanup', () => ({
  HIRE_ASSESSMENT_EXPORT_CLEANUP_LEASE_MS: 5 * 60 * 1000,
  HIRE_ASSESSMENT_EXPORT_CLEANUP_RECOVERY_LIMIT: 25,
  HIRE_ASSESSMENT_EXPORT_MAX_PUT_SETTLEMENT_MS: 2 * 60 * 1000,
  HireAssessmentExportCleanup: {
    findOneAndUpdate: mocks.cleanupFindOneAndUpdate,
    updateOne: mocks.cleanupUpdateOne,
    deleteOne: mocks.cleanupDeleteOne,
    find: mocks.cleanupFind,
  },
}))
vi.mock('../services/hireAssessmentExportStorage', () => ({
  hireAssessmentExportStorage: { delete: mocks.storageDelete },
}))

import {
  hireAssessmentExportCleanupNotBeforeAt,
  listDueHireAssessmentExportCleanupIds,
  processHireAssessmentExportCleanup,
} from '../services/hireAssessmentExportCleanupService'

const objectId = (value: string) => new mongoose.Types.ObjectId(value)

function tombstone(overrides: Record<string, unknown> = {}) {
  return {
    _id: objectId(IDS.cleanup),
    workspaceId: objectId(IDS.workspace),
    applicationId: objectId(IDS.application),
    jobId: objectId(IDS.job),
    candidateId: objectId(IDS.candidate),
    exportId: objectId(IDS.export),
    cleanupNotBeforeAt: new Date('2026-08-14T10:00:00.000Z'),
    nextRetryAt: new Date('2026-08-14T10:00:00.000Z'),
    attempts: 1,
    claimToken: 'cleanup-claim',
    leaseExpiresAt: new Date('2026-08-14T10:05:00.000Z'),
    ...overrides,
  }
}

function selected<T>(value: T) {
  return { select: vi.fn().mockResolvedValue(value) }
}

function selectedLean<T>(value: T) {
  const query = {
    select: vi.fn(),
    lean: vi.fn().mockResolvedValue(value),
  }
  query.select.mockReturnValue(query)
  return query
}

function terminalParent(overrides: Record<string, unknown> = {}) {
  return {
    _id: objectId(IDS.export),
    workspaceId: objectId(IDS.workspace),
    status: 'cancelled',
    attempts: 1,
    objectCleanupPendingAt: new Date('2026-08-14T10:00:00.000Z'),
    ...overrides,
  }
}

beforeEach(() => {
  vi.clearAllMocks()
  mocks.connect.mockResolvedValue(undefined)
  mocks.cleanupFindOneAndUpdate.mockReturnValue({ select: vi.fn().mockResolvedValue(tombstone()) })
  mocks.exportFindOneAndUpdate.mockReturnValue(selected(terminalParent({
    objectCleanupClaimToken: 'cleanup-claim',
  })))
  mocks.exportFindOne.mockReturnValue(selectedLean(null))
  mocks.cleanupDeleteOne.mockResolvedValue({ deletedCount: 1 })
  mocks.cleanupUpdateOne.mockResolvedValue({ matchedCount: 1 })
  mocks.exportUpdateOne.mockResolvedValue({ matchedCount: 1 })
  mocks.storageDelete.mockResolvedValue(undefined)
  mocks.cleanupFind.mockReturnValue({
    sort: vi.fn().mockReturnThis(),
    limit: vi.fn().mockReturnThis(),
    select: vi.fn().mockReturnThis(),
    lean: vi.fn().mockResolvedValue([]),
  })
})

describe('Hire assessment-export orphan cleanup recovery', () => {
  it('waits through the maximum active claim and bounded PutObject settlement before one-shot deletion', () => {
    const requestedAt = new Date('2026-08-14T10:00:00.000Z')
    expect(hireAssessmentExportCleanupNotBeforeAt(requestedAt)).toEqual(
      new Date('2026-08-14T10:07:00.000Z'),
    )
  })

  it('derives and deletes only the exact full-coordinate private object before settling its one-shot tombstone', async () => {
    const now = new Date('2026-08-14T10:10:00.000Z')

    await expect(processHireAssessmentExportCleanup({ cleanupId: IDS.cleanup, now })).resolves.toBe('deleted')

    const coordinate = {
      workspaceId: IDS.workspace,
      jobId: IDS.job,
      applicationId: IDS.application,
      candidateId: IDS.candidate,
      exportId: IDS.export,
    }
    expect(mocks.storageDelete).toHaveBeenCalledWith({
      key: `hire-assessment-exports/v1/${IDS.workspace}/${IDS.job}/${IDS.application}/${IDS.candidate}/${IDS.export}.pdf`,
      coordinate,
    })
    expect(mocks.exportUpdateOne).toHaveBeenCalledWith(
      {
        _id: objectId(IDS.export),
        workspaceId: objectId(IDS.workspace),
        objectCleanupClaimToken: 'cleanup-claim',
        $or: expect.any(Array),
      },
      {
        $set: { objectCleanupCompletedAt: now },
        $unset: {
          objectCleanupPendingAt: 1,
          objectCleanupClaimToken: 1,
          objectCleanupLeaseExpiresAt: 1,
        },
      },
      { timestamps: false, overwriteImmutable: true },
    )
    expect(mocks.storageDelete.mock.invocationCallOrder[0]).toBeLessThan(
      mocks.cleanupDeleteOne.mock.invocationCallOrder[0],
    )
    expect(mocks.cleanupFindOneAndUpdate).toHaveBeenCalledWith(
      expect.anything(),
      [expect.objectContaining({
        $set: expect.objectContaining({
          firstSweepAt: { $ifNull: ['$firstSweepAt', now] },
        }),
      })],
      { new: true, timestamps: false },
    )
  })

  it('keeps the tombstone when private-object deletion fails and retries with an opaque backoff', async () => {
    mocks.storageDelete.mockRejectedValue(new Error('R2 unavailable'))
    const now = new Date('2026-08-14T10:10:00.000Z')

    await expect(processHireAssessmentExportCleanup({ cleanupId: IDS.cleanup, now })).resolves.toBe('retry_scheduled')

    expect(mocks.cleanupDeleteOne).not.toHaveBeenCalled()
    expect(mocks.cleanupUpdateOne).toHaveBeenCalledWith(
      { _id: objectId(IDS.cleanup), claimToken: 'cleanup-claim' },
      expect.objectContaining({
        $set: expect.objectContaining({ lastFailureAt: expect.any(Date), nextRetryAt: expect.any(Date) }),
        $unset: { claimToken: 1, leaseExpiresAt: 1 },
      }),
      { timestamps: false },
    )
  })

  it('retires a stale due tombstone without deleting storage when a retry has become ready', async () => {
    mocks.exportFindOneAndUpdate.mockReturnValue(selected(null))
    mocks.exportFindOne.mockReturnValue(selectedLean(terminalParent({
      status: 'ready',
      attempts: 2,
      objectCleanupPendingAt: undefined,
    })))

    await expect(processHireAssessmentExportCleanup({
      cleanupId: IDS.cleanup,
      now: new Date('2026-08-14T10:10:00.000Z'),
    })).resolves.toBe('skipped')

    expect(mocks.storageDelete).not.toHaveBeenCalled()
    expect(mocks.cleanupDeleteOne).toHaveBeenCalledWith({
      _id: objectId(IDS.cleanup),
      claimToken: 'cleanup-claim',
    })
  })

  it('loses safely to a concurrent retry claim instead of deleting its future ready object', async () => {
    // The terminal-parent CAS loses because the retry claim changed the row to
    // generating between the cleanup event and its parent gate.
    mocks.exportFindOneAndUpdate.mockReturnValue(selected(null))
    mocks.exportFindOne.mockReturnValue(selectedLean(terminalParent({
      status: 'generating',
      attempts: 2,
      objectCleanupPendingAt: undefined,
    })))

    await expect(processHireAssessmentExportCleanup({
      cleanupId: IDS.cleanup,
      now: new Date('2026-08-14T10:10:00.000Z'),
    })).resolves.toBe('skipped')

    expect(mocks.storageDelete).not.toHaveBeenCalled()
    expect(mocks.cleanupDeleteOne).toHaveBeenCalledWith({
      _id: objectId(IDS.cleanup),
      claimToken: 'cleanup-claim',
    })
  })

  it('re-deletes a late worker upload after the first post-commit delete, even after hard purge removes the parent', async () => {
    let objectPresent = true
    mocks.storageDelete.mockImplementation(async () => { objectPresent = false })
    // The first direct post-commit delete wins before an old worker's upload.
    await mocks.storageDelete({ key: 'deterministic-key', coordinate: {} })
    expect(objectPresent).toBe(false)
    // The old worker then uploads and crashes; the workspace/export parent has
    // been hard-purged, but the globally selected tombstone still survives.
    objectPresent = true
    mocks.exportFindOneAndUpdate.mockReturnValue(selected(null))
    mocks.exportFindOne.mockReturnValue(selectedLean(null))
    mocks.cleanupFindOneAndUpdate.mockReturnValueOnce(selected(tombstone()))

    await expect(processHireAssessmentExportCleanup({
      cleanupId: IDS.cleanup,
      now: new Date('2026-08-14T10:10:00.000Z'),
    })).resolves.toBe('deleted')

    expect(objectPresent).toBe(false)
    // Upload requests are bounded by the original claim's absolute lease,
    // and this sweep is delayed through that lease plus settlement grace, so
    // the one successful delete can now settle the durable tombstone.
    expect(mocks.storageDelete).toHaveBeenCalledTimes(2)
    expect(mocks.cleanupDeleteOne).toHaveBeenCalledWith({
      _id: objectId(IDS.cleanup),
      claimToken: 'cleanup-claim',
    })
  })

  it('gives a new never-swept tombstone priority over more than one recovery batch of old retries or crashed first claims', async () => {
    const freshChain = {
      sort: vi.fn().mockReturnThis(),
      limit: vi.fn().mockReturnThis(),
      select: vi.fn().mockReturnThis(),
      lean: vi.fn().mockResolvedValue([{ _id: objectId(IDS.cleanup) }]),
    }
    // These model first attempts that crashed after the atomic firstSweepAt
    // claim marker; they must re-enter only the retry lane after lease expiry.
    const oldRetries = Array.from({ length: 26 }, () => ({ _id: new mongoose.Types.ObjectId() }))
    const retryChain = {
      sort: vi.fn().mockReturnThis(),
      limit: vi.fn().mockReturnThis(),
      select: vi.fn().mockReturnThis(),
      lean: vi.fn().mockResolvedValue(oldRetries.slice(0, 24)),
    }
    mocks.cleanupFind
      .mockReturnValueOnce(freshChain)
      .mockReturnValueOnce(retryChain)
    const now = new Date('2026-08-14T10:10:00.000Z')

    const ids = await listDueHireAssessmentExportCleanupIds({ limit: 25, now })

    expect(ids).toHaveLength(25)
    expect(ids[0]).toBe(IDS.cleanup)

    const freshFilter = mocks.cleanupFind.mock.calls[0]?.[0] as Record<string, unknown>
    const retryFilter = mocks.cleanupFind.mock.calls[1]?.[0] as Record<string, unknown>
    expect(freshFilter.workspaceId).toBeUndefined()
    expect(freshFilter.cleanupNotBeforeAt).toEqual({ $lte: now })
    expect(freshFilter.firstSweepAt).toEqual({ $exists: false })
    expect(retryFilter.firstSweepAt).toEqual({ $exists: true })
    expect(freshChain.limit).toHaveBeenCalledWith(25)
    expect(retryChain.limit).toHaveBeenCalledWith(24)
    expect(freshChain.sort).toHaveBeenCalledWith({
      cleanupNotBeforeAt: 1,
      nextRetryAt: 1,
      _id: 1,
    })
  })
})
