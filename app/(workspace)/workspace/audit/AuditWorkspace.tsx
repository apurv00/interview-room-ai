"use client";

import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
import StateView from "@shared/ui/StateView";
import type {
  HireOperationsAuditItem,
  HireOperationsAuditPage,
} from "@hire-operations/types";
import {
  auditLabels,
  auditPageFrom,
  readOperationsResponse,
} from "../_operations/operationsView";

const AUDIT_PAGE_SIZE = 25;

function auditUrl(cursor?: string): string {
  const params = new URLSearchParams({ limit: String(AUDIT_PAGE_SIZE) });
  if (cursor) params.set("cursor", cursor);
  return `/api/workspace/audit?${params.toString()}`;
}

function dateLabel(value: string): string {
  return new Intl.DateTimeFormat(undefined, {
    dateStyle: "medium",
    timeStyle: "short",
  }).format(new Date(value));
}

function targetLabel(item: HireOperationsAuditItem): string {
  if (item.target.kind === "status_link") return "Candidate status link";
  if (item.target.kind === "digest_outbox") return "Daily summary delivery";
  if (item.target.kind === "onboarding_test_drive") {
    return "Practice interview";
  }
  return item.target.kind[0].toUpperCase() + item.target.kind.slice(1);
}

function auditItemKey(item: HireOperationsAuditItem): string {
  return [
    item.kind,
    item.occurredAt,
    item.actor.kind,
    item.actor.name,
    item.target.kind,
    item.target.id,
  ].join("\u0000");
}

function Target({ item }: { item: HireOperationsAuditItem }) {
  if (item.target.kind === "job") {
    return (
      <Link
        href={`/workspace/jobs/${encodeURIComponent(item.target.id)}`}
        className="text-sm font-medium text-indigo-700 hover:underline"
      >
        View job
      </Link>
    );
  }
  if (item.target.kind === "application") {
    return (
      <Link
        href={`/workspace/applications/${encodeURIComponent(item.target.id)}`}
        className="text-sm font-medium text-indigo-700 hover:underline"
      >
        View application
      </Link>
    );
  }
  return <span className="text-sm text-[#536471]">{targetLabel(item)}</span>;
}

export default function AuditWorkspace() {
  const [items, setItems] = useState<HireOperationsAuditItem[] | null>(null);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loadingMore, setLoadingMore] = useState(false);

  const loadInitial = useCallback(async () => {
    setError(null);
    try {
      const page = await readOperationsResponse<HireOperationsAuditPage>(
        auditUrl(),
        auditPageFrom,
      );
      setItems(page.items);
      setNextCursor(page.nextCursor);
    } catch (cause) {
      setError(
        cause instanceof Error
          ? cause.message
          : "Could not load the audit trail.",
      );
    }
  }, []);

  const loadMore = useCallback(async () => {
    if (!nextCursor || loadingMore) return;
    setError(null);
    setLoadingMore(true);
    try {
      const page = await readOperationsResponse<HireOperationsAuditPage>(
        auditUrl(nextCursor),
        auditPageFrom,
      );
      setItems((current) => {
        const seen = new Set((current ?? []).map(auditItemKey));
        return [
          ...(current ?? []),
          ...page.items.filter((item) => {
            const key = auditItemKey(item);
            if (seen.has(key)) return false;
            seen.add(key);
            return true;
          }),
        ];
      });
      setNextCursor(page.nextCursor);
    } catch (cause) {
      setError(
        cause instanceof Error
          ? cause.message
          : "Could not load more audit events.",
      );
    } finally {
      setLoadingMore(false);
    }
  }, [loadingMore, nextCursor]);

  useEffect(() => {
    void loadInitial();
  }, [loadInitial]);

  if (error && items === null) {
    return (
      <StateView
        state="error"
        error={error}
        onRetry={() => void loadInitial()}
      />
    );
  }
  if (items === null)
    return (
      <StateView state="loading" skeletonLayout="list" skeletonCount={6} />
    );

  return (
    <div className="space-y-7">
      <header className="flex flex-col gap-4 sm:flex-row sm:items-end sm:justify-between">
        <div>
          <p className="text-sm font-medium text-indigo-700">
            Operations overview
          </p>
          <h1 className="mt-1 text-2xl font-bold tracking-tight text-[#0f1419]">
            Audit trail
          </h1>
          <p className="mt-2 max-w-2xl text-sm text-[#536471]">
            A read-only history of safe hiring operations. Candidate
            information, notes, evidence, and capability details are
            intentionally excluded.
          </p>
        </div>
        <Link
          href="/workspace/overview"
          className="inline-flex items-center rounded-lg border border-[#cbd5e1] bg-white px-3 py-2 text-sm font-medium text-[#0f1419] hover:bg-slate-50"
        >
          Back to overview
        </Link>
      </header>

      {items.length === 0 ? (
        <section className="rounded-2xl border border-[#e1e8ed] bg-white p-6">
          <StateView
            state="empty"
            icon={<span aria-hidden>◷</span>}
            title="No audit events yet"
            description="Safe operational history appears here as hiring work is recorded."
          />
        </section>
      ) : (
        <section
          className="rounded-2xl border border-[#e1e8ed] bg-white"
          aria-labelledby="audit-events-title"
        >
          <div className="border-b border-[#eef2f7] px-5 py-4">
            <h2
              id="audit-events-title"
              className="text-lg font-semibold text-[#0f1419]"
            >
              Recent activity
            </h2>
          </div>
          <ol className="divide-y divide-[#eef2f7]" aria-label="Audit events">
            {items.map((item, index) => (
              <li
                key={`${auditItemKey(item)}:${index}`}
                className="flex flex-col gap-2 px-5 py-4 sm:flex-row sm:items-center sm:justify-between"
              >
                <div>
                  <p className="font-medium text-[#0f1419]">
                    {auditLabels[item.kind]}
                  </p>
                  <p className="mt-1 text-sm text-[#536471]">
                    {item.actor.name} · {dateLabel(item.occurredAt)}
                  </p>
                </div>
                <Target item={item} />
              </li>
            ))}
          </ol>
        </section>
      )}

      {error ? (
        <StateView
          state="error"
          error={error}
          onRetry={() => void loadMore()}
        />
      ) : null}

      {nextCursor ? (
        <div className="flex justify-center">
          <button
            type="button"
            onClick={() => void loadMore()}
            disabled={loadingMore}
            className="rounded-lg border border-[#cbd5e1] bg-white px-4 py-2 text-sm font-medium text-[#0f1419] hover:bg-slate-50 disabled:cursor-not-allowed disabled:opacity-60"
          >
            {loadingMore ? "Loading…" : "Load more"}
          </button>
        </div>
      ) : null}
    </div>
  );
}
