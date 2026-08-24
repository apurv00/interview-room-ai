"use client";

import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
import Badge from "@shared/ui/Badge";
import StateView from "@shared/ui/StateView";
import type { HireOperationsWorkspaceOverview } from "@hire-operations/types";
import {
  operationsLabels,
  overviewFrom,
  readOperationsResponse,
} from "../_operations/operationsView";
import DigestPreferenceControl from "./DigestPreferenceControl";

function pluralize(count: number, word: string): string {
  return `${count} ${word}${count === 1 ? "" : "s"}`;
}

function scorecardLabel(view: HireOperationsWorkspaceOverview): string {
  const completion = view.kpis.scorecardCompletion;
  return completion.total === 0
    ? "No human rounds yet"
    : `${completion.completed} of ${completion.total} complete`;
}

function medianCloseLabel(value: number | null): string {
  return value === null ? "No closed jobs yet" : `${value} days`;
}

export default function OverviewWorkspace() {
  const [overview, setOverview] =
    useState<HireOperationsWorkspaceOverview | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setError(null);
    try {
      setOverview(
        await readOperationsResponse(
          "/api/workspace/overview?contractVersion=2",
          overviewFrom,
        ),
      );
    } catch (cause) {
      setError(
        cause instanceof Error
          ? cause.message
          : "Could not load operations data.",
      );
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  if (error) {
    return (
      <StateView state="error" error={error} onRetry={() => void load()} />
    );
  }
  if (!overview) {
    return (
      <StateView state="loading" skeletonLayout="grid" skeletonCount={4} />
    );
  }

  const totalActions = overview.actionInbox.items.reduce(
    (total, item) =>
      item.kind === "interview_validation_attention"
        ? total
        : total + item.count,
    0,
  );
  const actionItems = overview.actionInbox.items.filter(
    (item) => item.count > 0,
  );

  return (
    <div className="space-y-8">
      <header className="flex flex-col gap-4 sm:flex-row sm:items-end sm:justify-between">
        <div>
          <p className="text-sm font-medium text-indigo-700">
            Operations overview
          </p>
          <h1 className="mt-1 text-2xl font-bold tracking-tight text-[#0f1419]">
            What needs attention
          </h1>
          <p className="mt-2 max-w-2xl text-sm text-[#536471]">
            A private, workspace-level view of current hiring work. Candidate
            decisions and evidence stay in their dedicated screens.
          </p>
        </div>
        <div className="flex flex-wrap gap-2">
          <Link
            href="/workspace/jobs/health"
            className="inline-flex items-center rounded-lg border border-[#cbd5e1] bg-white px-3 py-2 text-sm font-medium text-[#0f1419] hover:bg-slate-50"
          >
            Jobs health
          </Link>
          <a
            href="/api/workspace/export/candidates"
            download
            className="inline-flex items-center rounded-lg border border-[#cbd5e1] bg-white px-3 py-2 text-sm font-medium text-[#0f1419] hover:bg-slate-50"
          >
            Download CSV
          </a>
        </div>
      </header>

      <section
        aria-label="Hiring key performance indicators"
        className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4"
      >
        <KpiCard
          label="Open jobs"
          value={String(overview.kpis.openJobs)}
          detail="Active requisitions"
        />
        <KpiCard
          label="Awaiting decision"
          value={String(overview.kpis.candidatesAwaitingDecision)}
          detail="Shortlist and offer stages"
        />
        <KpiCard
          label="Scorecards"
          value={scorecardLabel(overview)}
          detail="Submitted human scorecards"
        />
        <KpiCard
          label="Median time to close"
          value={medianCloseLabel(overview.kpis.medianTimeToCloseDays)}
          detail="Across closed jobs"
        />
      </section>

      <section
        className="rounded-2xl border border-[#e1e8ed] bg-white p-5"
        aria-labelledby="action-inbox-title"
      >
        <div className="flex items-center justify-between gap-4">
          <div>
            <h2
              id="action-inbox-title"
              className="text-lg font-semibold text-[#0f1419]"
            >
              Action inbox
            </h2>
            <p className="mt-1 text-sm text-[#536471]">
              {totalActions === 0
                ? "No operational actions are waiting right now."
                : `${pluralize(totalActions, "operational action")} need review.`}
            </p>
          </div>
          {totalActions > 0 && (
            <Badge variant="caution">{totalActions} open</Badge>
          )}
        </div>

        {actionItems.length === 0 ? (
          <div className="mt-6 rounded-xl bg-slate-50 px-4 py-5 text-sm text-[#536471]">
            Everything is clear. As interviews and decisions progress, grouped
            actions will appear here.
          </div>
        ) : (
          <ul
            className="mt-5 divide-y divide-[#eef2f7]"
            aria-label="Current grouped actions"
          >
            {actionItems.map((item) => (
              <li key={item.kind}>
                <Link
                  href="/workspace/jobs/health"
                  className="group flex flex-col items-start gap-2 py-3 sm:flex-row sm:items-center sm:justify-between sm:gap-4"
                >
                  <span className="text-sm font-medium text-[#0f1419] group-hover:text-indigo-700">
                    {operationsLabels[item.kind]}
                  </span>
                  <span className="flex items-center gap-2">
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
                      {item.count}
                    </Badge>
                    <span className="text-xs font-medium text-indigo-700">
                      Review
                    </span>
                  </span>
                </Link>
              </li>
            ))}
          </ul>
        )}
      </section>

      <section
        className="rounded-2xl border border-indigo-100 bg-indigo-50/50 p-5"
        aria-labelledby="operations-next-title"
      >
        <h2
          id="operations-next-title"
          className="text-base font-semibold text-[#0f1419]"
        >
          Review by job
        </h2>
        <p className="mt-1 text-sm text-[#536471]">
          Jobs health highlights aging pipeline work. Performance is kept per
          job so different score contracts are never compared against each
          other.
        </p>
        <div className="mt-4 flex flex-wrap gap-2">
          <Link
            href="/workspace/jobs/health"
            className="inline-flex items-center rounded-lg bg-indigo-600 px-3 py-2 text-sm font-medium text-white hover:bg-indigo-700"
          >
            Open jobs health
          </Link>
          <Link
            href="/workspace/jobs"
            className="inline-flex items-center rounded-lg border border-[#cbd5e1] bg-white px-3 py-2 text-sm font-medium text-[#0f1419] hover:bg-slate-50"
          >
            Open pipeline board
          </Link>
        </div>
      </section>

      <DigestPreferenceControl />
    </div>
  );
}

function KpiCard({
  label,
  value,
  detail,
}: {
  label: string;
  value: string;
  detail: string;
}) {
  return (
    <div className="rounded-2xl border border-[#e1e8ed] bg-white p-4">
      <p className="text-xs font-medium uppercase tracking-wide text-[#71767b]">
        {label}
      </p>
      <p className="mt-2 text-2xl font-semibold tracking-tight text-[#0f1419]">
        {value}
      </p>
      <p className="mt-1 text-xs text-[#536471]">{detail}</p>
    </div>
  );
}
