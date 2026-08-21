import type { HireJobStatus, HireStage } from "@hire-operations-boundary";

/** Fixed operation categories; each remains aggregate-only and contains no candidate data. */
export const HIRE_OPERATIONS_ACTION_KINDS = [
  "candidates_awaiting_decision",
  "pending_human_scorecards",
  "terminal_human_kit_delivery_failures",
  "external_verdicts_received",
  "failed_multimodal_analyses",
] as const;

export type HireOperationsActionKind =
  (typeof HIRE_OPERATIONS_ACTION_KINDS)[number];

export interface HireOperationsActionInboxItem {
  kind: HireOperationsActionKind;
  count: number;
}

export interface HireOperationsScorecardCompletion {
  completed: number;
  pending: number;
  total: number;
  /** `null` when no non-revoked human round exists. */
  rate: number | null;
}

export interface HireOperationsKpis {
  openJobs: number;
  candidatesAwaitingDecision: number;
  scorecardCompletion: HireOperationsScorecardCompletion;
  /** Median duration for jobs with a recorded close timestamp, in days. */
  medianTimeToCloseDays: number | null;
}

/** HTTP-safe member overview payload for `GET /api/workspace/overview`. */
export interface HireOperationsWorkspaceOverview {
  asOf: string;
  kpis: HireOperationsKpis;
  actionInbox: {
    items: HireOperationsActionInboxItem[];
  };
}

/** Current pipeline occupancy. It is not a rank, a score, or an event feed. */
export type HireOperationsStageCounts = Record<HireStage, number>;

export interface HireOperationsAttentionItem {
  kind: HireOperationsActionKind | "stuck_in_stage";
  count: number;
  /** Present only for a stage-aging attention group. */
  stage?: HireStage;
  /** Present only for a stage-aging attention group. */
  oldestAgeDays?: number;
  /** Present only for a stage-aging attention group. */
  thresholdDays?: number;
}

/** Immutable job-time department identity, resolved only inside the workspace. */
export interface HireOperationsDepartment {
  id: string;
  name: string;
}

export interface HireOperationsJobHealth {
  jobId: string;
  title: string;
  department: HireOperationsDepartment;
  status: HireJobStatus;
  daysOpen: number;
  funnel: HireOperationsStageCounts;
  attention: HireOperationsAttentionItem[];
}

/** HTTP-safe member health payload for `GET /api/workspace/jobs/health`. */
export interface HireOperationsJobsHealth {
  asOf: string;
  jobs: HireOperationsJobHealth[];
}

export type HireOperationsConversionStage = Exclude<
  HireStage,
  "new" | "rejected" | "withdrawn"
>;

export interface HireOperationsFunnelConversion {
  stage: HireOperationsConversionStage;
  reached: number;
  /** Fraction of all applications that have reached this stage; `null` for an empty job. */
  rateFromStart: number | null;
}

export interface HireOperationsScoreBucket {
  minimum: number;
  maximum: number;
  count: number;
}

/**
 * Deliberate member-only fallback for a job with too few scores to make a
 * useful distribution. It is never included in a chart-eligible payload.
 */
export interface HireOperationsSmallSampleCandidate {
  applicationId: string;
  candidateName: string;
  score: number;
  /** Descending, job-local rank among the returned fallback candidates. */
  rank: number;
}

export interface HireOperationsScoreDistribution {
  /** Number of applications with one valid latest AI overall score. */
  sampleSize: number;
  /** Histogram buckets are intentionally withheld below the small-sample floor. */
  chartEligible: boolean;
  buckets: HireOperationsScoreBucket[];
  /**
   * Present only when `chartEligible` is false. This intentional member-only
   * exception is capped and contains just a same-job display name, score, and
   * local rank—never contact details or assessment evidence.
   */
  fallbackCandidates?: HireOperationsSmallSampleCandidate[];
}

/** HTTP-safe member performance payload for `GET /api/workspace/jobs/:jobId/performance`. */
export interface HireOperationsJobPerformance {
  asOf: string;
  job: {
    jobId: string;
    title: string;
    department: HireOperationsDepartment;
    status: HireJobStatus;
    daysOpen: number;
  };
  funnel: {
    current: HireOperationsStageCounts;
    conversions: HireOperationsFunnelConversion[];
  };
  humanScorecards: HireOperationsScorecardCompletion;
  scoreDistribution: HireOperationsScoreDistribution;
  /** `null` until the job has a recorded close timestamp. */
  timeToCloseDays: number | null;
}

/**
 * Intentionally finite audit vocabulary. New write paths do not become
 * visible here until a review adds their safe, static event kind.
 */
export const HIRE_OPERATIONS_AUDIT_KINDS = [
  "application_created",
  "application_reapplied",
  "application_source_merged",
  "application_stage_changed",
  "application_ai_round_sent",
  "application_ai_round_revoked",
  "application_ai_result_linked",
  "application_human_round_logged",
  "application_human_kit_sent",
  "application_human_kit_delivery_failed",
  "application_human_kit_reminded",
  "application_human_kit_revoked",
  "application_human_scorecard_submitted",
  "job_status_changed",
  "job_department_changed",
  "report_requested",
  "report_generation_started",
  "report_ready",
  "report_failed",
  "report_expired",
  "report_cancelled",
  "status_link_issued",
  "status_link_revoked",
  "digest_delivery_queued",
  "digest_delivery_sent",
  "digest_delivery_cancelled",
  "onboarding_test_drive_started",
  "onboarding_test_drive_ready",
  "onboarding_test_drive_removed",
] as const;

export type HireOperationsAuditKind =
  (typeof HIRE_OPERATIONS_AUDIT_KINDS)[number];

export const HIRE_OPERATIONS_AUDIT_TARGET_KINDS = [
  "application",
  "job",
  "report",
  "status_link",
  "digest_outbox",
  "onboarding_test_drive",
] as const;

export type HireOperationsAuditTargetKind =
  (typeof HIRE_OPERATIONS_AUDIT_TARGET_KINDS)[number];

export interface HireOperationsAuditActor {
  /** `member` contains a bounded immutable display snapshot; system is fixed. */
  kind: "member" | "system";
  name: string;
}

export interface HireOperationsAuditItem {
  kind: HireOperationsAuditKind;
  occurredAt: string;
  actor: HireOperationsAuditActor;
  target: {
    kind: HireOperationsAuditTargetKind;
    /** Opaque internal ID; never a candidate identifier or a capability. */
    id: string;
  };
}

/** HTTP-safe member audit payload for `GET /api/workspace/audit`. */
export interface HireOperationsAuditPage {
  items: HireOperationsAuditItem[];
  /** Opaque cursor for the next descending page; `null` when exhausted. */
  nextCursor: string | null;
}
