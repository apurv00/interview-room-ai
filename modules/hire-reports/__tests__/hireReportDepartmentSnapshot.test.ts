import mongoose from 'mongoose'
import { describe, expect, it } from 'vitest'
import {
  HIRE_REPORT_EXPORT_EXPIRY_MS,
  HireReportExport,
  hireReportExportObjectKey,
} from '../models/HireReportExport'
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
  workspace: new mongoose.Types.ObjectId('111111111111111111111111'),
  report: new mongoose.Types.ObjectId('222222222222222222222222'),
  member: new mongoose.Types.ObjectId('333333333333333333333333'),
  department: '444444444444444444444444',
  candidate: '555555555555555555555555',
}

function evidence() {
  return {
    aiAssessments: { completedCount: 0 },
    humanScorecards: {
      member: { submittedCount: 0, recommendations: { strong_yes: 0, yes: 0, no: 0, strong_no: 0 } },
      kit: { submittedCount: 0, recommendations: { strong_yes: 0, yes: 0, no: 0, strong_no: 0 } },
    },
    externalVerdicts: { submittedCount: 0, recommendations: { strong_yes: 0, yes: 0, no: 0, strong_no: 0 } },
  }
}

function pipelineSnapshot() {
  return buildHirePipelineStatusReportSnapshot({
    scope: 'workspace',
    asOf: new Date('2026-08-15T00:00:00.000Z'),
    jobs: [{
      jobTitle: 'Platform Engineer',
      department: {
        id: IDS.department.toUpperCase(),
        name: ' Engineering ',
        kind: 'standard',
        status: 'active',
        createdByName: 'must not survive',
      },
      jobStatus: 'open',
      openedAt: new Date('2026-08-01T00:00:00.000Z'),
      stageCounts: HIRE_REPORT_PIPELINE_STAGES.map((stage) => ({ stage, count: 0 })),
      aging: HIRE_REPORT_AGING_BUCKETS.map((bucket) => ({ bucket, count: 0 })),
      blockers: HIRE_REPORT_BLOCKER_KINDS.map((kind) => ({ kind, count: 0 })),
      evidence: evidence(),
    }],
  }).snapshot
}

function report(snapshot: ReturnType<typeof pipelineSnapshot>) {
  const requestedAt = new Date('2026-08-15T00:00:00.000Z')
  return {
    _id: IDS.report,
    workspaceId: IDS.workspace,
    reportKind: 'pipeline_status' as const,
    reportScope: 'workspace' as const,
    format: 'pdf' as const,
    creationOperationId: '11111111-1111-4111-8111-111111111111',
    requestedByMemberId: IDS.member,
    requestedByName: 'Recruiter One',
    objectKey: hireReportExportObjectKey({
      workspaceId: IDS.workspace.toString(),
      reportId: IDS.report.toString(),
      reportKind: 'pipeline_status',
      reportScope: 'workspace',
      format: 'pdf',
    }),
    reportSnapshot: snapshot,
    affectedCandidateIds: [],
    privacyAggregateFenceVersion: 0,
    requestedAt,
    expiresAt: new Date(requestedAt.getTime() + HIRE_REPORT_EXPORT_EXPIRY_MS),
    status: 'requested' as const,
    attempts: 0,
    nextRetryAt: requestedAt,
  }
}

describe('Hire report department snapshots', () => {
  it('deep-allowlists only a copied id/name display coordinate', () => {
    const pipeline = pipelineSnapshot()
    const closeout = buildHireJobCloseoutReportSnapshot({
      asOf: new Date('2026-08-15T00:00:00.000Z'),
      jobTitle: 'Platform Engineer',
      department: { id: IDS.department, name: 'Engineering', kind: 'standard' },
      openedAt: new Date('2026-08-01T00:00:00.000Z'),
      closedAt: new Date('2026-08-15T00:00:00.000Z'),
      stageCounts: HIRE_REPORT_PIPELINE_STAGES.map((stage) => ({ stage, count: 0 })),
      evidence: evidence(),
      hiredCandidates: [],
      decisionNote: 'The panel recorded its decision.',
    }).snapshot

    expect(pipeline.jobs[0]?.department).toEqual({ id: IDS.department, name: 'Engineering' })
    expect(closeout.department).toEqual({ id: IDS.department, name: 'Engineering' })
    expect(Object.keys(pipeline.jobs[0]?.department ?? {})).toEqual(['id', 'name'])
    expect(Object.keys(closeout.department ?? {})).toEqual(['id', 'name'])
    expect(JSON.stringify({ pipeline, closeout })).not.toContain('createdByName')
  })

  it('persists new id/name snapshots while accepting a legacy v1 snapshot without one', () => {
    const current = pipelineSnapshot()
    const legacy = {
      ...current,
      jobs: current.jobs.map(({ department: _department, ...job }) => job),
    }

    expect(new HireReportExport(report(current)).validateSync()).toBeUndefined()
    expect(new HireReportExport(report(legacy)).validateSync()).toBeUndefined()
  })
})
