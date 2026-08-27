import type { HireJobStatus, HireStage } from "@hire-operations-boundary";

export const HIRE_JOB_CANDIDATE_SELECTION_MAX = 5_000;

export const HIRE_JOB_CANDIDATE_VIEWS = [
  "all", "scoring_attention", "screening_attention", "interview_attention", "decision_ready", "offers",
] as const;
export type HireJobCandidateView = (typeof HIRE_JOB_CANDIDATE_VIEWS)[number];

export const HIRE_JOB_CANDIDATE_SOURCES = [
  "manual", "apply_page", "bulk_upload", "pool",
] as const;
export type HireJobCandidateSource = (typeof HIRE_JOB_CANDIDATE_SOURCES)[number];

export const HIRE_JOB_CANDIDATE_JD_STATES = [
  "fresh", "stale", "unscored", "pending",
] as const;
export type HireJobCandidateJdState = (typeof HIRE_JOB_CANDIDATE_JD_STATES)[number];

export const HIRE_JOB_CANDIDATE_HUMAN_REVIEW_STATES = [
  "none", "pending", "mixed", "complete", "disagreement",
] as const;
export type HireJobCandidateHumanReviewState = (typeof HIRE_JOB_CANDIDATE_HUMAN_REVIEW_STATES)[number];

export const HIRE_JOB_CANDIDATE_AI_INTERVIEW_STATES = [
  "not_invited", "invited", "in_progress", "completed", "revoked",
] as const;
export type HireJobCandidateAiInterviewState = (typeof HIRE_JOB_CANDIDATE_AI_INTERVIEW_STATES)[number];

export const HIRE_JOB_CANDIDATE_HISTORY_STATES = ["first_time", "returning"] as const;
export type HireJobCandidateHistoryState = (typeof HIRE_JOB_CANDIDATE_HISTORY_STATES)[number];

export const HIRE_JOB_CANDIDATE_SORTS = [
  "attention", "newest", "oldest", "name", "stage", "jd_match", "rank",
  "human_review", "last_activity",
] as const;
export type HireJobCandidateSort = (typeof HIRE_JOB_CANDIDATE_SORTS)[number];
export type HireJobCandidateSortDirection = "asc" | "desc";

export const HIRE_JOB_CANDIDATE_ATTENTION_KINDS = [
  "scoring_pending", "scoring_stale", "scoring_unscored", "screening_pending",
  "interview_pending", "human_scorecard_pending", "decision_ready", "offer_pending",
] as const;
export type HireJobCandidateAttentionKind = (typeof HIRE_JOB_CANDIDATE_ATTENTION_KINDS)[number];

export interface HireJobCandidateNormalizedQuery {
  q?: string;
  view: HireJobCandidateView;
  stage: HireStage[];
  source: HireJobCandidateSource[];
  scoreState: HireJobCandidateJdState[];
  scoreMin?: number; scoreMax?: number;
  humanReview: HireJobCandidateHumanReviewState[];
  aiInterview: HireJobCandidateAiInterviewState[];
  history?: HireJobCandidateHistoryState;
  appliedFrom?: string; appliedTo?: string;
  sort: HireJobCandidateSort;
  direction: HireJobCandidateSortDirection;
}

export interface HireJobCandidateQuery extends HireJobCandidateNormalizedQuery {
  cursor?: string;
  limit: number;
}

export interface HireJobCandidateHumanReview {
  state: Exclude<HireJobCandidateHumanReviewState, "disagreement">;
  total: number;
  submitted: number;
  pending: number;
  recommendations: Record<"strongYes" | "yes" | "no" | "strongNo", number>;
  disagreement: boolean;
}

export interface HireJobCandidateAiInterview {
  state: HireJobCandidateAiInterviewState; overallScore: number | null; updatedAt: string | null;
}

export interface HireJobCandidateRow {
  applicationId: string;
  candidate: { id: string; name: string; email: string };
  stage: HireStage;
  source: HireJobCandidateSource;
  sourceHistory: HireJobCandidateSource[];
  appliedAt: string;
  lastActivityAt: string;
  attention: HireJobCandidateAttentionKind[];
  jdMatch: {
    state: HireJobCandidateJdState;
    score: number | null;
    /** One-based rank in the complete fresh-scored job cohort. */
    rank: number | null;
    /** Complete fresh-scored denominator from the same global window. */
    denominator: number | null;
    scoredAt: string | null;
  };
  humanReview: HireJobCandidateHumanReview;
  aiInterview: HireJobCandidateAiInterview;
  workspaceHistory: { previousApplications: number };
}

export interface HireJobCandidateCounts {
  /** Privacy-safe applications in the frozen job traversal before UI filters. */
  total: number;
  /** Frozen applications matching every normalized UI predicate. */
  matching: number;
  stages: Record<HireStage, number>;
  jdMatch: Record<HireJobCandidateJdState, number>;
  savedViews: Record<HireJobCandidateView, number>;
}

type HireJobCandidateJob = { jobId: string; title: string; status: HireJobStatus };

export interface HireJobCandidatePage {
  asOf: string;
  job: HireJobCandidateJob;
  rows: HireJobCandidateRow[];
  pageInfo: {
    limit: number; hasNextPage: boolean; nextCursor: string | null; snapshotAt: string;
  };
}

export interface HireJobCandidateIdentityQuery { q: string; cursor?: string; limit: number }
export interface HireJobCandidateIdentityPage {
  candidates: Array<{ applicationId: string; candidateName: string; candidateEmail: string }>;
  pageInfo: { limit: number; nextCursor: string | null };
}

export type HireJobCandidateFreshnessQuery = HireJobCandidateNormalizedQuery & { snapshotAt: string };
export interface HireJobCandidateFreshness { hasNewerResults: boolean; checkedAt: string }

/** Separate from cursor pages so paging never recomputes or retransmits funnels. */
export interface HireJobCandidateSummary {
  asOf: string;
  job: HireJobCandidateJob;
  counts: HireJobCandidateCounts;
  rankContext: Record<"freshScoredTotal" | "stale" | "unscored" | "pending", number>;
}

export type HireJobOverviewActivityKind =
  | "application_created" | "application_reapplied" | "application_stage_changed"
  | "ai_interview_sent" | "ai_result_linked" | "human_interview_logged"
  | "human_scorecard_submitted";

export interface HireJobOverview {
  asOf: string;
  job: {
    jobId: string;
    title: string;
    status: HireJobStatus;
    department: { id: string; name: string };
    createdAt: string;
    daysOpen: number;
  };
  counts: {
    total: number;
    stages: Record<HireStage, number>;
    attention: {
      scoring: number;
      screening: number;
      interview: number;
      decision: number;
      offers: number;
    };
  };
  recentActivity: Array<{
    kind: HireJobOverviewActivityKind; occurredAt: string;
    actorName: string; applicationId: string;
  }>;
  acquisition: { applyPageEnabled: boolean };
  screening: {
    latestGate: null | {
      gateId: string;
      status: "confirmed" | "cancelled";
      selectedCount: number;
      confirmedAt: string;
    };
    latestBatch: null | {
      batchId: string;
      status: string;
      plannedCount: number;
      sentCount: number;
      failedCount: number;
      createdAt: string;
    };
    delivery: {
      pending: number;
      sending: number;
      sent: number;
      failed: number;
      cancelled: number;
      skipped: number;
    };
  };
}

export const HIRE_CANDIDATE_SELECTION_MODES = ["explicit", "all_matching"] as const;
export type HireCandidateSelectionMode = (typeof HIRE_CANDIDATE_SELECTION_MODES)[number];

export interface HireCandidateSelectionEntry { applicationId: string; expectedStage: HireStage }

export interface HireCandidateSelectionMetadata {
  selectionId: string;
  count: number;
  expiresAt: string;
  description: string;
  /** Authoritative immutable-stage summary used to gate bulk Advance. */
  homogeneousStage: HireStage | null;
}

export interface HireResolvedCandidateSelection {
  selectionId: string;
  mode: HireCandidateSelectionMode;
  count: number;
  expiresAt: string;
  description: string;
  workspaceId: string;
  jobId: string;
  memberId: string;
  entries: HireCandidateSelectionEntry[];
}
