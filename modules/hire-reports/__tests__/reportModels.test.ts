import mongoose, { type Model } from 'mongoose'
import { describe, expect, it } from 'vitest'
import {
  HIRE_REPORT_EXPORT_EXPIRY_MS,
  HireReportExport,
  hireReportExportObjectKey,
  parseHireReportExportObjectKey,
  type IHireReportExport,
} from '../models/HireReportExport'
import { HireReportExportCleanup } from '../models/HireReportExportCleanup'
import {
  buildHireJobCloseoutReportSnapshot,
  buildHirePipelineStatusReportSnapshot,
} from '../services/reportSnapshotBuilders'
import {
  HIRE_REPORT_AGING_BUCKETS,
  HIRE_REPORT_BLOCKER_KINDS,
  HIRE_REPORT_PIPELINE_STAGES,
} from '../types'

const IDS = {
  workspaceId: new mongoose.Types.ObjectId('111111111111111111111111'),
  jobId: new mongoose.Types.ObjectId('222222222222222222222222'),
  candidateId: new mongoose.Types.ObjectId('333333333333333333333333'),
  reportId: new mongoose.Types.ObjectId('444444444444444444444444'),
  memberId: new mongoose.Types.ObjectId('555555555555555555555555'),
}

function tally(overrides: Partial<Record<'strong_yes' | 'yes' | 'no' | 'strong_no', number>> = {}) {
  return { strong_yes: 0, yes: 0, no: 0, strong_no: 0, ...overrides }
}

function evidence() {
  return {
    aiAssessments: { completedCount: 1 },
    humanScorecards: {
      member: { submittedCount: 1, recommendations: tally({ yes: 1 }) },
      kit: { submittedCount: 0, recommendations: tally() },
    },
    externalVerdicts: { submittedCount: 0, recommendations: tally() },
  }
}

function pipelineSnapshot(scope: 'workspace' | 'job' = 'workspace') {
  return buildHirePipelineStatusReportSnapshot({
    scope,
    asOf: new Date('2026-08-14T10:00:00.000Z'),
    jobs: [{
      jobTitle: 'Platform Engineer',
      jobStatus: 'open',
      openedAt: new Date('2026-08-01T10:00:00.000Z'),
      stageCounts: HIRE_REPORT_PIPELINE_STAGES.map((stage, index) => ({ stage, count: index })),
      aging: HIRE_REPORT_AGING_BUCKETS.map((bucket, index) => ({ bucket, count: index })),
      blockers: HIRE_REPORT_BLOCKER_KINDS.map((kind, index) => ({ kind, count: index })),
      evidence: evidence(),
    }],
  }).snapshot
}

function closeoutSnapshot() {
  return buildHireJobCloseoutReportSnapshot({
    asOf: new Date('2026-08-15T10:00:00.000Z'),
    jobTitle: 'Platform Engineer',
    openedAt: new Date('2026-08-01T10:00:00.000Z'),
    closedAt: new Date('2026-08-15T10:00:00.000Z'),
    stageCounts: HIRE_REPORT_PIPELINE_STAGES.map((stage, index) => ({ stage, count: index })),
    evidence: evidence(),
    hiredCandidates: [{
      candidateId: IDS.candidateId.toString(),
      candidateName: 'Ada Lovelace',
      hiredAt: new Date('2026-08-14T10:00:00.000Z'),
    }],
    decisionNote: 'The panel documented a clear, human-owned decision.',
  })
}

function report(overrides: Record<string, unknown> = {}) {
  const requestedAt = new Date('2026-08-14T10:00:00.000Z')
  return {
    _id: IDS.reportId,
    workspaceId: IDS.workspaceId,
    reportKind: 'pipeline_status',
    reportScope: 'workspace',
    format: 'pdf',
    creationOperationId: '11111111-1111-4111-8111-111111111111',
    requestedByMemberId: IDS.memberId,
    requestedByName: 'Recruiter One',
    objectKey: hireReportExportObjectKey({
      workspaceId: IDS.workspaceId.toString(),
      reportId: IDS.reportId.toString(),
      reportKind: 'pipeline_status',
      reportScope: 'workspace',
      format: 'pdf',
    }),
    reportSnapshot: pipelineSnapshot(),
    affectedCandidateIds: [],
    privacyAggregateFenceVersion: 0,
    requestedAt,
    expiresAt: new Date(requestedAt.getTime() + HIRE_REPORT_EXPORT_EXPIRY_MS),
    status: 'requested',
    attempts: 0,
    nextRetryAt: requestedAt,
    ...overrides,
  }
}

function indexes(model: Model<never>): Array<[Record<string, number>, Record<string, unknown>]> {
  return model.schema.indexes() as Array<[Record<string, number>, Record<string, unknown>]>
}

describe('Phase-5 report durable models', () => {
  it('keeps report scope/format, private key, snapshot, and privacy coordinates immutable and scoped', () => {
    for (const field of [
      'workspaceId',
      'jobId',
      'reportKind',
      'reportScope',
      'format',
      'creationOperationId',
      'requestedByMemberId',
      'requestedByName',
      'objectKey',
      'reportSnapshot',
      'affectedCandidateIds',
      'privacyAggregateFenceVersion',
    ]) {
      const path = HireReportExport.schema.path(field)
      expect(path).toBeDefined()
      expect((path.options as { immutable?: boolean }).immutable).toBe(true)
    }
    expect((HireReportExport.schema.path('objectKey').options as { select?: boolean }).select).toBe(false)
    expect((HireReportExport.schema.path('reportSnapshot').options as { select?: boolean }).select).toBe(false)
    expect((HireReportExport.schema.path('affectedCandidateIds').options as { select?: boolean }).select).toBe(false)
    expect((HireReportExport.schema.path('privacyAggregateFenceVersion').options as { select?: boolean }).select).toBe(false)
    expect((HireReportExport.schema.path('requestedByMemberId').options as { ref?: string }).ref).toBe('HireWorkspaceMember')
    for (const forbidden of ['candidateEmail', 'resumeText', 'internalRank', 'rawEngineOutput', 'signedUrl']) {
      expect(HireReportExport.schema.path(forbidden)).toBeUndefined()
    }
    expect(new HireReportExport(report()).validateSync()).toBeUndefined()
  })

  it('keeps a bounded Hire-member requester snapshot and worker lifecycle timestamp without a B2C dependency', () => {
    expect(new HireReportExport(report({ requestedByMemberId: undefined })).validateSync()?.errors.requestedByMemberId).toBeDefined()
    expect(new HireReportExport(report({ requestedByName: '  ' })).validateSync()?.errors.requestedByName).toBeDefined()
    expect(new HireReportExport(report({ requestedByName: 'x'.repeat(121) })).validateSync()?.errors.requestedByName).toBeDefined()
    expect(HireReportExport.schema.path('requestedByUserId')).toBeUndefined()
    expect(HireReportExport.schema.path('generatingAt')).toBeDefined()
  })

  it('requires a deterministic non-public key, bounded expiry, and an exact scope/snapshot pairing', () => {
    expect(new HireReportExport(report({ objectKey: 'hire-report-exports/v1/forged.pdf' })).validateSync()?.errors.objectKey).toBeDefined()
    expect(new HireReportExport(report({
      expiresAt: new Date('2026-08-21T10:00:00.001Z'),
    })).validateSync()?.errors.expiresAt).toBeDefined()
    expect(new HireReportExport(report({
      reportScope: 'job',
      jobId: IDS.jobId,
    })).validateSync()?.errors.reportSnapshot).toBeDefined()
    expect(new HireReportExport(report({
      affectedCandidateIds: [IDS.candidateId],
    })).validateSync()?.errors.reportSnapshot).toBeDefined()
    expect(new HireReportExport(report({ privacyAggregateFenceVersion: undefined })).validateSync()?.errors.privacyAggregateFenceVersion).toBeDefined()
  })

  it('enforces closeout-only job/pdf coordinates and the separated candidate lifecycle list', () => {
    const built = closeoutSnapshot()
    const closeout = report({
      jobId: IDS.jobId,
      reportKind: 'job_closeout',
      reportScope: 'job',
      format: 'pdf',
      objectKey: hireReportExportObjectKey({
        workspaceId: IDS.workspaceId.toString(),
        reportId: IDS.reportId.toString(),
        jobId: IDS.jobId.toString(),
        reportKind: 'job_closeout',
        reportScope: 'job',
        format: 'pdf',
      }),
      reportSnapshot: built.snapshot,
      affectedCandidateIds: built.affectedCandidateIds.map((id) => new mongoose.Types.ObjectId(id)),
      privacyAggregateFenceVersion: undefined,
    })
    expect(new HireReportExport(closeout).validateSync()).toBeUndefined()
    expect(new HireReportExport({ ...closeout, format: 'xlsx' }).validateSync()?.errors.reportKind).toBeDefined()
    expect(new HireReportExport({ ...closeout, affectedCandidateIds: [] }).validateSync()?.errors.reportSnapshot).toBeDefined()
  })

  it('uses a parseable full-coordinate key grammar without path escape', () => {
    const key = report().objectKey as string
    expect(parseHireReportExportObjectKey(key)).toEqual({
      workspaceId: IDS.workspaceId.toString(),
      reportId: IDS.reportId.toString(),
      reportKind: 'pipeline_status',
      reportScope: 'workspace',
      format: 'pdf',
    })
    expect(parseHireReportExportObjectKey(`${key}%2fescape`)).toBeNull()
    expect(parseHireReportExportObjectKey(`${key}\\escape`)).toBeNull()
    expect(() => hireReportExportObjectKey({
      workspaceId: IDS.workspaceId.toString(),
      reportId: IDS.reportId.toString(),
      reportKind: 'job_closeout',
      reportScope: 'workspace',
      format: 'pdf',
    } as never)).toThrow()
  })

  it('declares scoped report indexes and a deletion-only global cleanup tombstone', () => {
    const exportIndexes = indexes(HireReportExport as unknown as Model<never>)
    expect(exportIndexes).toHaveLength(5)
    for (const [spec, options] of exportIndexes) {
      expect(spec.workspaceId).toBe(1)
      expect(options.expireAfterSeconds).toBeUndefined()
    }
    expect(exportIndexes.find(([spec]) => spec.creationOperationId === 1)?.[1].unique).toBe(true)
    expect(exportIndexes.some(([spec]) => spec.affectedCandidateIds === 1)).toBe(true)

    for (const field of ['workspaceId', 'jobId', 'reportKind', 'reportScope', 'format', 'exportId']) {
      expect((HireReportExportCleanup.schema.path(field).options as { immutable?: boolean }).immutable).toBe(true)
    }
    expect(HireReportExportCleanup.schema.path('objectKey')).toBeUndefined()
    expect(HireReportExportCleanup.schema.path('reportSnapshot')).toBeUndefined()
    expect(HireReportExportCleanup.schema.path('candidateEmail')).toBeUndefined()
    const cleanupIndexes = indexes(HireReportExportCleanup as unknown as Model<never>)
    expect(cleanupIndexes).toHaveLength(2)
    expect(cleanupIndexes.find(([spec]) => spec.workspaceId === 1 && spec.exportId === 1)?.[1].unique).toBe(true)
    expect(cleanupIndexes.some(([spec]) => spec.firstSweepAt === 1 && spec.nextRetryAt === 1)).toBe(true)
  })
})
