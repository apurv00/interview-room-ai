import {
  buildHireJobCloseoutReportSnapshot,
  buildHirePipelineStatusReportSnapshot,
} from '../../services/reportSnapshotBuilders'
import {
  HIRE_REPORT_AGING_BUCKETS,
  HIRE_REPORT_BLOCKER_KINDS,
  HIRE_REPORT_PIPELINE_STAGES,
} from '../../types'

function tally(overrides: Partial<Record<'strong_yes' | 'yes' | 'no' | 'strong_no', number>> = {}) {
  return { strong_yes: 0, yes: 0, no: 0, strong_no: 0, ...overrides }
}

function evidence() {
  return {
    aiAssessments: { completedCount: 3 },
    humanScorecards: {
      member: { submittedCount: 2, recommendations: tally({ yes: 2 }) },
      kit: { submittedCount: 1, recommendations: tally({ strong_yes: 1 }) },
    },
    externalVerdicts: { submittedCount: 1, recommendations: tally({ no: 1 }) },
  }
}

/** Representative static fixture for workbook parser/format/formula-safety QA. */
export const hireReportWorkbookQa = {
  pipeline: buildHirePipelineStatusReportSnapshot({
    scope: 'workspace',
    asOf: new Date('2026-08-14T10:00:00.000Z'),
    jobs: [{
      // Intentionally formula-shaped to exercise the spreadsheet text fence.
      jobTitle: '=Platform Engineer',
      jobStatus: 'open',
      openedAt: new Date('2026-08-01T10:00:00.000Z'),
      stageCounts: HIRE_REPORT_PIPELINE_STAGES.map((stage, index) => ({ stage, count: index + 1 })),
      aging: HIRE_REPORT_AGING_BUCKETS.map((bucket, index) => ({ bucket, count: index })),
      blockers: HIRE_REPORT_BLOCKER_KINDS.map((kind, index) => ({ kind, count: index })),
      evidence: evidence(),
    }],
  }).snapshot,
  closeout: buildHireJobCloseoutReportSnapshot({
    asOf: new Date('2026-08-15T10:00:00.000Z'),
    jobTitle: '=Platform Engineer',
    openedAt: new Date('2026-08-01T10:00:00.000Z'),
    closedAt: new Date('2026-08-15T10:00:00.000Z'),
    stageCounts: HIRE_REPORT_PIPELINE_STAGES.map((stage, index) => ({ stage, count: index + 1 })),
    evidence: evidence(),
    hiredCandidates: [{
      candidateId: '111111111111111111111111',
      candidateName: '+Ada Lovelace',
      hiredAt: new Date('2026-08-14T10:00:00.000Z'),
    }],
    decisionNote: '@Panel note: independent evidence was reviewed.',
  }).snapshot,
}
