import mongoose from 'mongoose'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { hireReportWorkbookQa } from './fixtures/reportWorkbookQa'

const IDS = {
  workspace: '1'.repeat(24),
  job: '2'.repeat(24),
  candidate: '3'.repeat(24),
  export: '4'.repeat(24),
  member: '5'.repeat(24),
}

const mocks = vi.hoisted(() => ({
  connect: vi.fn(),
  withTransaction: vi.fn(),
  claimCandidate: vi.fn(),
  resolveAuthority: vi.fn(),
  jobFindOne: vi.fn(),
  privacyExists: vi.fn(),
  privacyFilter: vi.fn(),
  workspaceFind: vi.fn(),
  workspaceFindOne: vi.fn(),
  workspaceExists: vi.fn(),
  exportFindOne: vi.fn(),
  exportFind: vi.fn(),
  exportFindOneAndUpdate: vi.fn(),
  exportCreate: vi.fn(),
  exportUpdateOne: vi.fn(),
  generatePdf: vi.fn(),
  generateXlsx: vi.fn(),
  pdfFilename: vi.fn(),
  xlsxFilename: vi.fn(),
  upload: vi.fn(),
  download: vi.fn(),
  delete: vi.fn(),
  ensureCleanup: vi.fn(),
  inngestSend: vi.fn(),
  warn: vi.fn(),
}))

function scoped<T>(value: T) {
  return { session: vi.fn().mockResolvedValue(value) }
}

function privacyRequestMatchesFilter(
  filter: Record<string, any>,
  request: { status: string; verificationExpiresAt: Date },
): boolean {
  if (filter.live !== true) return false
  if (!Array.isArray(filter.$or)) return true
  return filter.$or.some((condition: Record<string, any>) => {
    if (condition.status !== request.status) return false
    if (!condition.verificationExpiresAt) return true
    return request.verificationExpiresAt > condition.verificationExpiresAt.$gt
  })
}

vi.mock('@hire-decision-boundary', () => ({
  HireJob: { findOne: mocks.jobFindOne },
  HirePrivacyRequest: { exists: mocks.privacyExists },
  activeHirePrivacyRequestFilter: mocks.privacyFilter,
  HireWorkspace: {
    find: mocks.workspaceFind,
    findOne: mocks.workspaceFindOne,
    exists: mocks.workspaceExists,
  },
  activeHireWorkspaceLifecycleFilter: () => ({}),
  claimHireCandidatePiiWriteFence: mocks.claimCandidate,
  HireCandidatePiiTombstoneError: class HireCandidatePiiTombstoneError extends Error {},
  resolveWorkspaceWriteAuthority: mocks.resolveAuthority,
  withActiveHireWorkspaceWriteTransaction: mocks.withTransaction,
}))
vi.mock('@shared/services/inngest', () => ({ inngest: { send: mocks.inngestSend } }))
vi.mock('@shared/logger', () => ({ logger: { warn: mocks.warn } }))
vi.mock('../models/HireReportExport', () => ({
  HIRE_REPORT_EXPORT_EXPIRY_MS: 7 * 24 * 60 * 60 * 1000,
  HIRE_REPORT_EXPORT_LEASE_MS: 5 * 60 * 1000,
  HIRE_REPORT_EXPORT_MAX_ATTEMPTS: 5,
  HireReportExport: {
    findOne: mocks.exportFindOne,
    find: mocks.exportFind,
    findOneAndUpdate: mocks.exportFindOneAndUpdate,
    create: mocks.exportCreate,
    updateOne: mocks.exportUpdateOne,
  },
  hireReportExportObjectKey: (coordinate: Record<string, string>) =>
    `hire-report-exports/v1/${coordinate.workspaceId}/${coordinate.reportKind}/${coordinate.jobId ?? 'workspace'}/${coordinate.format}/${coordinate.reportId}.${coordinate.format}`,
}))
vi.mock('../services/hireReportBoundary', () => ({ connectHireReportDB: mocks.connect }))
vi.mock('../services/hireReportPdfService', () => ({
  generateHireReportPdf: mocks.generatePdf,
  hireReportPdfFilename: mocks.pdfFilename,
}))
vi.mock('../services/hireReportXlsxService', () => ({
  generateHireReportXlsx: mocks.generateXlsx,
  hireReportXlsxFilename: mocks.xlsxFilename,
}))
vi.mock('../services/hireReportExportStorage', () => ({
  HIRE_REPORT_EXPORT_CONTENT_TYPES: {
    pdf: 'application/pdf',
    xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  },
  hireReportExportStorage: {
    upload: mocks.upload,
    download: mocks.download,
    delete: mocks.delete,
  },
}))
vi.mock('../services/hireReportExportCleanupService', () => ({
  ensureHireReportExportCleanupTombstone: mocks.ensureCleanup,
}))

import {
  createHireJobCloseoutReport,
  downloadHireReportExport,
  getHireReportExportStatus,
  listHireReportExports,
  processHireReportExport,
  requestHirePipelineStatusReport,
} from '../services/hireReportExportService'

const objectId = (value: string) => new mongoose.Types.ObjectId(value)
const ctx = {
  workspace: { _id: objectId(IDS.workspace) },
  membership: { _id: objectId(IDS.member), name: 'Report Requester', email: 'ignored@example.test' },
} as any

function exportRow(overrides: Record<string, unknown> = {}) {
  const requestedAt = new Date('2026-08-14T10:00:00.000Z')
  return {
    _id: objectId(IDS.export),
    workspaceId: objectId(IDS.workspace),
    reportKind: 'pipeline_status',
    reportScope: 'workspace',
    format: 'pdf',
    creationOperationId: '11111111-1111-4111-8111-111111111111',
    requestedByMemberId: objectId(IDS.member),
    requestedByName: 'Report Requester',
    objectKey: `hire-report-exports/v1/${IDS.workspace}/pipeline_status/workspace/pdf/${IDS.export}.pdf`,
    reportSnapshot: hireReportWorkbookQa.pipeline,
    affectedCandidateIds: [],
    privacyAggregateFenceVersion: 0,
    requestedAt,
    expiresAt: new Date('2099-08-14T10:00:00.000Z'),
    status: 'requested',
    attempts: 0,
    nextRetryAt: requestedAt,
    ...overrides,
  }
}

beforeEach(() => {
  vi.clearAllMocks()
  mocks.connect.mockResolvedValue(undefined)
  mocks.withTransaction.mockImplementation(async (
    _workspace: unknown,
    _member: unknown,
    work: (session: object) => unknown,
  ) => work({}))
  mocks.claimCandidate.mockResolvedValue(undefined)
  mocks.resolveAuthority.mockResolvedValue(objectId(IDS.member))
  mocks.jobFindOne.mockResolvedValue({ _id: objectId(IDS.job), workspaceId: objectId(IDS.workspace) })
  mocks.privacyExists.mockImplementation(() => scoped(null))
  mocks.privacyFilter.mockImplementation((now: Date) => ({
    live: true,
    $or: [
      { status: 'processing' },
      { status: 'pending_verification', verificationExpiresAt: { $gt: now } },
    ],
  }))
  mocks.workspaceFind.mockReturnValue({
    select: vi.fn().mockReturnThis(),
    sort: vi.fn().mockReturnThis(),
    lean: vi.fn().mockResolvedValue([]),
  })
  mocks.workspaceFindOne.mockResolvedValue({ privacyAggregateFenceVersion: 0 })
  mocks.workspaceExists.mockImplementation(() => scoped({ _id: objectId(IDS.workspace) }))
  mocks.exportFindOne.mockResolvedValue(null)
  mocks.exportFind.mockReturnValue({
    sort: vi.fn().mockReturnThis(),
    limit: vi.fn().mockReturnThis(),
    select: vi.fn().mockReturnThis(),
    lean: vi.fn().mockResolvedValue([]),
  })
  mocks.exportFindOneAndUpdate.mockReturnValue({ select: vi.fn().mockResolvedValue(null) })
  mocks.exportCreate.mockImplementation(async (rows: any[]) => [rows[0]])
  mocks.exportUpdateOne.mockResolvedValue({ matchedCount: 1 })
  mocks.generatePdf.mockResolvedValue(Buffer.from('%PDF-safe'))
  mocks.generateXlsx.mockResolvedValue(Buffer.from('PK-safe'))
  mocks.pdfFilename.mockReturnValue('pipeline-status-report.pdf')
  mocks.xlsxFilename.mockReturnValue('pipeline-status-report.xlsx')
  mocks.upload.mockResolvedValue(undefined)
  mocks.download.mockResolvedValue(Buffer.from('%PDF-safe'))
  mocks.delete.mockResolvedValue(undefined)
  mocks.ensureCleanup.mockResolvedValue(new Date('2026-08-14T10:20:00.000Z'))
  mocks.inngestSend.mockResolvedValue(undefined)
})

describe('Hire report export service', () => {
  it('persists an immutable Hire-member requester snapshot and emits only durable IDs', async () => {
    const result = await requestHirePipelineStatusReport(ctx, {
      scope: 'workspace',
      format: 'pdf',
      operationId: '11111111-1111-4111-8111-111111111111',
    }, async () => ({ snapshot: hireReportWorkbookQa.pipeline, affectedCandidateIds: [] }))

    const created = mocks.exportCreate.mock.calls[0]?.[0]?.[0]
    expect(result).toMatchObject({ created: true, export: { status: 'requested' } })
    expect(created).toMatchObject({
      requestedByMemberId: ctx.membership._id,
      requestedByName: 'Report Requester',
      reportKind: 'pipeline_status',
      reportScope: 'workspace',
      affectedCandidateIds: [],
      privacyAggregateFenceVersion: 0,
    })
    expect(JSON.stringify(created)).not.toContain('ignored@example.test')
    expect(mocks.inngestSend).toHaveBeenCalledWith({
      name: 'hire/report-export.requested',
      data: { workspaceId: IDS.workspace, exportId: result.export.id },
    })
    expect(JSON.stringify(mocks.inngestSend.mock.calls)).not.toContain('Report Requester')
  })

  it('captures the exact workspace aggregate privacy epoch with the frozen pipeline snapshot', async () => {
    mocks.workspaceFindOne.mockResolvedValue({ privacyAggregateFenceVersion: 7 })
    const buildSnapshot = vi.fn(async () => ({
      snapshot: hireReportWorkbookQa.pipeline,
      affectedCandidateIds: [],
    }))

    await requestHirePipelineStatusReport(ctx, {
      scope: 'workspace',
      format: 'pdf',
      operationId: '12111111-1111-4111-8111-111111111111',
    }, buildSnapshot)

    const created = mocks.exportCreate.mock.calls[0]?.[0]?.[0]
    expect(created).toMatchObject({ privacyAggregateFenceVersion: 7 })
    expect(mocks.workspaceFindOne).toHaveBeenCalledWith(
      { _id: ctx.workspace._id },
      'privacyAggregateFenceVersion',
      { session: expect.anything() },
    )
    expect(buildSnapshot.mock.invocationCallOrder[0]).toBeLessThan(
      mocks.workspaceFindOne.mock.invocationCallOrder[0],
    )
  })

  it('fails closed and tombstones a frozen pipeline report when privacy advances before worker egress', async () => {
    const row = exportRow()
    mocks.exportFindOne.mockReturnValue({ select: vi.fn().mockResolvedValue(row) })
    mocks.workspaceExists.mockImplementation(() => scoped(null))

    await expect(processHireReportExport({
      workspaceId: IDS.workspace,
      exportId: IDS.export,
      now: new Date('2026-08-14T10:00:00.000Z'),
    })).resolves.toBe('cancelled')

    expect(mocks.exportFindOneAndUpdate).not.toHaveBeenCalled()
    expect(mocks.generatePdf).not.toHaveBeenCalled()
    expect(mocks.upload).not.toHaveBeenCalled()
    expect(mocks.ensureCleanup).toHaveBeenCalledWith(expect.objectContaining({
      coordinate: expect.objectContaining({ reportId: IDS.export }),
    }))
    expect(mocks.exportUpdateOne).toHaveBeenCalledWith(
      expect.objectContaining({ _id: objectId(IDS.export) }),
      expect.objectContaining({
        $set: expect.objectContaining({ status: 'cancelled', privacyRedactedAt: expect.any(Date) }),
        $unset: expect.objectContaining({ reportSnapshot: 1, objectKey: 1 }),
      }),
      expect.objectContaining({ overwriteImmutable: true }),
    )
  })

  it('rechecks the aggregate privacy epoch immediately before upload and cancels the race loser', async () => {
    const row = exportRow()
    const claimed = exportRow({
      status: 'generating',
      attempts: 1,
      claimToken: 'privacy-race-claim',
      leaseExpiresAt: new Date('2099-08-14T10:05:00.000Z'),
    })
    mocks.exportFindOne
      .mockReturnValueOnce({ select: vi.fn().mockResolvedValue(row) })
      .mockReturnValueOnce({ select: vi.fn().mockResolvedValue(claimed) })
      .mockReturnValueOnce({ select: vi.fn().mockResolvedValue(claimed) })
    mocks.exportFindOneAndUpdate.mockReturnValue({ select: vi.fn().mockResolvedValue(claimed) })
    mocks.workspaceExists
      .mockImplementationOnce(() => scoped({ _id: objectId(IDS.workspace) }))
      .mockImplementationOnce(() => scoped({ _id: objectId(IDS.workspace) }))
      .mockImplementationOnce(() => scoped({ _id: objectId(IDS.workspace) }))
      .mockImplementationOnce(() => scoped(null))

    await expect(processHireReportExport({
      workspaceId: IDS.workspace,
      exportId: IDS.export,
    })).resolves.toBe('cancelled')

    expect(mocks.generatePdf).toHaveBeenCalledWith(hireReportWorkbookQa.pipeline)
    expect(mocks.upload).not.toHaveBeenCalled()
    expect(mocks.exportUpdateOne).toHaveBeenCalledWith(
      expect.objectContaining({ _id: objectId(IDS.export) }),
      expect.objectContaining({ $set: expect.objectContaining({ status: 'cancelled' }) }),
      expect.objectContaining({ overwriteImmutable: true }),
    )
  })

  it('redacts a ready pipeline report before returning stale member status', async () => {
    const row = exportRow({
      status: 'ready',
      readyAt: new Date('2026-08-14T10:01:00.000Z'),
    })
    mocks.workspaceExists.mockImplementation(() => scoped(null))
    mocks.exportFindOne.mockReturnValue({ select: vi.fn().mockResolvedValue(row) })

    await expect(getHireReportExportStatus(ctx, IDS.export)).rejects.toMatchObject({
      code: 'REPORT_EXPORT_UNAVAILABLE',
    })
    expect(mocks.ensureCleanup).toHaveBeenCalledWith(expect.objectContaining({
      coordinate: expect.objectContaining({ reportId: IDS.export }),
    }))
    expect(mocks.exportUpdateOne).toHaveBeenCalledWith(
      expect.objectContaining({ _id: objectId(IDS.export) }),
      expect.objectContaining({
        $set: expect.objectContaining({ status: 'cancelled', privacyRedactedAt: expect.any(Date) }),
        $unset: expect.objectContaining({ objectKey: 1, reportSnapshot: 1, affectedCandidateIds: 1 }),
      }),
      expect.objectContaining({ overwriteImmutable: true }),
    )

  })

  it('tombstones a ready pipeline object instead of streaming it after its privacy epoch is stale', async () => {
    const row = exportRow({
      status: 'ready',
      readyAt: new Date('2026-08-14T10:01:00.000Z'),
    })
    mocks.workspaceExists.mockImplementation(() => scoped(null))
    mocks.exportFindOne.mockReturnValue({ select: vi.fn().mockResolvedValue(row) })

    await expect(downloadHireReportExport(ctx, IDS.export)).rejects.toMatchObject({
      code: 'REPORT_EXPORT_UNAVAILABLE',
    })

    expect(mocks.ensureCleanup).toHaveBeenCalledWith(expect.objectContaining({
      coordinate: expect.objectContaining({ reportId: IDS.export }),
    }))
    expect(mocks.exportUpdateOne).toHaveBeenCalledWith(
      expect.objectContaining({ _id: objectId(IDS.export) }),
      expect.objectContaining({
        $set: expect.objectContaining({ status: 'cancelled', privacyRedactedAt: expect.any(Date) }),
        $unset: expect.objectContaining({ objectKey: 1, reportSnapshot: 1, affectedCandidateIds: 1 }),
      }),
      expect.objectContaining({ overwriteImmutable: true }),
    )
    expect(mocks.download).not.toHaveBeenCalled()
  })

  it('requires an explicit Hire-member actor for closeout, persists it in the close transaction, and does not dispatch early', async () => {
    const now = new Date('2026-08-15T12:00:00.000Z')
    const expiredVerification = new Date('2026-08-15T11:59:59.000Z')
    mocks.privacyExists.mockImplementation((filter: Record<string, any>) => scoped(
      privacyRequestMatchesFilter(filter, {
        status: 'pending_verification',
        verificationExpiresAt: expiredVerification,
      }) ? { _id: 'expired-verification' } : null,
    ))
    const result = await createHireJobCloseoutReport({
      workspaceId: IDS.workspace,
      jobId: IDS.job,
      operationId: '22222222-2222-4222-8222-222222222222',
      requestedBy: { memberId: IDS.member, name: 'Closing Recruiter' },
      now,
      session: {} as any,
      snapshotInput: {
        ...hireReportWorkbookQa.closeout,
        hiredCandidates: [{
          candidateId: IDS.candidate,
          candidateName: '+Ada Lovelace',
          hiredAt: new Date('2026-08-14T10:00:00.000Z'),
        }],
      },
    })

    const created = mocks.exportCreate.mock.calls[0]?.[0]?.[0]
    expect(result).toMatchObject({ created: true, export: { reportKind: 'job_closeout', format: 'pdf' } })
    expect(created).toMatchObject({
      requestedByMemberId: objectId(IDS.member),
      requestedByName: 'Closing Recruiter',
      reportKind: 'job_closeout',
      reportScope: 'job',
      format: 'pdf',
    })
    expect(mocks.inngestSend).not.toHaveBeenCalled()
    expect(mocks.privacyExists).toHaveBeenCalledWith(expect.objectContaining({
      live: true,
      $or: [
        { status: 'processing' },
        { status: 'pending_verification', verificationExpiresAt: { $gt: now } },
      ],
    }))
    expect(mocks.privacyFilter).toHaveBeenCalledWith(now)
  })

  it('keeps a processing privacy request fail-closed for a new closeout', async () => {
    const now = new Date('2026-08-15T12:00:00.000Z')
    mocks.privacyExists.mockImplementation((filter: Record<string, any>) => scoped(
      privacyRequestMatchesFilter(filter, {
        status: 'processing',
        verificationExpiresAt: new Date('2026-08-15T13:00:00.000Z'),
      }) ? { _id: 'processing' } : null,
    ))

    await expect(createHireJobCloseoutReport({
      workspaceId: IDS.workspace,
      jobId: IDS.job,
      operationId: '33333333-3333-4333-8333-333333333333',
      requestedBy: { memberId: IDS.member, name: 'Closing Recruiter' },
      now,
      session: {} as any,
      snapshotInput: {
        ...hireReportWorkbookQa.closeout,
        hiredCandidates: [{
          candidateId: IDS.candidate,
          candidateName: '+Ada Lovelace',
          hiredAt: new Date('2026-08-14T10:00:00.000Z'),
        }],
      },
    })).rejects.toMatchObject({ code: 'CANDIDATE_PRIVACY_PENDING' })
    expect(mocks.exportCreate).not.toHaveBeenCalled()
    expect(mocks.claimCandidate).not.toHaveBeenCalled()
  })

  it('returns an opaque member status DTO without actor, snapshot, object key, or raw source', async () => {
    const row = exportRow({ status: 'ready', readyAt: new Date('2026-08-14T10:01:00.000Z') })
    mocks.exportFindOne.mockReturnValue({ select: vi.fn().mockResolvedValue(row) })

    const view = await getHireReportExportStatus(ctx, IDS.export)

    expect(view).toEqual({
      id: IDS.export,
      reportKind: 'pipeline_status',
      format: 'pdf',
      status: 'ready',
      requestedAt: new Date('2026-08-14T10:00:00.000Z'),
      expiresAt: new Date('2099-08-14T10:00:00.000Z'),
      readyAt: new Date('2026-08-14T10:01:00.000Z'),
    })
    const serialized = JSON.stringify(view)
    expect(serialized).not.toContain('Report Requester')
    expect(serialized).not.toContain('hire-report-exports')
    expect(serialized).not.toContain('candidateId')
  })

  it('lists only workspace-scoped opaque lifecycle rows without selecting report internals', async () => {
    const rows = [exportRow({
      status: 'ready',
      readyAt: new Date('2026-08-14T10:01:00.000Z'),
      reportSnapshot: { rawResume: 'never return this' },
      objectKey: 'hire-report-exports/v1/private.pdf',
      requestedByName: 'Private requester',
    })]
    const listQuery = {
      sort: vi.fn(),
      limit: vi.fn(),
      lean: vi.fn(),
    }
    listQuery.sort.mockReturnValue(listQuery)
    listQuery.limit.mockReturnValue(listQuery)
    listQuery.lean.mockResolvedValue(rows)
    mocks.exportFind.mockReturnValue(listQuery)

    const views = await listHireReportExports(ctx)

    expect(mocks.exportFind).toHaveBeenCalledWith(
      { workspaceId: ctx.workspace._id },
      '_id reportKind format status requestedAt expiresAt readyAt',
      { session: expect.anything() },
    )
    expect(listQuery.sort).toHaveBeenCalledWith({ requestedAt: -1, _id: -1 })
    expect(listQuery.limit).toHaveBeenCalledWith(50)
    expect(views).toEqual([{
      id: IDS.export,
      reportKind: 'pipeline_status',
      format: 'pdf',
      status: 'ready',
      requestedAt: new Date('2026-08-14T10:00:00.000Z'),
      expiresAt: new Date('2099-08-14T10:00:00.000Z'),
      readyAt: new Date('2026-08-14T10:01:00.000Z'),
    }])
    const encoded = JSON.stringify(views)
    expect(encoded).not.toContain('private.pdf')
    expect(encoded).not.toContain('Private requester')
    expect(encoded).not.toContain('rawResume')
  })

  it('persists the cleanup obligation before expiry status/redaction and best-effort deletion', async () => {
    const now = new Date('2026-08-14T10:00:00.000Z')
    const row = exportRow({
      status: 'ready',
      expiresAt: new Date('2026-08-14T09:59:00.000Z'),
      readyAt: new Date('2026-08-14T09:00:00.000Z'),
    })
    mocks.exportFindOne.mockReturnValue({ select: vi.fn().mockResolvedValue(row) })
    const cleanupNotBeforeAt = new Date('2026-08-14T10:10:00.000Z')
    mocks.ensureCleanup.mockResolvedValue(cleanupNotBeforeAt)

    await expect(processHireReportExport({
      workspaceId: IDS.workspace,
      exportId: IDS.export,
      now,
    })).resolves.toBe('expired')

    expect(mocks.ensureCleanup).toHaveBeenCalledWith({
      coordinate: expect.objectContaining({
        workspaceId: IDS.workspace,
        reportId: IDS.export,
        reportKind: 'pipeline_status',
        reportScope: 'workspace',
        format: 'pdf',
      }),
      requestedAt: now,
    })
    expect(mocks.ensureCleanup.mock.invocationCallOrder[0]).toBeLessThan(
      mocks.delete.mock.invocationCallOrder[0],
    )
    expect(mocks.exportUpdateOne).toHaveBeenCalledWith(
      expect.objectContaining({ status: { $nin: ['cancelled', 'expired'] } }),
      expect.objectContaining({
        $set: expect.objectContaining({
          status: 'expired',
          expiredAt: now,
          privacyRedactedAt: now,
          objectCleanupPendingAt: cleanupNotBeforeAt,
        }),
        $unset: expect.objectContaining({
          reportSnapshot: 1,
          objectKey: 1,
          affectedCandidateIds: 1,
        }),
      }),
      expect.objectContaining({ overwriteImmutable: true }),
    )
  })

  it('redacts a terminal failed snapshot only after its cleanup tombstone is durable', async () => {
    const row = exportRow()
    const claimed = exportRow({
      status: 'generating',
      attempts: 5,
      claimToken: 'attempt-five',
      leaseExpiresAt: new Date('2099-08-14T10:05:00.000Z'),
    })
    mocks.exportFindOne
      .mockReturnValueOnce({ select: vi.fn().mockResolvedValue(row) })
      .mockReturnValue({ select: vi.fn().mockResolvedValue(claimed) })
    mocks.exportFindOneAndUpdate.mockReturnValue({ select: vi.fn().mockResolvedValue(claimed) })
    mocks.upload.mockRejectedValue(new Error('ambiguous R2 response'))
    const cleanupNotBeforeAt = new Date('2026-08-14T10:20:00.000Z')
    mocks.ensureCleanup.mockResolvedValue(cleanupNotBeforeAt)

    await expect(processHireReportExport({
      workspaceId: IDS.workspace,
      exportId: IDS.export,
    })).resolves.toBe('retry_scheduled')

    expect(mocks.ensureCleanup.mock.invocationCallOrder[0]).toBeLessThan(
      mocks.exportUpdateOne.mock.invocationCallOrder[0],
    )
    expect(mocks.exportUpdateOne).toHaveBeenCalledWith(
      expect.objectContaining({ status: 'generating', claimToken: 'attempt-five' }),
      expect.objectContaining({
        $set: expect.objectContaining({
          status: 'failed',
          objectCleanupPendingAt: cleanupNotBeforeAt,
          privacyRedactedAt: expect.any(Date),
        }),
        $unset: expect.objectContaining({
          nextRetryAt: 1,
          reportSnapshot: 1,
          objectKey: 1,
          affectedCandidateIds: 1,
        }),
      }),
      expect.objectContaining({ overwriteImmutable: true }),
    )
    expect(mocks.delete).toHaveBeenCalledWith(expect.objectContaining({ key: claimed.objectKey }))
  })
})
