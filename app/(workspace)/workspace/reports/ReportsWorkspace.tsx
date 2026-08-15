"use client";

import Link from "next/link";
import { useCallback, useEffect, useMemo, useState } from "react";
import Badge from "@shared/ui/Badge";
import Button from "@shared/ui/Button";
import StateView from "@shared/ui/StateView";

const EXPORT_ID = /^[a-f0-9]{24}$/i;
const POLL_INTERVAL_MS = 3_000;

type ReportFormat = "pdf" | "xlsx";
type ReportScope = "workspace" | "job";
type ReportKind = "pipeline_status" | "job_closeout";
type ReportStatus =
  "requested" | "generating" | "ready" | "failed" | "expired" | "cancelled";

interface ReportExportView {
  id: string;
  reportKind: ReportKind;
  format: ReportFormat;
  status: ReportStatus;
  requestedAt: string;
  expiresAt: string;
  readyAt: string | null;
}

interface JobOption {
  id: string;
  title: string;
  status: "open" | "on_hold" | "closed";
}

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function validTimestamp(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length <= 40 &&
    Number.isFinite(new Date(value).getTime())
  );
}

function reportExportFrom(value: unknown): ReportExportView | null {
  const source = record(value);
  if (!source) return null;
  const { id, reportKind, format, status, requestedAt, expiresAt, readyAt } =
    source;
  if (
    typeof id !== "string" ||
    !EXPORT_ID.test(id) ||
    (reportKind !== "pipeline_status" && reportKind !== "job_closeout") ||
    (format !== "pdf" && format !== "xlsx") ||
    ![
      "requested",
      "generating",
      "ready",
      "failed",
      "expired",
      "cancelled",
    ].includes(String(status)) ||
    !validTimestamp(requestedAt) ||
    !validTimestamp(expiresAt) ||
    (readyAt !== null && !validTimestamp(readyAt))
  ) {
    return null;
  }
  return {
    id,
    reportKind,
    format,
    status: status as ReportStatus,
    requestedAt,
    expiresAt,
    readyAt: readyAt as string | null,
  };
}

function reportExportsFrom(value: unknown): ReportExportView[] | null {
  const source = record(value);
  if (
    !source ||
    !Array.isArray(source.reportExports) ||
    source.reportExports.length > 50
  )
    return null;
  const seen = new Set<string>();
  const rows = source.reportExports.map((item) => {
    const reportExport = reportExportFrom(item);
    if (!reportExport || seen.has(reportExport.id)) return null;
    seen.add(reportExport.id);
    return reportExport;
  });
  return rows.some((row) => row === null) ? null : (rows as ReportExportView[]);
}

function jobsFrom(value: unknown): JobOption[] | null {
  const source = record(value);
  if (!source || !Array.isArray(source.jobs) || source.jobs.length > 1_000)
    return null;
  const seen = new Set<string>();
  const jobs = source.jobs.map((item) => {
    const row = record(item);
    if (!row) return null;
    const id = row.id;
    const title = row.title;
    const status = row.status;
    if (
      typeof id !== "string" ||
      !EXPORT_ID.test(id) ||
      typeof title !== "string" ||
      !title.trim() ||
      title.length > 200 ||
      (status !== "open" && status !== "on_hold" && status !== "closed") ||
      seen.has(id)
    ) {
      return null;
    }
    seen.add(id);
    return { id, title: title.trim(), status };
  });
  return jobs.some((job) => job === null) ? null : (jobs as JobOption[]);
}

async function responseJson(
  response: Response,
): Promise<Record<string, unknown> | null> {
  const value: unknown = await response.json().catch(() => null);
  return record(value);
}

function isProcessing(status: ReportStatus): boolean {
  return status === "requested" || status === "generating";
}

function reportStatusPresentation(status: ReportStatus): {
  label: string;
  variant: "default" | "primary" | "success" | "caution";
} {
  switch (status) {
    case "ready":
      return { label: "ready", variant: "success" };
    case "failed":
      return { label: "could not prepare", variant: "caution" };
    case "expired":
      return { label: "expired", variant: "default" };
    case "cancelled":
      return { label: "cancelled", variant: "default" };
    case "generating":
      return { label: "preparing", variant: "primary" };
    default:
      return { label: "queued", variant: "primary" };
  }
}

function dateLabel(value: string): string {
  return new Intl.DateTimeFormat(undefined, {
    dateStyle: "medium",
    timeStyle: "short",
  }).format(new Date(value));
}

function reportKindLabel(kind: ReportKind): string {
  return kind === "pipeline_status" ? "Pipeline status" : "Job closeout";
}

function formatLabel(format: ReportFormat): string {
  return format === "pdf" ? "PDF" : "XLSX";
}

function filenameFor(format: ReportFormat): string {
  return format === "pdf" ? "hire-report.pdf" : "hire-report.xlsx";
}

/**
 * Member report surface. It accepts only opaque lifecycle records from the
 * server and never receives report snapshots, storage URLs, object keys, or
 * worker failure detail. The existing candidate CSV stays a separate,
 * authenticated endpoint and is linked rather than recreated here.
 */
export default function ReportsWorkspace() {
  const [reports, setReports] = useState<ReportExportView[] | null>(null);
  const [jobs, setJobs] = useState<JobOption[] | null>(null);
  const [scope, setScope] = useState<ReportScope>("workspace");
  const [jobId, setJobId] = useState("");
  const [format, setFormat] = useState<ReportFormat>("pdf");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [operationId, setOperationId] = useState<string | null>(null);
  const [lastOperationId, setLastOperationId] = useState<string | null>(null);

  const load = useCallback(async () => {
    setError(null);
    try {
      const [reportsResponse, jobsResponse] = await Promise.all([
        fetch("/api/workspace/reports", { cache: "no-store" }),
        fetch("/api/workspace/reports/job-options", { cache: "no-store" }),
      ]);
      const [reportsBody, jobsBody] = await Promise.all([
        responseJson(reportsResponse),
        responseJson(jobsResponse),
      ]);
      const nextReports = reportExportsFrom(reportsBody);
      const nextJobs = jobsFrom(jobsBody);
      if (
        !reportsResponse.ok ||
        !nextReports ||
        !jobsResponse.ok ||
        !nextJobs
      ) {
        throw new Error("invalid report workspace response");
      }
      setReports(nextReports);
      setJobs(nextJobs);
      setJobId((current) => current || nextJobs[0]?.id || "");
    } catch {
      setError("Could not load reports.");
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const processingIds = useMemo(
    () =>
      (reports ?? [])
        .filter((report) => isProcessing(report.status))
        .map((report) => report.id),
    [reports],
  );
  const processingKey = processingIds.join(",");

  const refreshProcessing = useCallback(async (ids: readonly string[]) => {
    if (ids.length === 0) return;
    try {
      const responses = await Promise.all(
        ids.map(async (id) => {
          const response = await fetch(`/api/workspace/reports/${id}`, {
            cache: "no-store",
          });
          const body = await responseJson(response);
          const reportExport = reportExportFrom(body?.reportExport);
          return response.ok ? reportExport : null;
        }),
      );
      if (responses.some((response) => response === null)) {
        setError("Could not refresh report status.");
        return;
      }
      const nextById = new Map(
        responses.map((reportExport) => [reportExport!.id, reportExport!]),
      );
      setReports(
        (current) =>
          current?.map(
            (reportExport) => nextById.get(reportExport.id) ?? reportExport,
          ) ?? null,
      );
      setError(null);
    } catch {
      setError("Could not refresh report status.");
    }
  }, []);

  useEffect(() => {
    if (!processingKey) return;
    const ids = processingKey.split(",");
    const timer = window.setTimeout(
      () => void refreshProcessing(ids),
      POLL_INTERVAL_MS,
    );
    return () => window.clearTimeout(timer);
  }, [processingKey, refreshProcessing]);

  const canRequest =
    reports !== null &&
    jobs !== null &&
    !busy &&
    (scope === "workspace" || Boolean(jobId));

  async function requestPipelineReport() {
    if (!canRequest) return;
    const commandId = operationId ?? crypto.randomUUID();
    setOperationId(commandId);
    setLastOperationId(commandId);
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      const response = await fetch("/api/workspace/reports", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        cache: "no-store",
        body: JSON.stringify({
          scope,
          ...(scope === "job" ? { jobId } : {}),
          format,
          operationId: commandId,
        }),
      });
      const body = await responseJson(response);
      const reportExport = reportExportFrom(body?.reportExport);
      if (!response.ok || !reportExport) {
        setError("Could not request the report.");
        return;
      }
      setReports((current) => {
        const existing = current ?? [];
        return [
          reportExport,
          ...existing.filter((item) => item.id !== reportExport.id),
        ];
      });
      setOperationId(null);
      setNotice(
        reportExport.status === "ready"
          ? "The report is ready to download."
          : "Report requested. This page checks its status automatically.",
      );
    } catch {
      setError("Could not request the report.");
    } finally {
      setBusy(false);
    }
  }

  async function downloadReport(reportExport: ReportExportView) {
    if (reportExport.status !== "ready" || busy) return;
    setBusy(true);
    setError(null);
    try {
      const response = await fetch(
        `/api/workspace/reports/${reportExport.id}/download`,
        { cache: "no-store" },
      );
      if (!response.ok) {
        setError("This report is no longer available to download.");
        return;
      }
      const blob = await response.blob();
      const objectUrl = URL.createObjectURL(blob);
      const anchor = document.createElement("a");
      anchor.href = objectUrl;
      anchor.download = filenameFor(reportExport.format);
      anchor.style.display = "none";
      document.body.appendChild(anchor);
      anchor.click();
      anchor.remove();
      URL.revokeObjectURL(objectUrl);
      setNotice("Report downloaded.");
    } catch {
      setError("This report is no longer available to download.");
    } finally {
      setBusy(false);
    }
  }

  async function copyOperationId() {
    if (!lastOperationId) return;
    try {
      await navigator.clipboard.writeText(lastOperationId);
      setNotice("Operation ID copied.");
    } catch {
      setError("Could not copy the operation ID.");
    }
  }

  if (error && reports === null) {
    return (
      <StateView state="error" error={error} onRetry={() => void load()} />
    );
  }
  if (reports === null || jobs === null) {
    return (
      <StateView state="loading" skeletonLayout="list" skeletonCount={5} />
    );
  }

  return (
    <div className="space-y-7">
      <header className="flex flex-col gap-4 sm:flex-row sm:items-end sm:justify-between">
        <div>
          <p className="text-sm font-medium text-indigo-700">
            Internal reporting
          </p>
          <h1 className="mt-1 text-2xl font-bold tracking-tight text-[#0f1419]">
            Reports
          </h1>
          <p className="mt-2 max-w-2xl text-sm text-[#536471]">
            Generate a private aggregate pipeline report. Evidence sources
            remain separate; the report has no candidate ranking, composite
            score, or hiring recommendation.
          </p>
        </div>
        <Link
          href="/api/workspace/export/candidates"
          className="inline-flex items-center rounded-lg border border-[#cbd5e1] bg-white px-3 py-2 text-sm font-medium text-[#0f1419] hover:bg-slate-50"
        >
          Download candidate CSV
        </Link>
      </header>

      <section
        className="rounded-2xl border border-[#e1e8ed] bg-white p-5"
        aria-labelledby="request-report-heading"
      >
        <div>
          <h2
            id="request-report-heading"
            className="text-lg font-semibold text-[#0f1419]"
          >
            Pipeline status report
          </h2>
          <p className="mt-1 text-sm text-[#536471]">
            PDF and XLSX are available for workspace and job scopes. Job
            closeout reports remain PDF-only and are created by the close
            workflow, not this page.
          </p>
        </div>

        <div className="mt-5 grid gap-4 md:grid-cols-3">
          <div className="space-y-1.5">
            <label
              htmlFor="hire-report-scope"
              className="block text-sm font-medium text-[#0f1419]"
            >
              Scope
            </label>
            <select
              id="hire-report-scope"
              value={scope}
              onChange={(event) => setScope(event.target.value as ReportScope)}
              className="w-full rounded-xl border border-[#e1e8ed] bg-[#f8fafc] px-3 py-2 text-sm"
            >
              <option value="workspace">Entire workspace</option>
              <option value="job">One job</option>
            </select>
          </div>

          {scope === "job" ? (
            <div className="space-y-1.5">
              <label
                htmlFor="hire-report-job"
                className="block text-sm font-medium text-[#0f1419]"
              >
                Job
              </label>
              <select
                id="hire-report-job"
                value={jobId}
                onChange={(event) => setJobId(event.target.value)}
                className="w-full rounded-xl border border-[#e1e8ed] bg-[#f8fafc] px-3 py-2 text-sm"
              >
                {jobs.length === 0 ? (
                  <option value="">No jobs available</option>
                ) : null}
                {jobs.map((job) => (
                  <option key={job.id} value={job.id}>
                    {job.title} ({job.status.replace("_", " ")})
                  </option>
                ))}
              </select>
            </div>
          ) : (
            <div aria-hidden className="hidden md:block" />
          )}

          <div className="space-y-1.5">
            <label
              htmlFor="hire-report-format"
              className="block text-sm font-medium text-[#0f1419]"
            >
              Format
            </label>
            <select
              id="hire-report-format"
              value={format}
              onChange={(event) =>
                setFormat(event.target.value as ReportFormat)
              }
              className="w-full rounded-xl border border-[#e1e8ed] bg-[#f8fafc] px-3 py-2 text-sm"
            >
              <option value="pdf">PDF</option>
              <option value="xlsx">XLSX</option>
            </select>
          </div>
        </div>

        {scope === "job" && jobs.length === 0 ? (
          <p className="mt-3 text-sm text-[#71767b]">
            Create a job before requesting a job-scoped report.
          </p>
        ) : null}
        {error ? (
          <p className="mt-4 text-sm text-[#f4212e]" role="alert">
            {error}
          </p>
        ) : null}
        {notice ? (
          <p className="mt-4 text-sm text-emerald-700" role="status">
            {notice}
          </p>
        ) : null}

        <div className="mt-5 flex flex-wrap items-center gap-2">
          <Button
            onClick={() => void requestPipelineReport()}
            disabled={!canRequest}
          >
            {busy ? "Requesting…" : `Create pipeline ${formatLabel(format)}`}
          </Button>
          {lastOperationId ? (
            <Button
              type="button"
              variant="secondary"
              onClick={() => void copyOperationId()}
              disabled={busy}
            >
              Copy operation ID
            </Button>
          ) : null}
        </div>
        {lastOperationId ? (
          <p
            className="mt-3 font-mono text-xs text-[#71767b]"
            aria-label="Latest operation ID"
          >
            {lastOperationId}
          </p>
        ) : null}
      </section>

      <section
        className="rounded-2xl border border-[#e1e8ed] bg-white"
        aria-labelledby="report-history-heading"
      >
        <div className="border-b border-[#eef2f7] px-5 py-4">
          <h2
            id="report-history-heading"
            className="text-lg font-semibold text-[#0f1419]"
          >
            Report history
          </h2>
          <p className="mt-1 text-sm text-[#536471]">
            The most recent 50 lifecycle records for this workspace.
          </p>
        </div>
        {reports.length === 0 ? (
          <StateView
            state="empty"
            icon={<span aria-hidden>▤</span>}
            title="No reports yet"
            description="Request a pipeline status report to track its private export lifecycle here."
          />
        ) : (
          <ol
            className="divide-y divide-[#eef2f7]"
            aria-label="Report lifecycle records"
          >
            {reports.map((reportExport) => {
              const presentation = reportStatusPresentation(
                reportExport.status,
              );
              return (
                <li
                  key={reportExport.id}
                  className="flex flex-col gap-3 px-5 py-4 sm:flex-row sm:items-center sm:justify-between"
                >
                  <div>
                    <p className="font-medium text-[#0f1419]">
                      {reportKindLabel(reportExport.reportKind)} ·{" "}
                      {formatLabel(reportExport.format)}
                    </p>
                    <p className="mt-1 text-sm text-[#536471]">
                      Requested {dateLabel(reportExport.requestedAt)} · Expires{" "}
                      {dateLabel(reportExport.expiresAt)}
                    </p>
                    {isProcessing(reportExport.status) ? (
                      <p
                        className="mt-1 text-xs text-[#71767b]"
                        aria-live="polite"
                      >
                        Preparing privately; status refreshes automatically.
                      </p>
                    ) : null}
                    {reportExport.status === "failed" ? (
                      <p className="mt-1 text-xs text-[#71767b]">
                        The report could not be prepared. Create a new report to
                        try again.
                      </p>
                    ) : null}
                  </div>
                  <div className="flex items-center gap-2">
                    <Badge variant={presentation.variant}>
                      {presentation.label}
                    </Badge>
                    {reportExport.status === "ready" ? (
                      <Button
                        size="sm"
                        disabled={busy}
                        onClick={() => void downloadReport(reportExport)}
                      >
                        {busy
                          ? "Downloading…"
                          : `Download ${formatLabel(reportExport.format)}`}
                      </Button>
                    ) : null}
                  </div>
                </li>
              );
            })}
          </ol>
        )}
      </section>
    </div>
  );
}

export const __hireReportsWorkspace = {
  reportExportFrom,
  reportExportsFrom,
  jobsFrom,
};
