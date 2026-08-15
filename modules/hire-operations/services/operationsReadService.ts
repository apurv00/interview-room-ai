import mongoose, { type PipelineStage } from "mongoose";
import { AppError } from "@shared/errors";
import {
  HIRE_HUMAN_KIT_MAX_ATTEMPTS,
  HIRE_STAGES,
  HireApplication,
  HireCandidate,
  HireHumanKitDelivery,
  HireHumanRound,
  HireInterviewResult,
  HireJob,
  HirePrivacyRequest,
  activeHirePrivacyRequestFilter,
  type HireJobStatus,
  type HireStage,
} from "@hire-operations-boundary";
import { HireExternalVerdict } from "@hire-decisions/models";
import { buildHireOnboardingTestDriveExclusionStages } from "@/modules/hire-onboarding/services/testDriveService";
import type {
  HireOperationsActionInboxItem,
  HireOperationsAttentionItem,
  HireOperationsFunnelConversion,
  HireOperationsJobHealth,
  HireOperationsJobPerformance,
  HireOperationsJobsHealth,
  HireOperationsSmallSampleCandidate,
  HireOperationsScoreBucket,
  HireOperationsScorecardCompletion,
  HireOperationsScoreDistribution,
  HireOperationsStageCounts,
  HireOperationsWorkspaceOverview,
} from "../types";
import { connectHireOperationsDB } from "./hireOperationsBoundary";

export const HIRE_OPERATIONS_STUCK_STAGE_DAYS = 6;
export const HIRE_OPERATIONS_SCORE_CHART_MIN_SAMPLE = 10;
export const HIRE_OPERATIONS_SMALL_SAMPLE_MAX_CANDIDATES =
  HIRE_OPERATIONS_SCORE_CHART_MIN_SAMPLE - 1;

const PROGRESSIVE_FUNNEL_STAGES: readonly Exclude<
  HireStage,
  "rejected" | "withdrawn"
>[] = ["new", "screened", "interviewing", "shortlist", "offer", "hired"];

const CONVERSION_STAGES: readonly Exclude<
  HireStage,
  "new" | "rejected" | "withdrawn"
>[] = ["screened", "interviewing", "shortlist", "offer", "hired"];

const SCORE_BUCKET_RANGES = [
  [0, 49],
  [50, 59],
  [60, 69],
  [70, 79],
  [80, 89],
  [90, 100],
] as const;

type IdLike = mongoose.Types.ObjectId | string;

type OperationsJobRecord = {
  _id: IdLike;
  title: string;
  status: HireJobStatus;
  createdAt: Date;
  closedAt?: Date;
};

type OperationsApplicationRecord = {
  _id: IdLike;
  jobId: IdLike;
  candidateId: IdLike;
  stage: HireStage;
  createdAt: Date;
  events?: Array<{ to?: unknown; at?: unknown }>;
};

type OperationsCandidateRecord = {
  _id: IdLike;
  /** The sole PII field selected for the member-only small-sample fallback. */
  name?: unknown;
};

type OperationsHumanRoundRecord = {
  jobId: IdLike;
  applicationId: IdLike;
  candidateId: IdLike;
  status: "pending_scorecard" | "completed" | "revoked";
};

type OperationsDeliveryRecord = {
  jobId: IdLike;
  applicationId: IdLike;
  candidateId: IdLike;
};

type OperationsVerdictRecord = {
  jobId: IdLike;
  applicationId: IdLike;
  candidateId: IdLike;
};

type OperationsResultRecord = {
  _id: IdLike;
  applicationId: IdLike;
  jobId: IdLike;
  candidateId: IdLike;
  completedAt: Date;
  numericSummary?: { overallScore?: unknown };
};

type OperationsScoredApplication = {
  applicationId: string;
  score: number;
  candidateName?: string;
};

type OperationsWorkspaceBatch = {
  jobs: OperationsJobRecord[];
  applications: OperationsApplicationRecord[];
  humanRounds: OperationsHumanRoundRecord[];
  terminalDeliveries: OperationsDeliveryRecord[];
  externalVerdicts: OperationsVerdictRecord[];
};

/**
 * Keep synthetic onboarding test-drive graph records out of this read model at
 * the database boundary. A removed drive remains marked until lifecycle
 * cleanup, so title/name matching is neither necessary nor safe here.
 */
function excludeHireOnboardingTestDrives(input: {
  coordinate: "applicationId" | "jobId" | "candidateId" | "roundId";
  sourceIdField?: string;
}): PipelineStage[] {
  return buildHireOnboardingTestDriveExclusionStages(
    input,
  ) as unknown as PipelineStage[];
}

export class HireOperationsError extends AppError {
  constructor(
    message: string,
    readonly code: "OPERATIONS_INVALID_SCOPE" | "OPERATIONS_SCOPE_NOT_FOUND",
    readonly status: 400 | 404,
  ) {
    super(message, status, code);
    this.name = "HireOperationsError";
  }
}

function objectId(value: string, label: string): mongoose.Types.ObjectId {
  if (!mongoose.Types.ObjectId.isValid(value)) {
    throw new HireOperationsError(
      `Invalid ${label}`,
      "OPERATIONS_INVALID_SCOPE",
      400,
    );
  }
  return new mongoose.Types.ObjectId(value);
}

function recordId(value: IdLike): string {
  return value.toString();
}

/**
 * A live privacy request immediately removes the candidate from every
 * operations projection. Keep this fence at the workspace batch boundary so
 * overview, health, and the small-sample performance exception share exactly
 * the same authorized candidate set without per-candidate reads.
 */
function candidateIdsWithoutLivePrivacyRequests(
  activeCandidates: Array<{ _id: IdLike }>,
  livePrivacyRequests: Array<{ candidateId: IdLike }>,
): IdLike[] {
  const privacyPendingCandidateIds = new Set(
    livePrivacyRequests.map((request) => recordId(request.candidateId)),
  );
  return activeCandidates
    .map((candidate) => candidate._id)
    .filter(
      (candidateId) => !privacyPendingCandidateIds.has(recordId(candidateId)),
    );
}

function normalizedNow(value?: Date): Date {
  const now = value ? new Date(value.getTime()) : new Date();
  if (Number.isNaN(now.getTime())) {
    throw new HireOperationsError(
      "Invalid operations timestamp",
      "OPERATIONS_INVALID_SCOPE",
      400,
    );
  }
  return now;
}

function rounded(value: number, decimals = 3): number {
  const multiplier = 10 ** decimals;
  return Math.round(value * multiplier) / multiplier;
}

function elapsedDays(start: Date, end: Date): number {
  return Math.max(
    0,
    Math.floor((end.getTime() - start.getTime()) / 86_400_000),
  );
}

function durationDays(start: Date, end: Date): number {
  return Math.max(
    0,
    rounded((end.getTime() - start.getTime()) / 86_400_000, 1),
  );
}

function emptyStageCounts(): HireOperationsStageCounts {
  return Object.fromEntries(
    HIRE_STAGES.map((stage) => [stage, 0]),
  ) as HireOperationsStageCounts;
}

function isKnownStage(value: unknown): value is HireStage {
  return typeof value === "string" && HIRE_STAGES.includes(value as HireStage);
}

function currentStageCounts(
  applications: readonly OperationsApplicationRecord[],
): HireOperationsStageCounts {
  const counts = emptyStageCounts();
  for (const application of applications) {
    if (isKnownStage(application.stage)) counts[application.stage] += 1;
  }
  return counts;
}

function stageEnteredAt(application: OperationsApplicationRecord): Date {
  let latest: Date | undefined;
  for (const event of application.events ?? []) {
    if (event.to !== application.stage || !(event.at instanceof Date)) continue;
    if (!latest || event.at.getTime() > latest.getTime()) latest = event.at;
  }
  return latest ?? application.createdAt;
}

function hasReachedStage(
  application: OperationsApplicationRecord,
  target: Exclude<HireStage, "rejected" | "withdrawn">,
): boolean {
  if (application.stage === target) return true;
  if ((application.events ?? []).some((event) => event.to === target))
    return true;
  const currentIndex = PROGRESSIVE_FUNNEL_STAGES.indexOf(
    application.stage as Exclude<HireStage, "rejected" | "withdrawn">,
  );
  const targetIndex = PROGRESSIVE_FUNNEL_STAGES.indexOf(target);
  return currentIndex >= targetIndex && currentIndex !== -1;
}

function funnelConversions(
  applications: readonly OperationsApplicationRecord[],
): HireOperationsFunnelConversion[] {
  return CONVERSION_STAGES.map((stage) => {
    const reached = applications.filter((application) =>
      hasReachedStage(application, stage),
    ).length;
    return {
      stage,
      reached,
      rateFromStart:
        applications.length > 0 ? rounded(reached / applications.length) : null,
    };
  });
}

function scorecardCompletion(
  rounds: readonly OperationsHumanRoundRecord[],
): HireOperationsScorecardCompletion {
  let completed = 0;
  let pending = 0;
  for (const round of rounds) {
    if (round.status === "completed") completed += 1;
    if (round.status === "pending_scorecard") pending += 1;
  }
  const total = completed + pending;
  return {
    completed,
    pending,
    total,
    rate: total > 0 ? rounded(completed / total) : null,
  };
}

function median(values: readonly number[]): number | null {
  if (values.length === 0) return null;
  const ordered = [...values].sort((left, right) => left - right);
  const middle = Math.floor(ordered.length / 2);
  return ordered.length % 2 === 1
    ? ordered[middle]
    : rounded((ordered[middle - 1] + ordered[middle]) / 2, 1);
}

function activeJobIds(jobs: readonly OperationsJobRecord[]): Set<string> {
  return new Set(
    jobs.filter((job) => job.status === "open").map((job) => recordId(job._id)),
  );
}

function applicationsAwaitingDecision(
  applications: readonly OperationsApplicationRecord[],
  openJobIds: ReadonlySet<string>,
): number {
  return applications.filter(
    (application) =>
      openJobIds.has(recordId(application.jobId)) &&
      (application.stage === "shortlist" || application.stage === "offer"),
  ).length;
}

function countForOpenJobs<T extends { jobId: IdLike }>(
  records: readonly T[],
  openJobIds: ReadonlySet<string>,
): number {
  return records.filter((record) => openJobIds.has(recordId(record.jobId)))
    .length;
}

function overviewActionItems(
  batch: OperationsWorkspaceBatch,
  openJobIds: ReadonlySet<string>,
): HireOperationsActionInboxItem[] {
  return [
    {
      kind: "candidates_awaiting_decision",
      count: applicationsAwaitingDecision(batch.applications, openJobIds),
    },
    {
      kind: "pending_human_scorecards",
      count: countForOpenJobs(
        batch.humanRounds.filter(
          (round) => round.status === "pending_scorecard",
        ),
        openJobIds,
      ),
    },
    {
      kind: "terminal_human_kit_delivery_failures",
      count: countForOpenJobs(batch.terminalDeliveries, openJobIds),
    },
    {
      kind: "external_verdicts_received",
      count: countForOpenJobs(batch.externalVerdicts, openJobIds),
    },
  ];
}

function healthAttention(
  job: OperationsJobRecord,
  applications: readonly OperationsApplicationRecord[],
  humanRounds: readonly OperationsHumanRoundRecord[],
  terminalDeliveries: readonly OperationsDeliveryRecord[],
  externalVerdicts: readonly OperationsVerdictRecord[],
  now: Date,
): HireOperationsAttentionItem[] {
  // A held/closed requisition has no live operating-action requirement. Its
  // row remains visible for context, but no aging signal is manufactured.
  if (job.status !== "open") return [];
  const attention: HireOperationsAttentionItem[] = [];
  const decisionCount = applications.filter(
    (application) =>
      application.stage === "shortlist" || application.stage === "offer",
  ).length;
  if (decisionCount > 0) {
    attention.push({
      kind: "candidates_awaiting_decision",
      count: decisionCount,
    });
  }

  for (const stage of HIRE_STAGES) {
    if (stage === "hired" || stage === "rejected" || stage === "withdrawn")
      continue;
    const ages = applications
      .filter((application) => application.stage === stage)
      .map((application) => elapsedDays(stageEnteredAt(application), now))
      .filter((age) => age >= HIRE_OPERATIONS_STUCK_STAGE_DAYS);
    if (ages.length > 0) {
      attention.push({
        kind: "stuck_in_stage",
        stage,
        count: ages.length,
        oldestAgeDays: Math.max(...ages),
        thresholdDays: HIRE_OPERATIONS_STUCK_STAGE_DAYS,
      });
    }
  }

  const pendingScorecards = humanRounds.filter(
    (round) => round.status === "pending_scorecard",
  ).length;
  if (pendingScorecards > 0) {
    attention.push({
      kind: "pending_human_scorecards",
      count: pendingScorecards,
    });
  }
  if (terminalDeliveries.length > 0) {
    attention.push({
      kind: "terminal_human_kit_delivery_failures",
      count: terminalDeliveries.length,
    });
  }
  if (externalVerdicts.length > 0) {
    attention.push({
      kind: "external_verdicts_received",
      count: externalVerdicts.length,
    });
  }

  return attention;
}

function healthAttentionWeight(
  attention: readonly HireOperationsAttentionItem[],
): number {
  return attention.reduce((total, item) => total + item.count, 0);
}

function recordsByJob<T extends { jobId: IdLike }>(
  records: readonly T[],
): Map<string, T[]> {
  const grouped = new Map<string, T[]>();
  for (const record of records) {
    const jobId = recordId(record.jobId);
    const entries = grouped.get(jobId);
    if (entries) entries.push(record);
    else grouped.set(jobId, [record]);
  }
  return grouped;
}

function buildWorkspaceOverview(
  batch: OperationsWorkspaceBatch,
  now: Date,
): HireOperationsWorkspaceOverview {
  const openJobIds = activeJobIds(batch.jobs);
  const activeRounds = batch.humanRounds.filter((round) =>
    openJobIds.has(recordId(round.jobId)),
  );
  const closeDurations = batch.jobs.flatMap((job) =>
    job.status === "closed" && job.closedAt instanceof Date
      ? [durationDays(job.createdAt, job.closedAt)]
      : [],
  );
  return {
    asOf: now.toISOString(),
    kpis: {
      openJobs: openJobIds.size,
      candidatesAwaitingDecision: applicationsAwaitingDecision(
        batch.applications,
        openJobIds,
      ),
      scorecardCompletion: scorecardCompletion(activeRounds),
      medianTimeToCloseDays: median(closeDurations),
    },
    actionInbox: { items: overviewActionItems(batch, openJobIds) },
  };
}

function buildJobsHealth(
  batch: OperationsWorkspaceBatch,
  now: Date,
): HireOperationsJobsHealth {
  const applicationsByJob = recordsByJob(batch.applications);
  const humanRoundsByJob = recordsByJob(batch.humanRounds);
  const terminalDeliveriesByJob = recordsByJob(batch.terminalDeliveries);
  const externalVerdictsByJob = recordsByJob(batch.externalVerdicts);
  // Close-out history remains available to the overview's median-time-to-close
  // KPI, but it is not live operational work. Keep it out of the health
  // surface so a member cannot mistake a completed requisition for an active
  // pipeline row.
  const jobs = batch.jobs
    .filter((job) => job.status !== "closed")
    .map((job): HireOperationsJobHealth => {
      const jobId = recordId(job._id);
      const applications = applicationsByJob.get(jobId) ?? [];
      const humanRounds = humanRoundsByJob.get(jobId) ?? [];
      const terminalDeliveries = terminalDeliveriesByJob.get(jobId) ?? [];
      const externalVerdicts = externalVerdictsByJob.get(jobId) ?? [];
      return {
        jobId,
        title: job.title,
        status: job.status,
        daysOpen: elapsedDays(job.createdAt, job.closedAt ?? now),
        funnel: currentStageCounts(applications),
        attention: healthAttention(
          job,
          applications,
          humanRounds,
          terminalDeliveries,
          externalVerdicts,
          now,
        ),
      };
    });
  jobs.sort((left, right) => {
    const attentionDelta =
      healthAttentionWeight(right.attention) -
      healthAttentionWeight(left.attention);
    if (attentionDelta !== 0) return attentionDelta;
    const ageDelta = right.daysOpen - left.daysOpen;
    if (ageDelta !== 0) return ageDelta;
    return left.jobId.localeCompare(right.jobId);
  });
  return { asOf: now.toISOString(), jobs };
}

function validScore(value: unknown): value is number {
  return (
    typeof value === "number" &&
    Number.isFinite(value) &&
    value >= 0 &&
    value <= 100
  );
}

function displayName(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function latestResultsByApplication(
  results: readonly OperationsResultRecord[],
): Map<string, OperationsResultRecord> {
  const latest = new Map<string, OperationsResultRecord>();
  for (const result of results) {
    const key = recordId(result.applicationId);
    const previous = latest.get(key);
    if (
      !previous ||
      result.completedAt.getTime() > previous.completedAt.getTime() ||
      (result.completedAt.getTime() === previous.completedAt.getTime() &&
        recordId(result._id).localeCompare(recordId(previous._id)) > 0)
    ) {
      latest.set(key, result);
    }
  }
  return latest;
}

function latestScoresByApplication(
  results: readonly OperationsResultRecord[],
): number[] {
  return Array.from(latestResultsByApplication(results).values())
    .map((result) => result.numericSummary?.overallScore)
    .filter(validScore);
}

function scoredApplicationsForJob(input: {
  jobId: string;
  applicationsById: ReadonlyMap<string, OperationsApplicationRecord>;
  candidates: readonly OperationsCandidateRecord[];
  results: readonly OperationsResultRecord[];
}): OperationsScoredApplication[] {
  const candidateNames = new Map(
    input.candidates.map((candidate) => [
      recordId(candidate._id),
      displayName(candidate.name),
    ]),
  );
  const scopedResults = input.results.filter((result) => {
    const application = input.applicationsById.get(
      recordId(result.applicationId),
    );
    return (
      recordId(result.jobId) === input.jobId &&
      application !== undefined &&
      recordId(result.candidateId) === recordId(application.candidateId)
    );
  });
  const scored: OperationsScoredApplication[] = [];
  for (const [applicationId, result] of Array.from(
    latestResultsByApplication(scopedResults).entries(),
  )) {
    const application = input.applicationsById.get(applicationId);
    const score = result.numericSummary?.overallScore;
    if (!application || !validScore(score)) continue;
    const candidateId = recordId(application.candidateId);
    scored.push({
      applicationId,
      score,
      candidateName: candidateNames.get(candidateId),
    });
  }
  return scored;
}

function smallSampleCandidates(
  scoredApplications: readonly OperationsScoredApplication[],
): HireOperationsSmallSampleCandidate[] {
  return scoredApplications
    .flatMap((application) =>
      application.candidateName
        ? [
            {
              applicationId: application.applicationId,
              candidateName: application.candidateName,
              score: application.score,
            },
          ]
        : [],
    )
    .sort(
      (left, right) =>
        right.score - left.score ||
        left.applicationId.localeCompare(right.applicationId),
    )
    .slice(0, HIRE_OPERATIONS_SMALL_SAMPLE_MAX_CANDIDATES)
    .map((candidate, index) => ({ ...candidate, rank: index + 1 }));
}

function scoreDistribution(
  scores: readonly number[],
  fallbackCandidates: readonly HireOperationsSmallSampleCandidate[] = [],
): HireOperationsScoreDistribution {
  const chartEligible = scores.length >= HIRE_OPERATIONS_SCORE_CHART_MIN_SAMPLE;
  if (!chartEligible) {
    return {
      sampleSize: scores.length,
      chartEligible,
      buckets: [],
      fallbackCandidates: fallbackCandidates.slice(
        0,
        HIRE_OPERATIONS_SMALL_SAMPLE_MAX_CANDIDATES,
      ),
    };
  }
  return {
    sampleSize: scores.length,
    chartEligible,
    buckets: SCORE_BUCKET_RANGES.map(([minimum, maximum]) => ({
      minimum,
      maximum,
      count: scores.filter((score) => score >= minimum && score <= maximum)
        .length,
    })),
  };
}

function buildJobPerformance(input: {
  job: OperationsJobRecord;
  applications: OperationsApplicationRecord[];
  candidates: OperationsCandidateRecord[];
  humanRounds: OperationsHumanRoundRecord[];
  results: OperationsResultRecord[];
  now: Date;
}): HireOperationsJobPerformance {
  const { job, applications, candidates, humanRounds, results, now } = input;
  const jobId = recordId(job._id);
  const jobApplications = applications.filter(
    (application) => recordId(application.jobId) === jobId,
  );
  const applicationsById = new Map(
    jobApplications.map((application) => [
      recordId(application._id),
      application,
    ]),
  );
  const jobHumanRounds = humanRounds.filter((round) => {
    const application = applicationsById.get(recordId(round.applicationId));
    return (
      recordId(round.jobId) === jobId &&
      application !== undefined &&
      recordId(round.candidateId) === recordId(application.candidateId)
    );
  });
  const scoredApplications = scoredApplicationsForJob({
    jobId,
    applicationsById,
    candidates,
    results,
  });
  return {
    asOf: now.toISOString(),
    job: {
      jobId: recordId(job._id),
      title: job.title,
      status: job.status,
      daysOpen: elapsedDays(job.createdAt, job.closedAt ?? now),
    },
    funnel: {
      current: currentStageCounts(jobApplications),
      conversions: funnelConversions(jobApplications),
    },
    humanScorecards: scorecardCompletion(jobHumanRounds),
    scoreDistribution: scoreDistribution(
      scoredApplications.map((application) => application.score),
      smallSampleCandidates(scoredApplications),
    ),
    timeToCloseDays:
      job.status === "closed" && job.closedAt instanceof Date
        ? durationDays(job.createdAt, job.closedAt)
        : null,
  };
}

async function readWorkspaceBatch(
  workspaceId: mongoose.Types.ObjectId,
  now: Date,
): Promise<OperationsWorkspaceBatch> {
  await connectHireOperationsDB();
  const [jobs, activeCandidates, livePrivacyRequests] = await Promise.all([
    HireJob.aggregate([
      { $match: { workspaceId } },
      ...excludeHireOnboardingTestDrives({ coordinate: "jobId" }),
      { $project: { _id: 1, title: 1, status: 1, createdAt: 1, closedAt: 1 } },
    ]),
    HireCandidate.aggregate([
      { $match: { workspaceId, piiAnonymizedAt: { $exists: false } } },
      ...excludeHireOnboardingTestDrives({ coordinate: "candidateId" }),
      { $project: { _id: 1 } },
    ]),
    HirePrivacyRequest.find({ workspaceId, ...activeHirePrivacyRequestFilter(now) })
      .select("candidateId")
      .lean(),
  ]);
  const candidateIds = candidateIdsWithoutLivePrivacyRequests(
    activeCandidates,
    livePrivacyRequests,
  );
  if (candidateIds.length === 0) {
    return {
      jobs: jobs as unknown as OperationsJobRecord[],
      applications: [],
      humanRounds: [],
      terminalDeliveries: [],
      externalVerdicts: [],
    };
  }
  const baseScope = { workspaceId, candidateId: { $in: candidateIds } };
  const [applications, humanRounds, terminalDeliveries, externalVerdicts] =
    await Promise.all([
      HireApplication.aggregate([
        { $match: baseScope },
        ...excludeHireOnboardingTestDrives({ coordinate: "applicationId" }),
        {
          $project: {
            _id: 1,
            jobId: 1,
            candidateId: 1,
            stage: 1,
            createdAt: 1,
            "events.to": 1,
            "events.at": 1,
          },
        },
      ]),
      HireHumanRound.aggregate([
        {
          $match: {
            ...baseScope,
            privacyRedactedAt: { $exists: false },
          },
        },
        ...excludeHireOnboardingTestDrives({
          coordinate: "applicationId",
          sourceIdField: "applicationId",
        }),
        ...excludeHireOnboardingTestDrives({ coordinate: "roundId" }),
        {
          $project: {
            _id: 0,
            jobId: 1,
            applicationId: 1,
            candidateId: 1,
            status: 1,
          },
        },
      ]),
      HireHumanKitDelivery.aggregate([
        {
          $match: {
            ...baseScope,
            status: "failed",
            attempts: { $gte: HIRE_HUMAN_KIT_MAX_ATTEMPTS },
          },
        },
        ...excludeHireOnboardingTestDrives({
          coordinate: "applicationId",
          sourceIdField: "applicationId",
        }),
        { $project: { _id: 0, jobId: 1, applicationId: 1, candidateId: 1 } },
      ]),
      HireExternalVerdict.aggregate([
        {
          $match: {
            ...baseScope,
            privacyRedactedAt: { $exists: false },
          },
        },
        ...excludeHireOnboardingTestDrives({
          coordinate: "applicationId",
          sourceIdField: "applicationId",
        }),
        { $project: { _id: 0, jobId: 1, applicationId: 1, candidateId: 1 } },
      ]),
    ]);
  return {
    jobs: jobs as unknown as OperationsJobRecord[],
    applications: applications as unknown as OperationsApplicationRecord[],
    humanRounds: humanRounds as unknown as OperationsHumanRoundRecord[],
    terminalDeliveries:
      terminalDeliveries as unknown as OperationsDeliveryRecord[],
    externalVerdicts: externalVerdicts as unknown as OperationsVerdictRecord[],
  };
}

/**
 * Read only the current member workspace's operational KPI strip and grouped
 * inbox signals. It performs fixed workspace-scoped batch queries and never
 * reads candidate contact, resumes, evidence, comments, ranks, notes, or IDs.
 */
export async function readHireWorkspaceOverview(input: {
  workspaceId: string;
  now?: Date;
}): Promise<HireOperationsWorkspaceOverview> {
  const workspaceId = objectId(input.workspaceId, "workspace id");
  const now = normalizedNow(input.now);
  return buildWorkspaceOverview(await readWorkspaceBatch(workspaceId, now), now);
}

/**
 * Read one attention-sorted row per job in the member's workspace. No action,
 * lifecycle transition, report export, or candidate record is created here.
 */
export async function readHireJobsHealth(input: {
  workspaceId: string;
  now?: Date;
}): Promise<HireOperationsJobsHealth> {
  const workspaceId = objectId(input.workspaceId, "workspace id");
  const now = normalizedNow(input.now);
  return buildJobsHealth(await readWorkspaceBatch(workspaceId, now), now);
}

/**
 * Read batch-derived performance for one exact workspace job. At fewer than
 * ten valid scores, its sole member-only identity exception is a capped,
 * same-job `{ applicationId, candidateName, score, rank }` fallback. At the
 * chart floor that property is omitted and only aggregate buckets are sent.
 */
export async function readHireJobPerformance(input: {
  workspaceId: string;
  jobId: string;
  now?: Date;
}): Promise<HireOperationsJobPerformance> {
  const workspaceId = objectId(input.workspaceId, "workspace id");
  const jobId = objectId(input.jobId, "job id");
  const now = normalizedNow(input.now);
  await connectHireOperationsDB();
  const [jobs, activeCandidates, livePrivacyRequests] = await Promise.all([
    HireJob.aggregate([
      { $match: { _id: jobId, workspaceId } },
      ...excludeHireOnboardingTestDrives({ coordinate: "jobId" }),
      { $project: { _id: 1, title: 1, status: 1, createdAt: 1, closedAt: 1 } },
    ]),
    HireCandidate.aggregate([
      { $match: { workspaceId, piiAnonymizedAt: { $exists: false } } },
      ...excludeHireOnboardingTestDrives({ coordinate: "candidateId" }),
      { $project: { _id: 1 } },
    ]),
    HirePrivacyRequest.find({ workspaceId, ...activeHirePrivacyRequestFilter(now) })
      .select("candidateId")
      .lean(),
  ]);
  const job = jobs[0] as OperationsJobRecord | undefined;
  if (!job) {
    throw new HireOperationsError(
      "Job not found",
      "OPERATIONS_SCOPE_NOT_FOUND",
      404,
    );
  }
  const candidateIds = candidateIdsWithoutLivePrivacyRequests(
    activeCandidates,
    livePrivacyRequests,
  );
  if (candidateIds.length === 0) {
    return buildJobPerformance({
      job: job as unknown as OperationsJobRecord,
      applications: [],
      candidates: [],
      humanRounds: [],
      results: [],
      now,
    });
  }
  const baseScope = { workspaceId, jobId, candidateId: { $in: candidateIds } };
  const [applications, humanRounds, results] = await Promise.all([
    HireApplication.aggregate([
      { $match: baseScope },
      ...excludeHireOnboardingTestDrives({ coordinate: "applicationId" }),
      {
        $project: {
          _id: 1,
          jobId: 1,
          candidateId: 1,
          stage: 1,
          createdAt: 1,
          "events.to": 1,
          "events.at": 1,
        },
      },
    ]),
    HireHumanRound.aggregate([
      {
        $match: {
          ...baseScope,
          privacyRedactedAt: { $exists: false },
        },
      },
      ...excludeHireOnboardingTestDrives({
        coordinate: "applicationId",
        sourceIdField: "applicationId",
      }),
      ...excludeHireOnboardingTestDrives({ coordinate: "roundId" }),
      {
        $project: {
          _id: 0,
          jobId: 1,
          applicationId: 1,
          candidateId: 1,
          status: 1,
        },
      },
    ]),
    HireInterviewResult.aggregate([
      {
        $match: {
          ...baseScope,
          piiPurgedAt: { $exists: false },
        },
      },
      ...excludeHireOnboardingTestDrives({
        coordinate: "applicationId",
        sourceIdField: "applicationId",
      }),
      {
        $project: {
          _id: 1,
          applicationId: 1,
          jobId: 1,
          candidateId: 1,
          completedAt: 1,
          "numericSummary.overallScore": 1,
        },
      },
      { $sort: { completedAt: -1, _id: -1 } },
    ]),
  ]);
  const authorizedCandidateIds = new Set(candidateIds.map(recordId));
  const applicationCandidateIds = Array.from(
    new Set(
      applications
        .map((application) => recordId(application.candidateId))
        .filter((candidateId) => authorizedCandidateIds.has(candidateId)),
    ),
  );
  const candidates =
    applicationCandidateIds.length === 0
      ? []
      : await HireCandidate.aggregate([
          {
            $match: {
              workspaceId,
              _id: { $in: applicationCandidateIds },
              piiAnonymizedAt: { $exists: false },
            },
          },
          ...excludeHireOnboardingTestDrives({ coordinate: "candidateId" }),
          { $project: { _id: 1, name: 1 } },
        ]);
  return buildJobPerformance({
    job: job as unknown as OperationsJobRecord,
    applications: applications as unknown as OperationsApplicationRecord[],
    candidates: candidates as unknown as OperationsCandidateRecord[],
    humanRounds: humanRounds as unknown as OperationsHumanRoundRecord[],
    results: results as unknown as OperationsResultRecord[],
    now,
  });
}

export const __hireOperations = {
  buildWorkspaceOverview,
  buildJobsHealth,
  buildJobPerformance,
  currentStageCounts,
  funnelConversions,
  latestScoresByApplication,
  smallSampleCandidates,
  scoreDistribution,
  stageEnteredAt,
};
