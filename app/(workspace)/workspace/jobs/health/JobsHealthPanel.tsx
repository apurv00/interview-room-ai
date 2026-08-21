"use client";

import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
import Badge from "@shared/ui/Badge";
import StateView from "@shared/ui/StateView";
import type { HireOperationsJobsHealth } from "@hire-operations/types";
import {
  jobsHealthFrom,
  operationsLabels,
  readOperationsResponse,
  stageLabels,
  stages,
} from "../../_operations/operationsView";

const STATUS_VARIANT = {
  open: "success",
  on_hold: "caution",
  closed: "default",
} as const;

function attentionLabel(
  item: HireOperationsJobsHealth["jobs"][number]["attention"][number],
): string {
  if (item.kind === "failed_multimodal_analyses") {
    return `${item.count} interview ${item.count === 1 ? "analysis" : "analyses"} needing retry`;
  }
  if (item.kind === "interview_validation_attention") {
    return `${item.count} interview validation ${item.count === 1 ? "timeline" : "timelines"} available`;
  }
  if (item.kind !== "stuck_in_stage") return operationsLabels[item.kind];
  return `${item.count} in ${stageLabels[item.stage!]} for ${item.oldestAgeDays}+ days`;
}

export default function JobsHealthPanel() {
  const [health, setHealth] = useState<HireOperationsJobsHealth | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setError(null);
    try {
      setHealth(
        await readOperationsResponse(
          "/api/workspace/jobs/health?contractVersion=2",
          jobsHealthFrom,
        ),
      );
    } catch (cause) {
      setError(
        cause instanceof Error ? cause.message : "Could not load jobs health.",
      );
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  if (error)
    return (
      <StateView state="error" error={error} onRetry={() => void load()} />
    );
  if (!health)
    return (
      <StateView state="loading" skeletonLayout="list" skeletonCount={5} />
    );

  return (
    <div className="space-y-7">
      <header className="flex flex-col gap-4 sm:flex-row sm:items-end sm:justify-between">
        <div>
          <p className="text-sm font-medium text-indigo-700">
            Operations overview
          </p>
          <h1 className="mt-1 text-2xl font-bold tracking-tight text-[#0f1419]">
            Jobs health
          </h1>
          <p className="mt-2 max-w-2xl text-sm text-[#536471]">
            Jobs are ordered by workflow attention. Validation timelines are
            shown for review without affecting order; pipeline counts are
            current-stage totals, not cross-job rankings.
          </p>
        </div>
        <Link
          href="/workspace/overview"
          className="inline-flex items-center rounded-lg border border-[#cbd5e1] bg-white px-3 py-2 text-sm font-medium text-[#0f1419] hover:bg-slate-50"
        >
          Back to overview
        </Link>
      </header>

      {health.jobs.length === 0 ? (
        <section className="rounded-2xl border border-[#e1e8ed] bg-white p-6">
          <StateView
            state="empty"
            icon={<span aria-hidden>📋</span>}
            title="No jobs yet"
            description="Create your first job to see pipeline health and operational signals."
          />
          <div className="flex justify-center">
            <Link
              href="/workspace/jobs"
              className="inline-flex items-center rounded-lg bg-indigo-600 px-3 py-2 text-sm font-medium text-white hover:bg-indigo-700"
            >
              Open jobs
            </Link>
          </div>
        </section>
      ) : (
        <div className="space-y-4">
          {health.jobs.map((job) => (
            <article
              key={job.jobId}
              className="rounded-2xl border border-[#e1e8ed] bg-white p-5"
            >
              <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
                <div>
                  <div className="flex flex-wrap items-center gap-2">
                    <h2 className="text-lg font-semibold text-[#0f1419]">
                      {job.title}
                    </h2>
                    <Badge variant={STATUS_VARIANT[job.status]}>
                      {job.status.replace("_", " ")}
                    </Badge>
                    <Badge variant="primary">
                      Department: {job.department.name}
                    </Badge>
                  </div>
                  <p className="mt-1 text-sm text-[#536471]">
                    {job.daysOpen} day{job.daysOpen === 1 ? "" : "s"} open
                  </p>
                </div>
                <div className="flex flex-wrap gap-2">
                  <Link
                    href={`/workspace/jobs/${encodeURIComponent(job.jobId)}/performance`}
                    className="inline-flex items-center rounded-lg border border-indigo-200 bg-indigo-50 px-3 py-2 text-sm font-medium text-indigo-700 hover:bg-indigo-100"
                  >
                    View performance
                  </Link>
                  <Link
                    href={`/workspace/jobs/${encodeURIComponent(job.jobId)}`}
                    className="inline-flex items-center rounded-lg border border-[#cbd5e1] bg-white px-3 py-2 text-sm font-medium text-[#0f1419] hover:bg-slate-50"
                  >
                    Pipeline
                  </Link>
                </div>
              </div>

              <dl className="mt-5 grid grid-cols-2 gap-x-3 gap-y-3 border-t border-[#eef2f7] pt-4 sm:grid-cols-4 xl:grid-cols-8">
                {stages.map((stage) => (
                  <div key={stage}>
                    <dt className="text-xs text-[#71767b]">
                      {stageLabels[stage]}
                    </dt>
                    <dd className="mt-1 text-lg font-semibold text-[#0f1419]">
                      {job.funnel[stage]}
                    </dd>
                  </div>
                ))}
              </dl>

              {job.attention.length === 0 ? (
                <p className="mt-5 rounded-xl bg-slate-50 px-3 py-2 text-sm text-[#536471]">
                  No active attention signals for this job.
                </p>
              ) : (
                <ul
                  className="mt-5 flex flex-wrap gap-2"
                  aria-label={`${job.title} attention signals`}
                >
                  {job.attention.map((item, index) => (
                    <li key={`${item.kind}-${item.stage ?? "all"}-${index}`}>
                      <Badge
                        variant={
                          item.kind === "interview_validation_attention"
                            ? "default"
                            : item.kind === "terminal_human_kit_delivery_failures"
                            || item.kind === "failed_multimodal_analyses"
                            ? "danger"
                            : "caution"
                        }
                      >
                        {attentionLabel(item)}
                      </Badge>
                    </li>
                  ))}
                </ul>
              )}
            </article>
          ))}
        </div>
      )}
    </div>
  );
}
