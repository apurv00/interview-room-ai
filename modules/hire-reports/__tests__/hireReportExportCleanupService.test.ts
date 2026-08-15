import mongoose from 'mongoose'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const IDS = {
  workspace: '1'.repeat(24),
  job: '2'.repeat(24),
  export: '3'.repeat(24),
  cleanup: '4'.repeat(24),
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

vi.mock('../services/hireReportBoundary', () => ({ connectHireReportDB: mocks.connect }))
vi.mock('@shared/logger', () => ({ logger: { warn: mocks.warn } }))
vi.mock('../models/HireReportExport', () => ({
  HIRE_REPORT_EXPORT_MAX_ATTEMPTS: 5,
  HIRE_REPORT_EXPORT_LEASE_MS: 5 * 60 * 1000,
  HireReportExport: {
    findOneAndUpdate: mocks.exportFindOneAndUpdate,
    findOne: mocks.exportFindOne,
    updateOne: mocks.exportUpdateOne,
  },
  hireReportExportObjectKey: (coordinate: Record<string, string>) =>
    `hire-report-exports/v1/${coordinate.workspaceId}/${coordinate.reportKind}/${coordinate.jobId ?? 'workspace'}/${coordinate.format}/${coordinate.reportId}.${coordinate.format}`,
}))
vi.mock('../models/HireReportExportCleanup', () => ({
  HIRE_REPORT_EXPORT_CLEANUP_LEASE_MS: 5 * 60 * 1000,
  HIRE_REPORT_EXPORT_CLEANUP_RECOVERY_LIMIT: 25,
  HIRE_REPORT_EXPORT_MAX_PUT_SETTLEMENT_MS: 2 * 60 * 1000,
  HireReportExportCleanup: {
    findOneAndUpdate: mocks.cleanupFindOneAndUpdate,
    updateOne: mocks.cleanupUpdateOne,
    deleteOne: mocks.cleanupDeleteOne,
    find: mocks.cleanupFind,
  },
}))
vi.mock('../services/hireReportExportStorage', () => ({
  hireReportExportStorage: { delete: mocks.storageDelete },
}))

import {
  hireReportExportCleanupNotBeforeAt,
  listDueHireReportExportCleanupIds,
  processHireReportExportCleanup,
} from '../services/hireReportExportCleanupService'

const objectId = (value: string) => new mongoose.Types.ObjectId(value)

function tombstone(overrides: Record<string, unknown> = {}) {
  return {
    _id: objectId(IDS.cleanup),
    workspaceId: objectId(IDS.workspace),
    reportKind: 'pipeline_status',
    reportScope: 'workspace',
    format: 'pdf',
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
  const query = { select: vi.fn(), lean: vi.fn().mockResolvedValue(value) }
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

describe('Hire report-export orphan cleanup recovery', () => {
  it('waits through the maximum active claim and bounded PutObject settlement before one-shot deletion', () => {
    const requestedAt = new Date('2026-08-14T10:00:00.000Z')
    expect(hireReportExportCleanupNotBeforeAt(requestedAt)).toEqual(
      new Date('2026-08-14T10:07:00.000Z'),
    )
  })

  it('derives and deletes only the exact report-coordinate object before settling its tombstone', async () => {
    const now = new Date('2026-08-14T10:10:00.000Z')

    await expect(processHireReportExportCleanup({ cleanupId: IDS.cleanup, now })).resolves.toBe('deleted')

    const coordinate = {
      workspaceId: IDS.workspace,
      reportId: IDS.export,
      reportKind: 'pipeline_status',
      reportScope: 'workspace',
      format: 'pdf',
    }
    expect(mocks.storageDelete).toHaveBeenCalledWith({
      key: `hire-report-exports/v1/${IDS.workspace}/pipeline_status/workspace/pdf/${IDS.export}.pdf`,
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
  })

  it('keeps the tombstone when private-object deletion fails and retries with opaque backoff', async () => {
    mocks.storageDelete.mockRejectedValue(new Error('R2 unavailable'))
    const now = new Date('2026-08-14T10:10:00.000Z')

    await expect(processHireReportExportCleanup({ cleanupId: IDS.cleanup, now })).resolves.toBe('retry_scheduled')

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

  it('retires a stale due tombstone without deleting a report object when a retry became ready', async () => {
    mocks.exportFindOneAndUpdate.mockReturnValue(selected(null))
    mocks.exportFindOne.mockReturnValue(selectedLean(terminalParent({
      status: 'ready',
      attempts: 2,
      objectCleanupPendingAt: undefined,
    })))

    await expect(processHireReportExportCleanup({
      cleanupId: IDS.cleanup,
      now: new Date('2026-08-14T10:10:00.000Z'),
    })).resolves.toBe('skipped')

    expect(mocks.storageDelete).not.toHaveBeenCalled()
    expect(mocks.cleanupDeleteOne).toHaveBeenCalledWith({
      _id: objectId(IDS.cleanup),
      claimToken: 'cleanup-claim',
    })
  })

  it('keeps globally orphaned cleanup eligible after a hard purge so a late upload is deleted', async () => {
    mocks.exportFindOneAndUpdate.mockReturnValue(selected(null))
    mocks.exportFindOne.mockReturnValue(selectedLean(null))

    await expect(processHireReportExportCleanup({
      cleanupId: IDS.cleanup,
      now: new Date('2026-08-14T10:10:00.000Z'),
    })).resolves.toBe('deleted')

    expect(mocks.storageDelete).toHaveBeenCalledTimes(1)
    expect(mocks.cleanupDeleteOne).toHaveBeenCalledWith({
      _id: objectId(IDS.cleanup),
      claimToken: 'cleanup-claim',
    })
  })

  it('gives a new never-swept tombstone priority over retry backlog', async () => {
    const freshChain = {
      sort: vi.fn().mockReturnThis(),
      limit: vi.fn().mockReturnThis(),
      select: vi.fn().mockReturnThis(),
      lean: vi.fn().mockResolvedValue([{ _id: objectId(IDS.cleanup) }]),
    }
    const retryChain = {
      sort: vi.fn().mockReturnThis(),
      limit: vi.fn().mockReturnThis(),
      select: vi.fn().mockReturnThis(),
      lean: vi.fn().mockResolvedValue(Array.from({ length: 24 }, () => ({ _id: new mongoose.Types.ObjectId() }))),
    }
    mocks.cleanupFind.mockReturnValueOnce(freshChain).mockReturnValueOnce(retryChain)
    const now = new Date('2026-08-14T10:10:00.000Z')

    const ids = await listDueHireReportExportCleanupIds({ limit: 25, now })

    expect(ids).toHaveLength(25)
    expect(ids[0]).toBe(IDS.cleanup)
    expect(mocks.cleanupFind.mock.calls[0]?.[0]).toMatchObject({
      cleanupNotBeforeAt: { $lte: now },
      firstSweepAt: { $exists: false },
    })
    expect(mocks.cleanupFind.mock.calls[1]?.[0]).toMatchObject({
      firstSweepAt: { $exists: true },
    })
  })
})
