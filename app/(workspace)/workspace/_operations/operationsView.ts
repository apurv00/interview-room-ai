import type {
  HireOperationsActionInboxItem,
  HireOperationsAttentionItem,
  HireOperationsAuditItem,
  HireOperationsAuditKind,
  HireOperationsAuditPage,
  HireOperationsAuditTargetKind,
  HireOperationsDepartment,
  HireOperationsFunnelConversion,
  HireOperationsJobHealth,
  HireOperationsJobPerformance,
  HireOperationsJobsHealth,
  HireOperationsSmallSampleCandidate,
  HireOperationsScoreBucket,
  HireOperationsStageCounts,
  HireOperationsWorkspaceOverview,
} from "@hire-operations/types";

const STAGES = [
  "new",
  "screened",
  "interviewing",
  "shortlist",
  "offer",
  "hired",
  "rejected",
  "withdrawn",
] as const;

const JOB_STATUSES = ["open", "on_hold", "closed"] as const;
const ACTION_KINDS = [
  "candidates_awaiting_decision",
  "pending_human_scorecards",
  "terminal_human_kit_delivery_failures",
  "external_verdicts_received",
  "failed_multimodal_analyses",
  "interview_validation_attention",
] as const;
const CONVERSION_STAGES = [
  "screened",
  "interviewing",
  "shortlist",
  "offer",
  "hired",
] as const;
const SCORE_CHART_MIN_SAMPLE = 10;
const SMALL_SAMPLE_MAX_CANDIDATES = SCORE_CHART_MIN_SAMPLE - 1;
const AUDIT_KINDS = [
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
const AUDIT_TARGET_KINDS = [
  "application",
  "job",
  "report",
  "status_link",
  "digest_outbox",
  "onboarding_test_drive",
] as const;

type Stage = (typeof STAGES)[number];
type ActionKind = (typeof ACTION_KINDS)[number];

function record(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function stringValue(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

function nonNegativeInteger(value: unknown): number | null {
  return typeof value === "number" && Number.isInteger(value) && value >= 0
    ? value
    : null;
}

function nonNegativeNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) && value >= 0
    ? value
    : null;
}

function nullableNonNegativeNumber(value: unknown): number | null | undefined {
  if (value === null) return null;
  return nonNegativeNumber(value) ?? undefined;
}

function knownStage(value: unknown): value is Stage {
  return typeof value === "string" && STAGES.includes(value as Stage);
}

function knownJobStatus(
  value: unknown,
): value is (typeof JOB_STATUSES)[number] {
  return (
    typeof value === "string" &&
    JOB_STATUSES.includes(value as (typeof JOB_STATUSES)[number])
  );
}

function knownActionKind(value: unknown): value is ActionKind {
  return (
    typeof value === "string" && ACTION_KINDS.includes(value as ActionKind)
  );
}

function knownAuditKind(value: unknown): value is HireOperationsAuditKind {
  return (
    typeof value === "string" &&
    AUDIT_KINDS.includes(value as HireOperationsAuditKind)
  );
}

function knownAuditTargetKind(
  value: unknown,
): value is HireOperationsAuditTargetKind {
  return (
    typeof value === "string" &&
    AUDIT_TARGET_KINDS.includes(value as HireOperationsAuditTargetKind)
  );
}

function departmentFrom(value: unknown): HireOperationsDepartment | null {
  const source = record(value);
  if (!source) return null;
  const id = stringValue(source.id);
  const name = stringValue(source.name)?.trim();
  return id && validOpaqueId(id) && name && name.length <= 120
    ? { id, name }
    : null;
}

function validOpaqueId(value: unknown): value is string {
  return typeof value === "string" && /^[a-f0-9]{24}$/i.test(value);
}

function validTimestamp(value: unknown): value is string {
  return (
    typeof value === "string" &&
    Number.isFinite(new Date(value).getTime()) &&
    value.length <= 40
  );
}

function stageCountsFrom(value: unknown): HireOperationsStageCounts | null {
  const source = record(value);
  if (!source) return null;
  const entries = STAGES.map(
    (stage) => [stage, nonNegativeInteger(source[stage])] as const,
  );
  if (entries.some(([, count]) => count === null)) return null;
  return Object.fromEntries(entries) as HireOperationsStageCounts;
}

function scorecardCompletionFrom(value: unknown) {
  const source = record(value);
  if (!source) return null;
  const completed = nonNegativeInteger(source.completed);
  const pending = nonNegativeInteger(source.pending);
  const total = nonNegativeInteger(source.total);
  const rate =
    source.rate === null
      ? null
      : typeof source.rate === "number" &&
          Number.isFinite(source.rate) &&
          source.rate >= 0 &&
          source.rate <= 1
        ? source.rate
        : undefined;
  if (
    completed === null ||
    pending === null ||
    total === null ||
    rate === undefined
  )
    return null;
  if (
    total !== completed + pending ||
    (total === 0 ? rate !== null : rate === null)
  )
    return null;
  return { completed, pending, total, rate };
}

function actionInboxItemsFrom(
  value: unknown,
): HireOperationsActionInboxItem[] | null {
  if (!Array.isArray(value)) return null;
  const items = value.map((raw) => {
    const source = record(raw);
    if (!source || !knownActionKind(source.kind)) return null;
    const count = nonNegativeInteger(source.count);
    return count === null ? null : { kind: source.kind, count };
  });
  if (items.some((item) => item === null)) return null;
  return items as HireOperationsActionInboxItem[];
}

function attentionFrom(value: unknown): HireOperationsAttentionItem[] | null {
  if (!Array.isArray(value)) return null;
  const items = value.map((raw) => {
    const source = record(raw);
    if (!source) return null;
    const count = nonNegativeInteger(source.count);
    if (count === null) return null;
    if (source.kind === "stuck_in_stage") {
      const stage = source.stage;
      const oldestAgeDays = nonNegativeInteger(source.oldestAgeDays);
      const thresholdDays = nonNegativeInteger(source.thresholdDays);
      return knownStage(stage) &&
        oldestAgeDays !== null &&
        thresholdDays !== null
        ? {
            kind: "stuck_in_stage" as const,
            count,
            stage,
            oldestAgeDays,
            thresholdDays,
          }
        : null;
    }
    return knownActionKind(source.kind) ? { kind: source.kind, count } : null;
  });
  return items.some((item) => item === null)
    ? null
    : (items as HireOperationsAttentionItem[]);
}

function conversionsFrom(
  value: unknown,
): HireOperationsFunnelConversion[] | null {
  if (!Array.isArray(value)) return null;
  const conversions = value.map((raw) => {
    const source = record(raw);
    if (!source) return null;
    const stage = source.stage;
    const reached = nonNegativeInteger(source.reached);
    const rateFromStart =
      source.rateFromStart === null
        ? null
        : typeof source.rateFromStart === "number" &&
            Number.isFinite(source.rateFromStart) &&
            source.rateFromStart >= 0 &&
            source.rateFromStart <= 1
          ? source.rateFromStart
          : undefined;
    if (
      !CONVERSION_STAGES.includes(
        stage as (typeof CONVERSION_STAGES)[number],
      ) ||
      reached === null ||
      rateFromStart === undefined
    )
      return null;
    return {
      stage: stage as HireOperationsFunnelConversion["stage"],
      reached,
      rateFromStart,
    };
  });
  return conversions.some((conversion) => conversion === null)
    ? null
    : (conversions as HireOperationsFunnelConversion[]);
}

function scoreBucketsFrom(value: unknown): HireOperationsScoreBucket[] | null {
  if (!Array.isArray(value)) return null;
  const buckets = value.map((raw) => {
    const source = record(raw);
    if (!source) return null;
    const minimum = nonNegativeInteger(source.minimum);
    const maximum = nonNegativeInteger(source.maximum);
    const count = nonNegativeInteger(source.count);
    return minimum === null ||
      maximum === null ||
      count === null ||
      maximum < minimum
      ? null
      : { minimum, maximum, count };
  });
  return buckets.some((bucket) => bucket === null)
    ? null
    : (buckets as HireOperationsScoreBucket[]);
}

function smallSampleCandidatesFrom(
  value: unknown,
): HireOperationsSmallSampleCandidate[] | null {
  if (!Array.isArray(value)) return null;
  const applicationIds = new Set<string>();
  const candidates = value.map((raw, index) => {
    const source = record(raw);
    if (!source) return null;
    const applicationId = stringValue(source.applicationId)?.trim();
    const candidateName = stringValue(source.candidateName)?.trim();
    const score = nonNegativeNumber(source.score);
    const rank = nonNegativeInteger(source.rank);
    if (
      !applicationId ||
      !candidateName ||
      candidateName.length > 120 ||
      score === null ||
      score > 100 ||
      rank === null ||
      rank !== index + 1 ||
      applicationIds.has(applicationId)
    )
      return null;
    applicationIds.add(applicationId);
    return { applicationId, candidateName, score, rank };
  });
  return candidates.some((candidate) => candidate === null)
    ? null
    : (candidates as HireOperationsSmallSampleCandidate[]);
}

function auditItemsFrom(value: unknown): HireOperationsAuditItem[] | null {
  if (!Array.isArray(value)) return null;
  const items = value.map((raw) => {
    const source = record(raw);
    const actor = source && record(source.actor);
    const target = source && record(source.target);
    if (!source || !actor || !target || !knownAuditKind(source.kind)) {
      return null;
    }
    const occurredAt = source.occurredAt;
    const actorName = stringValue(actor.name)?.trim();
    const actorKind = actor.kind;
    const targetId = target.id;
    if (
      !validTimestamp(occurredAt) ||
      !actorName ||
      actorName.length > 120 ||
      (actorKind !== "member" && actorKind !== "system") ||
      !knownAuditTargetKind(target.kind) ||
      !validOpaqueId(targetId)
    ) {
      return null;
    }
    if (actorKind === "system" && actorName !== "System") return null;
    return {
      kind: source.kind,
      occurredAt,
      actor: { kind: actorKind, name: actorName },
      target: { kind: target.kind, id: targetId },
    };
  });
  return items.some((item) => item === null)
    ? null
    : (items as HireOperationsAuditItem[]);
}

export function overviewFrom(
  value: unknown,
): HireOperationsWorkspaceOverview | null {
  const source = record(value);
  const kpis = source && record(source.kpis);
  const inbox = source && record(source.actionInbox);
  if (!source || !kpis || !inbox) return null;
  const asOf = stringValue(source.asOf);
  const openJobs = nonNegativeInteger(kpis.openJobs);
  const candidatesAwaitingDecision = nonNegativeInteger(
    kpis.candidatesAwaitingDecision,
  );
  const scorecardCompletion = scorecardCompletionFrom(kpis.scorecardCompletion);
  const medianTimeToCloseDays = nullableNonNegativeNumber(
    kpis.medianTimeToCloseDays,
  );
  const items = actionInboxItemsFrom(inbox.items);
  if (
    !asOf ||
    openJobs === null ||
    candidatesAwaitingDecision === null ||
    !scorecardCompletion ||
    medianTimeToCloseDays === undefined ||
    !items
  )
    return null;
  return {
    asOf,
    kpis: {
      openJobs,
      candidatesAwaitingDecision,
      scorecardCompletion,
      medianTimeToCloseDays,
    },
    actionInbox: { items },
  };
}

export function jobsHealthFrom(
  value: unknown,
): HireOperationsJobsHealth | null {
  const source = record(value);
  if (!source || !Array.isArray(source.jobs)) return null;
  const asOf = stringValue(source.asOf);
  const jobs = source.jobs.map((raw) => {
    const job = record(raw);
    if (!job || !knownJobStatus(job.status)) return null;
    const jobId = stringValue(job.jobId);
    const title = stringValue(job.title);
    const department = departmentFrom(job.department);
    const daysOpen = nonNegativeInteger(job.daysOpen);
    const funnel = stageCountsFrom(job.funnel);
    const attention = attentionFrom(job.attention);
    if (!jobId || !title || !department || daysOpen === null || !funnel || !attention)
      return null;
    return {
      jobId,
      title,
      department,
      status: job.status,
      daysOpen,
      funnel,
      attention,
    };
  });
  return !asOf || jobs.some((job) => job === null)
    ? null
    : { asOf, jobs: jobs as HireOperationsJobHealth[] };
}

export function jobPerformanceFrom(
  value: unknown,
): HireOperationsJobPerformance | null {
  const source = record(value);
  const job = source && record(source.job);
  const funnel = source && record(source.funnel);
  const distribution = source && record(source.scoreDistribution);
  if (
    !source ||
    !job ||
    !funnel ||
    !distribution ||
    !knownJobStatus(job.status)
  )
    return null;
  const asOf = stringValue(source.asOf);
  const jobId = stringValue(job.jobId);
  const title = stringValue(job.title);
  const department = departmentFrom(job.department);
  const daysOpen = nonNegativeInteger(job.daysOpen);
  const current = stageCountsFrom(funnel.current);
  const conversions = conversionsFrom(funnel.conversions);
  const humanScorecards = scorecardCompletionFrom(source.humanScorecards);
  const sampleSize = nonNegativeInteger(distribution.sampleSize);
  const chartEligible =
    typeof distribution.chartEligible === "boolean"
      ? distribution.chartEligible
      : null;
  const buckets = scoreBucketsFrom(distribution.buckets);
  const timeToCloseDays = nullableNonNegativeNumber(source.timeToCloseDays);
  const hasFallbackCandidates = Object.prototype.hasOwnProperty.call(
    distribution,
    "fallbackCandidates",
  );
  const fallbackCandidates = hasFallbackCandidates
    ? smallSampleCandidatesFrom(distribution.fallbackCandidates)
    : undefined;
  if (
    !asOf ||
    !jobId ||
    !title ||
    !department ||
    daysOpen === null ||
    !current ||
    !conversions ||
    !humanScorecards ||
    sampleSize === null ||
    chartEligible === null ||
    !buckets ||
    timeToCloseDays === undefined ||
    (chartEligible &&
      (sampleSize < SCORE_CHART_MIN_SAMPLE ||
        buckets.length === 0 ||
        hasFallbackCandidates)) ||
    (!chartEligible &&
      (sampleSize >= SCORE_CHART_MIN_SAMPLE ||
        buckets.length > 0 ||
        fallbackCandidates === undefined ||
        fallbackCandidates === null ||
        fallbackCandidates.length >
          Math.min(sampleSize, SMALL_SAMPLE_MAX_CANDIDATES)))
  )
    return null;
  const scoreDistribution = chartEligible
    ? { sampleSize, chartEligible, buckets }
    : {
        sampleSize,
        chartEligible,
        buckets,
        fallbackCandidates: fallbackCandidates!,
      };
  return {
    asOf,
    job: { jobId, title, department, status: job.status, daysOpen },
    funnel: { current, conversions },
    humanScorecards,
    scoreDistribution,
    timeToCloseDays,
  };
}

export function auditPageFrom(value: unknown): HireOperationsAuditPage | null {
  const source = record(value);
  if (!source) return null;
  const items = auditItemsFrom(source.items);
  const nextCursor = source.nextCursor;
  if (
    !items ||
    (nextCursor !== null &&
      (typeof nextCursor !== "string" ||
        nextCursor.length === 0 ||
        nextCursor.length > 512))
  ) {
    return null;
  }
  return { items, nextCursor };
}

export class OperationsResponseError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
    this.name = "OperationsResponseError";
  }
}

export async function readOperationsResponse<T>(
  url: string,
  parser: (value: unknown) => T | null,
): Promise<T> {
  const response = await fetch(url, { cache: "no-store" });
  const value = await response.json().catch(() => null);
  if (!response.ok) {
    const source = record(value);
    throw new OperationsResponseError(
      stringValue(source?.error) ?? "Could not load operations data.",
      response.status,
    );
  }
  const parsed = parser(value);
  if (!parsed) throw new Error("The operations response was not valid.");
  return parsed;
}

export const operationsLabels: Record<ActionKind | "stuck_in_stage", string> = {
  candidates_awaiting_decision: "Candidates awaiting decision",
  pending_human_scorecards: "Human scorecards pending",
  terminal_human_kit_delivery_failures: "Interview-kit delivery failures",
  external_verdicts_received: "External verdicts received",
  failed_multimodal_analyses: "Interview analyses needing retry",
  interview_validation_attention: "Interview validation timelines available",
  stuck_in_stage: "Candidates waiting in a stage",
};

export const auditLabels: Record<HireOperationsAuditKind, string> = {
  application_created: "Application created",
  application_reapplied: "Application reopened",
  application_source_merged: "Application source merged",
  application_stage_changed: "Application stage changed",
  application_ai_round_sent: "AI assessment sent",
  application_ai_round_revoked: "AI assessment revoked",
  application_ai_result_linked: "AI assessment completed",
  application_human_round_logged: "Human interview logged",
  application_human_kit_sent: "Interview kit sent",
  application_human_kit_delivery_failed:
    "Interview-kit delivery needs attention",
  application_human_kit_reminded: "Interview-kit reminder sent",
  application_human_kit_revoked: "Interview kit revoked",
  application_human_scorecard_submitted: "Human scorecard submitted",
  job_status_changed: "Job status changed",
  job_department_changed: "Job department changed",
  report_requested: "Report requested",
  report_generation_started: "Report generation started",
  report_ready: "Report ready",
  report_failed: "Report generation did not complete",
  report_expired: "Report expired",
  report_cancelled: "Report cancelled",
  status_link_issued: "Candidate status link issued",
  status_link_revoked: "Candidate status link revoked",
  digest_delivery_queued: "Daily summary queued",
  digest_delivery_sent: "Daily summary sent",
  digest_delivery_cancelled: "Daily summary cancelled",
  onboarding_test_drive_started: "Practice interview started",
  onboarding_test_drive_ready: "Practice interview ready",
  onboarding_test_drive_removed: "Practice interview removed",
};

export const stageLabels: Record<Stage, string> = {
  new: "New",
  screened: "Screened",
  interviewing: "Interviewing",
  shortlist: "Shortlist",
  offer: "Offer",
  hired: "Hired",
  rejected: "Rejected",
  withdrawn: "Withdrawn",
};

export const stages = STAGES;
