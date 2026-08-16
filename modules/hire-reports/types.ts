/**
 * Phase 5 report contracts.
 *
 * These snapshots intentionally contain aggregate operational facts and
 * separately labelled evidence counts. They never calculate a blended score,
 * candidate rank, or a pipeline-stage instruction.
 */

export const HIRE_REPORT_KINDS = ['pipeline_status', 'job_closeout'] as const
export type HireReportKind = (typeof HIRE_REPORT_KINDS)[number]

export const HIRE_REPORT_FORMATS = ['pdf', 'xlsx'] as const
export type HireReportFormat = (typeof HIRE_REPORT_FORMATS)[number]

export const HIRE_REPORT_SCOPES = ['workspace', 'job'] as const
export type HireReportScope = (typeof HIRE_REPORT_SCOPES)[number]

export const HIRE_REPORT_EXPORT_STATUSES = [
  'requested',
  'generating',
  'ready',
  'failed',
  'expired',
  'cancelled',
] as const
export type HireReportExportStatus = (typeof HIRE_REPORT_EXPORT_STATUSES)[number]

/** Persist a stable class only; never provider messages, report content, or stack traces. */
export const HIRE_REPORT_EXPORT_FAILURE_CODES = [
  'snapshot_unavailable',
  'render_failed',
  'storage_failed',
  'finalization_failed',
] as const
export type HireReportExportFailureCode = (typeof HIRE_REPORT_EXPORT_FAILURE_CODES)[number]

/** Fixed Hire pipeline protocol, duplicated here to keep snapshot builders persistence-free. */
export const HIRE_REPORT_PIPELINE_STAGES = [
  'new',
  'screened',
  'interviewing',
  'shortlist',
  'offer',
  'hired',
  'rejected',
  'withdrawn',
] as const
export type HireReportPipelineStage = (typeof HIRE_REPORT_PIPELINE_STAGES)[number]

export const HIRE_REPORT_AGING_BUCKETS = [
  '0_2_days',
  '3_6_days',
  '7_13_days',
  '14_plus_days',
] as const
export type HireReportAgingBucket = (typeof HIRE_REPORT_AGING_BUCKETS)[number]

/**
 * Blockers are aggregate, fixed labels only. A report never carries a raw
 * note, a candidate email, or a free-form provider failure as a blocker.
 */
export const HIRE_REPORT_BLOCKER_KINDS = [
  'awaiting_member_decision',
  'awaiting_human_scorecard',
  'human_kit_delivery_failed',
  'offer_pending',
] as const
export type HireReportBlockerKind = (typeof HIRE_REPORT_BLOCKER_KINDS)[number]

export const HIRE_REPORT_RECOMMENDATIONS = [
  'strong_yes',
  'yes',
  'no',
  'strong_no',
] as const
export type HireReportRecommendation = (typeof HIRE_REPORT_RECOMMENDATIONS)[number]

export type HireReportRecommendationTally = Record<HireReportRecommendation, number>

/** Bounded snapshots avoid an accidental unstreamed workspace dump. */
export const HIRE_REPORT_MAX_PIPELINE_JOBS = 250
export const HIRE_REPORT_MAX_CLOSEOUT_HIRES = 50
export const HIRE_REPORT_MAX_COUNT = 1_000_000_000
export const HIRE_REPORT_MAX_TIME_TO_CLOSE_HOURS = 100 * 366 * 24

export interface HireReportStageCount {
  stage: HireReportPipelineStage
  count: number
}

export interface HireReportAgingCount {
  bucket: HireReportAgingBucket
  count: number
}

export interface HireReportBlockerCount {
  kind: HireReportBlockerKind
  count: number
}

/** Immutable display coordinate captured from the workspace-owned department catalog. */
export interface HireReportDepartmentSnapshot {
  id: string
  name: string
}

/** Human scorecards and external verdicts stay independent evidence sources. */
export interface HireReportEvidenceSummary {
  aiAssessments: {
    completedCount: number
  }
  humanScorecards: {
    member: {
      submittedCount: number
      recommendations: HireReportRecommendationTally
    }
    kit: {
      submittedCount: number
      recommendations: HireReportRecommendationTally
    }
  }
  externalVerdicts: {
    submittedCount: number
    recommendations: HireReportRecommendationTally
  }
}

export interface HirePipelineStatusReportJobSnapshot {
  /** Display-only title; never JD text, private notes, or a candidate list. */
  jobTitle: string
  /** Optional so exports created before department snapshots remain renderable. */
  department?: HireReportDepartmentSnapshot
  jobStatus: 'open' | 'on_hold' | 'closed'
  openedAt: Date
  stageCounts: HireReportStageCount[]
  aging: HireReportAgingCount[]
  blockers: HireReportBlockerCount[]
  evidence: HireReportEvidenceSummary
}

/**
 * A workspace-level report is a collection of independent per-job summaries.
 * It intentionally has no cross-job candidate comparison or synthesized rank.
 */
export interface HirePipelineStatusReportSnapshot {
  version: 1
  kind: 'pipeline_status'
  scope: HireReportScope
  asOf: Date
  jobs: HirePipelineStatusReportJobSnapshot[]
}

export interface HireJobCloseoutHiredCandidateSnapshot {
  /** Internal report disclosure only; email, phone, resume, and IDs stay out. */
  candidateName: string
  hiredAt: Date
}

export interface HireJobCloseoutReportSnapshot {
  version: 1
  kind: 'job_closeout'
  asOf: Date
  jobTitle: string
  /** Optional so historical close-out exports remain renderable. */
  department?: HireReportDepartmentSnapshot
  openedAt: Date
  closedAt: Date
  /** Derived from the two immutable report timestamps, never accepted as a caller score. */
  timeToCloseHours: number
  stageCounts: HireReportStageCount[]
  evidence: HireReportEvidenceSummary
  hiredCandidates: HireJobCloseoutHiredCandidateSnapshot[]
  /** Required internal close decision context; bounded by the builder/model. */
  decisionNote: string
}

export type HireReportSnapshot =
  | HirePipelineStatusReportSnapshot
  | HireJobCloseoutReportSnapshot

export interface HireReportExportCoordinates {
  workspaceId: string
  reportId: string
  reportKind: HireReportKind
  reportScope: HireReportScope
  format: HireReportFormat
  jobId?: string
}

/**
 * The snapshot remains output-safe. Candidate IDs used by later privacy
 * fencing are kept separately and never belong in a rendered report.
 */
export interface HireReportSnapshotBuildResult<TSnapshot extends HireReportSnapshot> {
  snapshot: TSnapshot
  affectedCandidateIds: string[]
}

export interface HirePipelineStatusReportJobInput {
  jobTitle: unknown
  department?: unknown
  jobStatus: unknown
  openedAt: unknown
  stageCounts: unknown
  aging: unknown
  blockers: unknown
  evidence: unknown
}

export interface HirePipelineStatusReportSnapshotInput {
  scope: unknown
  asOf: unknown
  jobs: unknown
}

export interface HireJobCloseoutHiredCandidateInput {
  candidateId: unknown
  candidateName: unknown
  hiredAt: unknown
}

export interface HireJobCloseoutReportSnapshotInput {
  asOf: unknown
  jobTitle: unknown
  department?: unknown
  openedAt: unknown
  closedAt: unknown
  stageCounts: unknown
  evidence: unknown
  hiredCandidates: unknown
  decisionNote: unknown
}
