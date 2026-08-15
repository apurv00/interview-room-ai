"use client";

import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
import Badge from "@shared/ui/Badge";
import StateView from "@shared/ui/StateView";
import type { HireOperationsJobPerformance } from "@hire-operations/types";
import {
  jobPerformanceFrom,
  readOperationsResponse,
  stageLabels,
  stages,
} from "../../../_operations/operationsView";

const STATUS_VARIANT = {
  open: "success",
  on_hold: "caution",
  closed: "default",
} as const;

function percentage(value: number | null): string {
  return value === null ? "—" : `${Math.round(value * 100)}%`;
}

export default function JobPerformancePanel({ jobId }: { jobId: string }) {
  const [performance, setPerformance] =
    useState<HireOperationsJobPerformance | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setError(null);
    try {
      setPerformance(
        await readOperationsResponse(
          `/api/workspace/jobs/${encodeURIComponent(jobId)}/performance`,
          jobPerformanceFrom,
        ),
      );
    } catch (cause) {
      setError(
        cause instanceof Error
          ? cause.message
          : "Could not load job performance.",
      );
    }
  }, [jobId]);

  useEffect(() => {
    void load();
  }, [load]);

  if (error)
    return (
      <StateView state="error" error={error} onRetry={() => void load()} />
    );
  if (!performance) return <StateView state="loading" skeletonLayout="card" />;

  const maxBucket = Math.max(
    1,
    ...performance.scoreDistribution.buckets.map((bucket) => bucket.count),
  );

  return (
    <div className="space-y-7">
      <header className="flex flex-col gap-4 sm:flex-row sm:items-end sm:justify-between">
        <div>
          <p className="text-sm font-medium text-indigo-700">
            Per-job performance
          </p>
          <div className="mt-1 flex flex-wrap items-center gap-2">
            <h1 className="text-2xl font-bold tracking-tight text-[#0f1419]">
              {performance.job.title}
            </h1>
            <Badge variant={STATUS_VARIANT[performance.job.status]}>
              {performance.job.status.replace("_", " ")}
            </Badge>
          </div>
          <p className="mt-2 text-sm text-[#536471]">
            {performance.job.daysOpen} day
            {performance.job.daysOpen === 1 ? "" : "s"} open
            {performance.timeToCloseDays !== null
              ? ` · closed in ${performance.timeToCloseDays} days`
              : ""}
          </p>
        </div>
        <div className="flex flex-wrap gap-2">
          <Link
            href="/workspace/jobs/health"
            className="inline-flex items-center rounded-lg border border-[#cbd5e1] bg-white px-3 py-2 text-sm font-medium text-[#0f1419] hover:bg-slate-50"
          >
            Jobs health
          </Link>
          <Link
            href={`/workspace/jobs/${encodeURIComponent(jobId)}`}
            className="inline-flex items-center rounded-lg border border-[#cbd5e1] bg-white px-3 py-2 text-sm font-medium text-[#0f1419] hover:bg-slate-50"
          >
            Pipeline
          </Link>
        </div>
      </header>

      <section
        className="rounded-2xl border border-[#e1e8ed] bg-white p-5"
        aria-labelledby="funnel-title"
      >
        <div>
          <h2
            id="funnel-title"
            className="text-lg font-semibold text-[#0f1419]"
          >
            Pipeline funnel
          </h2>
          <p className="mt-1 text-sm text-[#536471]">
            Current stage counts and the share of applications that reached each
            milestone.
          </p>
        </div>
        <div className="mt-5 grid grid-cols-2 gap-3 sm:grid-cols-4 xl:grid-cols-8">
          {stages.map((stage) => (
            <div key={stage} className="rounded-xl bg-slate-50 p-3">
              <p className="text-xs text-[#71767b]">{stageLabels[stage]}</p>
              <p className="mt-1 text-xl font-semibold text-[#0f1419]">
                {performance.funnel.current[stage]}
              </p>
            </div>
          ))}
        </div>
        <dl className="mt-5 grid gap-3 sm:grid-cols-2 lg:grid-cols-5">
          {performance.funnel.conversions.map((conversion) => (
            <div
              key={conversion.stage}
              className="rounded-xl border border-[#eef2f7] p-3"
            >
              <dt className="text-xs text-[#71767b]">
                Reached {stageLabels[conversion.stage]}
              </dt>
              <dd className="mt-1 text-lg font-semibold text-[#0f1419]">
                {conversion.reached}{" "}
                <span className="text-sm font-medium text-[#536471]">
                  ({percentage(conversion.rateFromStart)})
                </span>
              </dd>
            </div>
          ))}
        </dl>
      </section>

      <div className="grid gap-5 lg:grid-cols-2">
        <section
          className="rounded-2xl border border-[#e1e8ed] bg-white p-5"
          aria-labelledby="scorecard-title"
        >
          <h2
            id="scorecard-title"
            className="text-lg font-semibold text-[#0f1419]"
          >
            Human scorecards
          </h2>
          {performance.humanScorecards.total === 0 ? (
            <p className="mt-4 rounded-xl bg-slate-50 px-3 py-4 text-sm text-[#536471]">
              No non-revoked human rounds have been logged for this job yet.
            </p>
          ) : (
            <dl className="mt-5 grid grid-cols-3 gap-3">
              <Metric
                label="Complete"
                value={String(performance.humanScorecards.completed)}
              />
              <Metric
                label="Pending"
                value={String(performance.humanScorecards.pending)}
              />
              <Metric
                label="Completion"
                value={percentage(performance.humanScorecards.rate)}
              />
            </dl>
          )}
        </section>

        <section
          className="rounded-2xl border border-[#e1e8ed] bg-white p-5"
          aria-labelledby="score-distribution-title"
        >
          <h2
            id="score-distribution-title"
            className="text-lg font-semibold text-[#0f1419]"
          >
            AI score distribution
          </h2>
          {performance.scoreDistribution.chartEligible ? (
            <div
              className="mt-5 space-y-3"
              aria-label="AI score distribution histogram"
            >
              {performance.scoreDistribution.buckets.map((bucket) => (
                <div
                  key={`${bucket.minimum}-${bucket.maximum}`}
                  className="grid grid-cols-[3.5rem_1fr_2rem] items-center gap-3 text-sm"
                >
                  <span className="text-[#536471]">
                    {bucket.minimum}–{bucket.maximum}
                  </span>
                  <div className="h-2 overflow-hidden rounded-full bg-slate-100">
                    <div
                      className="h-full rounded-full bg-indigo-500"
                      style={{ width: `${(bucket.count / maxBucket) * 100}%` }}
                    />
                  </div>
                  <span className="text-right font-medium text-[#0f1419]">
                    {bucket.count}
                  </span>
                </div>
              ))}
            </div>
          ) : (
            <div className="mt-4 rounded-xl bg-slate-50 px-3 py-4 text-sm text-[#536471]">
              <p>
                A score chart appears after 10 completed AI assessments. Until
                then, this member-only view shows the ranked people for this job
                instead of implying a trend.
              </p>
              {performance.scoreDistribution.fallbackCandidates?.length ? (
                <ol className="mt-4 space-y-2" aria-label="Ranked candidates">
                  {performance.scoreDistribution.fallbackCandidates.map(
                    (candidate) => (
                      <li
                        key={candidate.applicationId}
                        className="grid grid-cols-[2rem_1fr_auto] items-center gap-3 rounded-lg border border-slate-200 bg-white px-3 py-2"
                      >
                        <span className="font-semibold text-indigo-700">
                          #{candidate.rank}
                        </span>
                        <Link
                          href={`/workspace/applications/${encodeURIComponent(candidate.applicationId)}`}
                          className="min-w-0 truncate font-medium text-[#0f1419] hover:text-indigo-700 hover:underline"
                        >
                          {candidate.candidateName}
                        </Link>
                        <span
                          className="font-semibold text-[#0f1419]"
                          aria-label={`${candidate.candidateName} AI score`}
                        >
                          Score {candidate.score}
                        </span>
                      </li>
                    ),
                  )}
                </ol>
              ) : (
                <p className="mt-3">
                  No completed AI assessments are available for this job yet.
                </p>
              )}
            </div>
          )}
        </section>
      </div>

      <section
        className="rounded-2xl border border-indigo-100 bg-indigo-50/50 p-5"
        aria-labelledby="decision-next-title"
      >
        <h2
          id="decision-next-title"
          className="text-base font-semibold text-[#0f1419]"
        >
          Make decisions with evidence
        </h2>
        <p className="mt-1 text-sm text-[#536471]">
          This page uses aggregates once the chart is eligible, with a capped
          same-job list only for small samples. Open the decision workspace to
          review scorecards and evidence.
        </p>
        <div className="mt-4">
          <Link
            href={`/workspace/jobs/${encodeURIComponent(jobId)}/decision`}
            className="inline-flex items-center rounded-lg bg-indigo-600 px-3 py-2 text-sm font-medium text-white hover:bg-indigo-700"
          >
            Open decision workspace
          </Link>
        </div>
      </section>
    </div>
  );
}

function Metric({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-xl bg-slate-50 p-3">
      <dt className="text-xs text-[#71767b]">{label}</dt>
      <dd className="mt-1 text-lg font-semibold text-[#0f1419]">{value}</dd>
    </div>
  );
}
