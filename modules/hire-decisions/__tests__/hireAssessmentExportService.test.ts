import mongoose from 'mongoose'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const IDS = {
  workspace: '1'.repeat(24),
  application: '2'.repeat(24),
  job: '3'.repeat(24),
  candidate: '4'.repeat(24),
  export: '5'.repeat(24),
  member: '6'.repeat(24),
}

const mocks = vi.hoisted(() => ({
  connect: vi.fn(),
  withTransaction: vi.fn(),
  claimCandidate: vi.fn(),
  claimNonTerminal: vi.fn(),
  resolveAuthority: vi.fn(),
  applicationFindOne: vi.fn(),
  jobUpdateOne: vi.fn(),
  privacyExists: vi.fn(),
  workspaceFind: vi.fn(),
  exportFindOne: vi.fn(),
  exportFind: vi.fn(),
  exportFindOneAndUpdate: vi.fn(),
  exportCreate: vi.fn(),
  exportUpdateOne: vi.fn(),
  decision: vi.fn(),
  generatePdf: vi.fn(),
  filename: vi.fn(),
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

vi.mock('@hire-decision-boundary', () => ({
  HireApplication: { findOne: mocks.applicationFindOne },
  HireJob: { updateOne: mocks.jobUpdateOne },
  HirePrivacyRequest: { exists: mocks.privacyExists },
  HireWorkspace: { find: mocks.workspaceFind },
  activeHireWorkspaceLifecycleFilter: () => ({}),
  claimHireCandidatePiiWriteFence: mocks.claimCandidate,
  claimNonTerminalHireApplicationDispatchFence: mocks.claimNonTerminal,
  HireCandidatePiiTombstoneError: class HireCandidatePiiTombstoneError extends Error {},
  resolveWorkspaceWriteAuthority: mocks.resolveAuthority,
  withActiveHireWorkspaceWriteTransaction: mocks.withTransaction,
}))
vi.mock('@shared/services/inngest', () => ({ inngest: { send: mocks.inngestSend } }))
vi.mock('@shared/logger', () => ({ logger: { warn: mocks.warn } }))
vi.mock('../models/HireAssessmentExport', () => ({
  HIRE_ASSESSMENT_EXPORT_EXPIRY_MS: 7 * 24 * 60 * 60 * 1000,
  HIRE_ASSESSMENT_EXPORT_LEASE_MS: 5 * 60 * 1000,
  HIRE_ASSESSMENT_EXPORT_MAX_ATTEMPTS: 5,
  HireAssessmentExport: {
    findOne: mocks.exportFindOne,
    find: mocks.exportFind,
    findOneAndUpdate: mocks.exportFindOneAndUpdate,
    create: mocks.exportCreate,
    updateOne: mocks.exportUpdateOne,
  },
  hireAssessmentExportObjectKey: (coordinate: Record<string, string>) =>
    `hire-assessment-exports/v1/${coordinate.workspaceId}/${coordinate.jobId}/${coordinate.applicationId}/${coordinate.candidateId}/${coordinate.exportId}.pdf`,
}))
vi.mock('../services/hireDecisionBoundary', () => ({ connectHireDecisionDB: mocks.connect }))
vi.mock('../services/decisionAggregateService', () => ({
  buildHireDecisionView: mocks.decision,
  HireDecisionError: class HireDecisionError extends Error {},
}))
vi.mock('../services/hireAssessmentPdfService', () => ({
  generateHireAssessmentPdf: mocks.generatePdf,
  hireAssessmentPdfFilename: mocks.filename,
}))
vi.mock('../services/hireAssessmentExportStorage', () => ({
  hireAssessmentExportStorage: {
    upload: mocks.upload,
    download: mocks.download,
    delete: mocks.delete,
  },
}))
vi.mock('../services/hireAssessmentExportCleanupService', () => ({
  ensureHireAssessmentExportCleanupTombstone: mocks.ensureCleanup,
}))

import {
  __hireAssessmentExport,
  getHireAssessmentExportStatus,
  listDueHireAssessmentExportIds,
  processHireAssessmentExport,
  requestHireAssessmentExport,
} from '../services/hireAssessmentExportService'

const objectId = (value: string) => new mongoose.Types.ObjectId(value)
const ctx = {
  workspace: { _id: objectId(IDS.workspace) },
  membership: { _id: objectId(IDS.member) },
} as any
const application = {
  _id: objectId(IDS.application),
  workspaceId: objectId(IDS.workspace),
  jobId: objectId(IDS.job),
  candidateId: objectId(IDS.candidate),
}

function decision(overrides: Record<string, unknown> = {}) {
  const tally = { strong_yes: 0, yes: 0, no: 0, strong_no: 0 }
  const source = {
    count: 0,
    recommendations: tally,
    dimensions: [
      'role_capability',
      'problem_solving',
      'communication',
      'collaboration',
    ].map((key) => ({ key, count: 0, mean: null, min: null, max: null, reviewerSpread: null })),
  }
  return {
    coordinates: {
      workspaceId: IDS.workspace,
      applicationId: IDS.application,
      jobId: IDS.job,
      candidateId: IDS.candidate,
    },
    candidateBrief: { candidateName: 'Ada Lovelace', jobTitle: 'Platform Engineer' },
    aiAssessments: [],
    humanScorecards: { total: source, member: { ...source, recommendations: { ...tally } }, kit: { ...source, recommendations: { ...tally } } },
    externalVerdicts: { count: 0, recommendations: tally },
    ...overrides,
  }
}

function exportRow(overrides: Record<string, unknown> = {}) {
  const requestedAt = new Date('2026-08-14T10:00:00.000Z')
  return {
    _id: objectId(IDS.export),
    workspaceId: objectId(IDS.workspace),
    applicationId: objectId(IDS.application),
    jobId: objectId(IDS.job),
    candidateId: objectId(IDS.candidate),
    creationOperationId: '11111111-1111-4111-8111-111111111111',
    objectKey: `hire-assessment-exports/v1/${IDS.workspace}/${IDS.job}/${IDS.application}/${IDS.candidate}/${IDS.export}.pdf`,
    decisionSnapshot: decision(),
    requestedAt,
    expiresAt: new Date('2099-08-14T10:00:00.000Z'),
    status: 'pending',
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
  mocks.claimNonTerminal.mockResolvedValue(undefined)
  mocks.resolveAuthority.mockResolvedValue(objectId(IDS.member))
  mocks.applicationFindOne.mockResolvedValue(application)
  mocks.jobUpdateOne.mockResolvedValue({ matchedCount: 1 })
  mocks.privacyExists.mockImplementation(() => scoped(null))
  mocks.decision.mockResolvedValue(decision())
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
  mocks.filename.mockReturnValue('candidate-assessment.pdf')
  mocks.upload.mockResolvedValue(undefined)
  mocks.download.mockResolvedValue(Buffer.from('%PDF-safe'))
  mocks.delete.mockResolvedValue(undefined)
  mocks.ensureCleanup.mockResolvedValue(new Date('2026-08-14T10:20:00.000Z'))
  mocks.inngestSend.mockResolvedValue(undefined)
})

describe('Hire assessment export service', () => {
  it('captures a deeply allowlisted decision snapshot and emits only durable IDs', async () => {
    const unsafe = decision({
      candidateBrief: { candidateName: 'Ada Lovelace', jobTitle: 'Platform Engineer', email: 'ada@example.com' },
      rawResume: 'do not persist',
      auditEvents: ['do not persist'],
    })
    mocks.decision.mockResolvedValue(unsafe)

    const result = await requestHireAssessmentExport(ctx, {
      applicationId: IDS.application,
      operationId: '11111111-1111-4111-8111-111111111111',
    })

    expect(result).toMatchObject({ created: true, export: { status: 'pending' } })
    const created = mocks.exportCreate.mock.calls[0]?.[0]?.[0]
    expect(created.objectKey).toMatch(new RegExp(`/${IDS.workspace}/${IDS.job}/${IDS.application}/${IDS.candidate}/`))
    const encoded = JSON.stringify(created.decisionSnapshot).toLowerCase()
    expect(encoded).not.toContain('ada@example.com')
    expect(encoded).not.toContain('do not persist')
    expect(mocks.inngestSend).toHaveBeenCalledWith({
      name: 'hire/assessment-export.requested',
      data: { workspaceId: IDS.workspace, exportId: result.export.id },
    })
    expect(JSON.stringify(mocks.inngestSend.mock.calls)).not.toContain('Ada Lovelace')
  })

  it('returns an opaque member status DTO rather than a key or stored snapshot', async () => {
    mocks.exportFindOne.mockResolvedValue(exportRow({
      status: 'ready',
      readyAt: new Date('2026-08-14T10:01:00.000Z'),
      decisionSnapshot: { ...decision(), rawResume: 'must not leak' },
    }))

    const view = await getHireAssessmentExportStatus(ctx, IDS.export)

    expect(view).toEqual({
      id: IDS.export,
      status: 'ready',
      requestedAt: new Date('2026-08-14T10:00:00.000Z'),
      expiresAt: new Date('2099-08-14T10:00:00.000Z'),
      readyAt: new Date('2026-08-14T10:01:00.000Z'),
    })
    expect(JSON.stringify(view)).not.toContain('hire-assessment-exports')
    expect(JSON.stringify(view)).not.toContain('must not leak')
  })

  it('returns 410 instead of advertising a ready export after expiry before cron redaction runs', async () => {
    mocks.exportFindOne.mockResolvedValue(exportRow({
      status: 'ready',
      readyAt: new Date('2020-08-14T10:01:00.000Z'),
      expiresAt: new Date('2020-08-14T10:02:00.000Z'),
    }))

    await expect(getHireAssessmentExportStatus(ctx, IDS.export)).rejects.toMatchObject({
      code: 'ASSESSMENT_EXPORT_EXPIRED',
    })

    expect(mocks.jobUpdateOne).not.toHaveBeenCalled()
  })

  it('fails closed when the job close fence wins before a snapshot can be read', async () => {
    mocks.jobUpdateOne.mockResolvedValue({ matchedCount: 0 })

    await expect(requestHireAssessmentExport(ctx, {
      applicationId: IDS.application,
      operationId: '11111111-1111-4111-8111-111111111111',
    })).rejects.toMatchObject({ code: 'JOB_NOT_OPEN' })

    expect(mocks.decision).not.toHaveBeenCalled()
    expect(mocks.exportCreate).not.toHaveBeenCalled()
  })

  it('deletes an uploaded object and cancels when privacy wins the final reauthorization', async () => {
    const row = exportRow()
    const claimed = exportRow({
      status: 'generating',
      attempts: 1,
      claimToken: 'claim-token',
      leaseExpiresAt: new Date('2099-08-14T10:05:00.000Z'),
    })
    let exportFindCount = 0
    mocks.exportFindOne.mockImplementation(() => {
      exportFindCount += 1
      if (exportFindCount === 1) return { select: vi.fn().mockResolvedValue(row) }
      return Promise.resolve(claimed)
    })
    mocks.exportFindOneAndUpdate.mockReturnValue({ select: vi.fn().mockResolvedValue(claimed) })
    let privacyChecks = 0
    mocks.privacyExists.mockImplementation(() => {
      privacyChecks += 1
      return scoped(privacyChecks === 4 ? { _id: 'privacy' } : null)
    })

    await expect(processHireAssessmentExport({ workspaceId: IDS.workspace, exportId: IDS.export })).resolves.toBe('cancelled')

    expect(mocks.generatePdf).toHaveBeenCalledWith(claimed.decisionSnapshot)
    expect(mocks.upload).toHaveBeenCalledWith(expect.objectContaining({ key: claimed.objectKey }))
    expect(mocks.delete).toHaveBeenCalledWith(expect.objectContaining({ key: claimed.objectKey }))
    expect(mocks.ensureCleanup).toHaveBeenCalledWith(expect.objectContaining({
      coordinate: expect.objectContaining({ exportId: IDS.export }),
    }))
    expect(mocks.exportUpdateOne).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ $set: expect.objectContaining({ status: 'cancelled' }) }),
      expect.anything(),
    )
  })

  it('persists a tombstone before expiry-driven cancellation, then retains it for late-upload recovery', async () => {
    const now = new Date('2026-08-14T10:00:00.000Z')
    const row = exportRow({
      status: 'ready',
      claimToken: 'expired-claim',
      leaseExpiresAt: new Date('2026-08-14T10:01:00.000Z'),
      expiresAt: new Date('2026-08-14T09:59:00.000Z'),
    })
    mocks.exportFindOne.mockReturnValue({ select: vi.fn().mockResolvedValue(row) })
    const cleanupNotBeforeAt = new Date('2026-08-14T10:10:00.000Z')
    mocks.ensureCleanup.mockResolvedValue(cleanupNotBeforeAt)

    await expect(processHireAssessmentExport({
      workspaceId: IDS.workspace,
      exportId: IDS.export,
      now,
    })).resolves.toBe('cancelled')

    expect(mocks.ensureCleanup).toHaveBeenCalledWith({
      coordinate: expect.objectContaining({
        workspaceId: IDS.workspace,
        applicationId: IDS.application,
        jobId: IDS.job,
        candidateId: IDS.candidate,
        exportId: IDS.export,
      }),
      requestedAt: now,
    })
    expect(mocks.ensureCleanup.mock.invocationCallOrder[0]).toBeLessThan(
      mocks.delete.mock.invocationCallOrder[0],
    )
    expect(mocks.exportUpdateOne).toHaveBeenCalledWith(
      expect.objectContaining({ status: { $ne: 'cancelled' } }),
      expect.objectContaining({
        $set: expect.objectContaining({
          status: 'cancelled',
          objectCleanupPendingAt: cleanupNotBeforeAt,
        }),
        $unset: expect.objectContaining({
          decisionSnapshot: 1,
          objectKey: 1,
        }),
      }),
      expect.anything(),
    )
  })

  it('marks an ambiguous attempt-five upload failure terminal before its best-effort delete, leaving global recovery eligible', async () => {
    const row = exportRow()
    const claimed = exportRow({
      status: 'generating',
      attempts: 5,
      claimToken: 'attempt-five',
      leaseExpiresAt: new Date('2099-08-14T10:05:00.000Z'),
    })
    let finds = 0
    mocks.exportFindOne.mockImplementation(() => {
      finds += 1
      if (finds === 1) return { select: vi.fn().mockResolvedValue(row) }
      return Promise.resolve(claimed)
    })
    mocks.exportFindOneAndUpdate.mockReturnValue({ select: vi.fn().mockResolvedValue(claimed) })
    mocks.upload.mockRejectedValue(new Error('ambiguous R2 response'))
    mocks.delete.mockRejectedValue(new Error('cleanup unavailable'))
    const cleanupNotBeforeAt = new Date('2026-08-14T10:20:00.000Z')
    mocks.ensureCleanup.mockResolvedValue(cleanupNotBeforeAt)

    await expect(processHireAssessmentExport({
      workspaceId: IDS.workspace,
      exportId: IDS.export,
    })).resolves.toBe('retry_scheduled')

    expect(mocks.exportUpdateOne).toHaveBeenCalledWith(
      expect.objectContaining({ status: 'generating', claimToken: 'attempt-five' }),
      expect.objectContaining({
        $set: expect.objectContaining({
          status: 'failed',
          objectCleanupPendingAt: cleanupNotBeforeAt,
        }),
        $unset: expect.objectContaining({ nextRetryAt: 1 }),
      }),
      expect.anything(),
    )
    expect(mocks.delete).toHaveBeenCalledWith(expect.objectContaining({ key: claimed.objectKey }))
  })

  it('finalizes an exhausted expired lease, clears it, and never takes a sixth egress claim', async () => {
    const row = exportRow({
      status: 'generating',
      attempts: 5,
      claimToken: 'crashed-attempt-five',
      leaseExpiresAt: new Date('2026-08-14T09:59:00.000Z'),
    })
    mocks.exportFindOne.mockReturnValue({ select: vi.fn().mockResolvedValue(row) })

    await expect(processHireAssessmentExport({
      workspaceId: IDS.workspace,
      exportId: IDS.export,
      now: new Date('2026-08-14T10:00:00.000Z'),
    })).resolves.toBe('skipped')

    expect(mocks.delete).toHaveBeenCalledWith(expect.objectContaining({ key: row.objectKey }))
    expect(mocks.ensureCleanup).toHaveBeenCalledWith(expect.objectContaining({
      coordinate: expect.objectContaining({ exportId: IDS.export }),
    }))
    expect(mocks.exportFindOneAndUpdate).not.toHaveBeenCalled()
    expect(mocks.exportUpdateOne).toHaveBeenCalledWith(
      expect.objectContaining({ attempts: { $gte: 5 } }),
      expect.objectContaining({
        $set: expect.objectContaining({ status: 'failed', failureCode: 'finalization_failed' }),
        $unset: expect.objectContaining({ claimToken: 1, leaseExpiresAt: 1 }),
      }),
      expect.anything(),
    )
  })

  it('includes an attempt-five expired lease in the minute recovery selection', async () => {
    const chain = {
      sort: vi.fn().mockReturnThis(),
      limit: vi.fn().mockReturnThis(),
      select: vi.fn().mockReturnThis(),
      lean: vi.fn().mockResolvedValue([{ _id: objectId(IDS.export) }]),
    }
    mocks.exportFind.mockReturnValue(chain)
    const now = new Date('2026-08-14T10:00:00.000Z')

    await expect(listDueHireAssessmentExportIds({ workspaceId: IDS.workspace, now })).resolves.toEqual([IDS.export])

    const filter = mocks.exportFind.mock.calls[0]?.[0] as {
      $or: Array<{ $or?: Array<{ status?: string; attempts?: { $gte?: number } }> }>
    }
    expect(filter.$or[1].$or).toContainEqual(expect.objectContaining({
      status: 'generating',
      attempts: { $gte: 5 },
    }))
  })

  it('deep-picks a future unsafe decision field before persistence', () => {
    const snapshot = __hireAssessmentExport.cloneHireAssessmentDecisionSnapshot(decision({
      candidateBrief: { candidateName: 'Ada Lovelace', jobTitle: 'Platform Engineer', email: 'ada@example.com' },
      rawEngineOutput: 'private',
      mediaAssetId: 'media',
    }) as any)
    const encoded = JSON.stringify(snapshot).toLowerCase()
    expect(encoded).not.toContain('ada@example.com')
    expect(encoded).not.toContain('private')
    expect(encoded).not.toContain('mediaasset')
  })
})
