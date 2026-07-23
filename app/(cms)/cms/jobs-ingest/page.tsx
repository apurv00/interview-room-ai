'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import { SourceOperationDialog } from './SourceOperationDialog'
import { SourcesTable } from './SourcesTable'
import { VerdictMonitor } from './VerdictMonitor'
import { VerdictGovernancePanel } from './VerdictGovernancePanel'
import { EmailOperationsPanel } from './EmailOperationsPanel'
import type {
  ApiFailure,
  FunnelReconciliation,
  JobsOperationsPayload,
  JobsSourceAction,
  ReadinessItem,
  SourceOperationSubmission,
  SourceRow,
} from './types'

interface ActiveDialog {
  source: SourceRow | null
  action: JobsSourceAction
  operationId: string
}

function Stat({ label, value, detail }: { label: string; value: string | number; detail?: string }) {
  return (
    <div className="rounded-xl border border-slate-200 bg-white p-4">
      <div className="text-xs font-medium uppercase tracking-wide text-slate-500">{label}</div>
      <div className="mt-1 text-2xl font-semibold tabular-nums text-slate-950">{value}</div>
      {detail ? <div className="mt-1 text-xs text-slate-500">{detail}</div> : null}
    </div>
  )
}

function ReadinessCard({ item }: { item: ReadinessItem }) {
  const styles = {
    ready: 'border-green-200 bg-green-50 text-green-900',
    warning: 'border-amber-200 bg-amber-50 text-amber-950',
    blocked: 'border-red-200 bg-red-50 text-red-900',
    unknown: 'border-slate-200 bg-slate-50 text-slate-800',
  } as const
  return (
    <div className={`rounded-xl border p-4 ${styles[item.status]}`}>
      <div className="flex items-center justify-between gap-3">
        <span className="font-semibold">{item.label}</span>
        <span className="rounded-full border border-current/20 px-2 py-0.5 text-xs font-semibold uppercase">
          {item.status}
        </span>
      </div>
      <p className="mt-2 text-sm opacity-90">{item.detail}</p>
    </div>
  )
}

function formatDate(value: string): string {
  const date = new Date(value)
  return Number.isNaN(date.getTime()) ? 'Unknown' : date.toLocaleString()
}

function FunnelIntegrityPanel({ report }: { report: FunnelReconciliation }) {
  return (
    <section aria-labelledby="funnel-integrity-heading">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h2 id="funnel-integrity-heading" className="text-xl font-semibold text-slate-950">
            Funnel telemetry integrity
          </h2>
          <p className="mt-1 text-sm text-slate-600">
            Server-owned events compared with their durable application transitions.
          </p>
        </div>
        <span className="text-xs text-slate-500">
          {formatDate(report.windowStart)}–{formatDate(report.windowEnd)}
        </span>
      </div>
      {report.status === 'warning' ? (
        <div role="alert" className="mt-4 rounded-xl border border-amber-300 bg-amber-50 p-4 text-sm text-amber-950">
          <p className="font-semibold">Funnel telemetry does not reconcile.</p>
          <p className="mt-1">
            {(report.mismatchCount ?? 0).toLocaleString()} transition{report.mismatchCount === 1 ? '' : 's'} differ from the telemetry store.
            Inspect producer errors before using these funnel counts.
          </p>
        </div>
      ) : report.status === 'unavailable' ? (
        <div role="alert" className="mt-4 rounded-xl border border-red-300 bg-red-50 p-4 text-sm text-red-900">
          <p className="font-semibold">Funnel telemetry reconciliation is unavailable.</p>
          <p className="mt-1">Application and event counts could not be compared. The source controls remain available; inspect the reconciliation query logs.</p>
        </div>
      ) : null}
      {report.factCount !== null ? (
        <div className="mt-4 overflow-x-auto rounded-xl border border-slate-200 bg-white">
          <table className="w-full min-w-[680px] text-left text-sm">
            <caption className="sr-only">Jobs funnel event and durable transition reconciliation</caption>
            <thead className="bg-slate-50 text-xs uppercase tracking-wide text-slate-600">
              <tr>
                <th scope="col" className="px-4 py-3">Transition</th>
                <th scope="col" className="px-4 py-3">Durable facts</th>
                <th scope="col" className="px-4 py-3">Events</th>
                <th scope="col" className="px-4 py-3">Missing</th>
                <th scope="col" className="px-4 py-3">Extra</th>
                <th scope="col" className="px-4 py-3">State</th>
              </tr>
            </thead>
            <tbody>
              <tr>
                <th scope="row" className="px-4 py-3">
                  <span className="font-medium text-slate-950">Confirmed applications</span>
                  <span className="mt-1 block font-mono text-xs font-normal text-slate-500">{report.eventName}</span>
                </th>
                <td className="px-4 py-3 tabular-nums text-slate-700">{report.factCount.toLocaleString()}</td>
                <td className="px-4 py-3 tabular-nums text-slate-700">{report.eventCount?.toLocaleString()}</td>
                <td className="px-4 py-3 tabular-nums text-slate-700">{report.missingEvents?.toLocaleString()}</td>
                <td className="px-4 py-3 tabular-nums text-slate-700">{report.extraEvents?.toLocaleString()}</td>
                <td className="px-4 py-3">
                  <span className={`rounded-full px-2 py-1 text-xs font-semibold uppercase ${
                    report.status === 'ready'
                      ? 'bg-green-100 text-green-800'
                      : 'bg-amber-100 text-amber-900'
                  }`}>
                    {report.status}
                  </span>
                </td>
              </tr>
            </tbody>
          </table>
        </div>
      ) : null}
      <p className="mt-2 text-xs text-slate-500">
        Window: 24 hours. The newest {report.settlingDelayMinutes} minutes are excluded to avoid alerting on in-flight event writes.
      </p>
    </section>
  )
}

async function readFailure(response: Response): Promise<ApiFailure> {
  try {
    return await response.json() as ApiFailure
  } catch {
    return { error: `Request failed with HTTP ${response.status}` }
  }
}

export default function JobsIngestPage() {
  const [data, setData] = useState<JobsOperationsPayload | null>(null)
  const [loading, setLoading] = useState(true)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [dialog, setDialog] = useState<ActiveDialog | null>(null)
  const [commandError, setCommandError] = useState<string | null>(null)
  const [pageAlert, setPageAlert] = useState<string | null>(null)
  const [statusMessage, setStatusMessage] = useState<string | null>(null)
  const [pendingSourceId, setPendingSourceId] = useState<string | null>(null)
  const [submitting, setSubmitting] = useState(false)
  const returnFocusRef = useRef<HTMLElement | null>(null)

  const load = useCallback(async (signal?: AbortSignal) => {
    setLoadError(null)
    try {
      const response = await fetch('/api/cms/jobs-ingest', { cache: 'no-store', signal })
      if (!response.ok) {
        const failure = await readFailure(response)
        if (response.status === 401) throw new Error('Your admin session expired. Sign in again and reload this page.')
        if (response.status === 403) throw new Error('Your current account no longer has platform-admin access.')
        throw new Error(failure.error || `Failed to load Jobs operations (HTTP ${response.status}).`)
      }
      setData(await response.json() as JobsOperationsPayload)
    } catch (error) {
      if (signal?.aborted) return
      setLoadError(error instanceof Error ? error.message : 'Failed to load Jobs operations.')
    } finally {
      if (!signal?.aborted) setLoading(false)
    }
  }, [])

  useEffect(() => {
    const controller = new AbortController()
    void load(controller.signal)
    return () => controller.abort()
  }, [load])

  function openDialog(source: SourceRow | null, action: JobsSourceAction) {
    returnFocusRef.current = document.activeElement as HTMLElement | null
    setCommandError(null)
    setPageAlert(null)
    setStatusMessage(null)
    setDialog({ source, action, operationId: crypto.randomUUID() })
  }

  function closeDialog() {
    if (submitting) return
    setDialog(null)
    setCommandError(null)
    requestAnimationFrame(() => returnFocusRef.current?.focus())
  }

  async function submitOperation(submission: SourceOperationSubmission) {
    if (!dialog || submitting) return
    const { source, action } = dialog
    const operationId = dialog.operationId
    const isLegal = action === 'revoke' || action === 'restore'
    const endpoint = isLegal
      ? '/api/jobs/admin/source-control'
      : '/api/cms/jobs-ingest/sources'
    const body = isLegal
      ? {
          sourceId: source!.sourceId,
          action,
          expectedRevision: source!.controlRevision,
          reason: submission.reason,
        }
      : action === 'bootstrap'
        ? { action }
        : {
            sourceId: source!.sourceId,
            action,
            expectedControlRevision: source!.controlRevision,
            expectedOperationalRevision: source!.operationalRevision,
            ...(submission.reason ? { reason: submission.reason } : {}),
            ...(submission.settings ? { settings: submission.settings } : {}),
          }

    setSubmitting(true)
    setPendingSourceId(source?.sourceId ?? 'bootstrap')
    setCommandError(null)
    try {
      const response = await fetch(endpoint, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Idempotency-Key': operationId,
        },
        body: JSON.stringify(body),
      })
      if (!response.ok) {
        const failure = await readFailure(response)
        const retryAfter = response.headers.get('Retry-After')
        if (response.status < 500 && response.status !== 429) {
          setDialog((current) => current
            ? { ...current, operationId: crypto.randomUUID() }
            : current)
        }
        if (response.status === 401) throw new Error('Your admin session expired. Sign in again before retrying.')
        if (response.status === 403) throw new Error('Your current role no longer authorizes this command.')
        if (response.status === 409) {
          await load()
          setDialog(null)
          setCommandError(null)
          setPageAlert('The source changed while the command dialog was open. State has been refreshed; review it and open a new command.')
          requestAnimationFrame(() => returnFocusRef.current?.focus())
          return
        }
        if (response.status === 429) {
          throw new Error(`Command rate limit reached.${retryAfter ? ` Retry after ${retryAfter} seconds.` : ''}`)
        }
        throw new Error(failure.error || `Command failed (HTTP ${response.status}).`)
      }

      const payload = await response.json() as { queued?: boolean; result?: { operationId?: string } }
      const queued = action === 'run-now' || action === 'validate' || payload.queued
      setStatusMessage(queued
        ? `${source?.displayName ?? 'Source catalog'} command queued${payload.result?.operationId ? ` as ${payload.result.operationId}` : ''}. Completion will appear in source activity.`
        : `${source?.displayName ?? 'Source catalog'} ${action} command committed.`)
      setPageAlert(null)
      setDialog(null)
      await load()
      requestAnimationFrame(() => returnFocusRef.current?.focus())
    } catch (error) {
      setCommandError(error instanceof Error ? error.message : 'The command could not be completed.')
    } finally {
      setSubmitting(false)
      setPendingSourceId(null)
    }
  }

  if (loading) {
    return (
      <main className="mx-auto max-w-7xl p-8" aria-busy="true">
        <h1 className="text-2xl font-semibold text-slate-950">Jobs Operations</h1>
        <p className="mt-4 text-sm text-slate-600">Loading source authority, budgets, and supply…</p>
      </main>
    )
  }

  if (loadError || !data) {
    return (
      <main className="mx-auto max-w-4xl p-8">
        <h1 className="text-2xl font-semibold text-slate-950">Jobs Operations</h1>
        <div role="alert" className="mt-6 rounded-xl border border-red-300 bg-red-50 p-4 text-red-800">
          {loadError || 'The Jobs operations response was empty.'}
        </div>
        <button
          type="button"
          onClick={() => { setLoading(true); void load() }}
          className="mt-4 rounded-lg bg-blue-700 px-4 py-2 text-sm font-semibold text-white hover:bg-blue-800"
        >
          Retry
        </button>
      </main>
    )
  }

  const retainedOverLimit = data.summary.retainedHeadroom < 0

  return (
    <main className="mx-auto max-w-7xl space-y-8 p-8">
      <header className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <h1 className="text-3xl font-semibold text-slate-950">Jobs Operations</h1>
          <p className="mt-2 max-w-3xl text-sm leading-6 text-slate-600">
            Control reviewed ingestion sources, validate provider readiness, enforce request ceilings, and inspect attributable supply.
          </p>
        </div>
        <button
          type="button"
          onClick={() => void load()}
          className="rounded-lg border border-slate-300 bg-white px-4 py-2 text-sm font-semibold text-slate-700 hover:border-blue-400 hover:text-blue-800"
        >
          Refresh state
        </button>
      </header>

      <div aria-live="polite" aria-atomic="true">
        {statusMessage ? (
          <div role="status" className="rounded-xl border border-green-300 bg-green-50 p-4 text-sm text-green-800">
            {statusMessage}
          </div>
        ) : null}
      </div>
      {pageAlert ? (
        <div role="alert" className="rounded-xl border border-amber-300 bg-amber-50 p-4 text-sm text-amber-950">
          {pageAlert}
        </div>
      ) : null}

      <section aria-labelledby="readiness-heading">
        <h2 id="readiness-heading" className="text-lg font-semibold text-slate-950">Runtime readiness</h2>
        <div className="mt-3 grid gap-4 md:grid-cols-3">
          <ReadinessCard item={data.readiness.database} />
          <ReadinessCard item={data.readiness.dispatch} />
          <ReadinessCard item={data.readiness.sourceControl} />
        </div>
      </section>

      <section aria-labelledby="corpus-heading">
        <h2 id="corpus-heading" className="sr-only">Corpus and supply summary</h2>
        <div className="grid grid-cols-2 gap-4 sm:grid-cols-3 lg:grid-cols-6">
          <Stat label="Open corpus" value={data.summary.open.toLocaleString()} />
          <Stat label="Retained" value={data.summary.retained.toLocaleString()} detail={`Limit ${data.summary.retainedLimit.toLocaleString()}`} />
          <Stat label="Headroom" value={data.summary.retainedHeadroom.toLocaleString()} />
          <Stat label="Active sources" value={data.summary.activeSources} />
          <Stat label="At-risk sources" value={data.summary.atRiskSources} />
          <Stat label="24h supply" value={data.summary.new24h.toLocaleString()} detail={`${data.summary.attempts24h.toLocaleString()} provider attempts`} />
        </div>
        {data.summary.retainedWarning ? (
          <div role="alert" className={`mt-4 rounded-xl border p-4 text-sm ${retainedOverLimit ? 'border-red-300 bg-red-50 text-red-900' : 'border-amber-300 bg-amber-50 text-amber-950'}`}>
            <p className="font-semibold">{retainedOverLimit ? 'Retained corpus is over its proven limit.' : 'Retained corpus is approaching its proven limit.'}</p>
            <p className="mt-1">{retainedOverLimit
              ? 'New source admission and legal transitions can fail closed. Keep ingestion paused while capacity is remediated.'
              : `${data.summary.retainedHeadroom.toLocaleString()} rows remain before the ${data.summary.retainedLimit.toLocaleString()}-row limit.`}</p>
          </div>
        ) : null}
      </section>

      <FunnelIntegrityPanel report={data.funnelReconciliation} />

      {data.bootstrap.required ? (
        <section aria-labelledby="bootstrap-heading" className="rounded-2xl border border-blue-200 bg-blue-50 p-6">
          <h2 id="bootstrap-heading" className="text-xl font-semibold text-blue-950">Initialize the reviewed source catalog</h2>
          <p className="mt-2 max-w-3xl text-sm leading-6 text-blue-900">
            {data.bootstrap.configuredSources === 0
              ? `No source rows are configured. Initialization creates ${data.bootstrap.catalogSources} reviewed sources in a paused state; it does not fetch or publish jobs.`
              : `${data.bootstrap.configuredSources} of ${data.bootstrap.catalogSources} reviewed sources are configured. Initialization applies the listed safe repairs and does not fetch or publish jobs.`}
          </p>
          {data.bootstrap.repairs?.length ? (
            <div className="mt-3 rounded-lg border border-blue-200 bg-white/60 p-3 text-sm text-blue-950">
              <p className="font-semibold">Initialization will:</p>
              <ul className="mt-1 list-disc pl-5">
                {data.bootstrap.repairs.map((repair) => <li key={repair}>{repair}</li>)}
              </ul>
            </div>
          ) : null}
          {data.bootstrap.blockers.length ? (
            <ul className="mt-3 list-disc pl-5 text-sm text-red-800">
              {data.bootstrap.blockers.map((blocker) => <li key={blocker}>{blocker}</li>)}
            </ul>
          ) : null}
          <button
            type="button"
            disabled={!data.bootstrap.allowed || submitting}
            onClick={() => openDialog(null, 'bootstrap')}
            className="mt-4 rounded-lg bg-blue-700 px-4 py-2 text-sm font-semibold text-white hover:bg-blue-800 disabled:cursor-not-allowed disabled:opacity-50"
          >
            Initialize source catalog
          </button>
        </section>
      ) : null}

      <section aria-labelledby="sources-heading">
        <div className="flex flex-wrap items-end justify-between gap-3">
          <div>
            <h2 id="sources-heading" className="text-xl font-semibold text-slate-950">Sources</h2>
            <p className="mt-1 text-sm text-slate-600">Actions are derived from current authority, health, validation, credential, and budget state.</p>
          </div>
          <span className="text-xs text-slate-500">{data.sources.length} configured</span>
        </div>
        <div className="mt-4">
          {data.sources.length ? (
            <SourcesTable sources={data.sources} pendingSourceId={pendingSourceId} onAction={openDialog} />
          ) : (
            <div className="rounded-xl border border-dashed border-slate-300 p-8 text-center text-sm text-slate-600">
              No source rows are configured yet.
            </div>
          )}
        </div>
      </section>

      <section aria-labelledby="audit-heading">
        <h2 id="audit-heading" className="text-xl font-semibold text-slate-950">Recent operator audit</h2>
        <p className="mt-1 text-sm text-slate-600">Legal and operational commands are shown separately from worker completion telemetry.</p>
        <div className="mt-4 overflow-x-auto rounded-xl border border-slate-200 bg-white">
          <table className="w-full min-w-[760px] text-left text-sm">
            <caption className="sr-only">Recent Jobs source operator commands</caption>
            <thead className="bg-slate-50 text-xs uppercase tracking-wide text-slate-600">
              <tr>
                <th scope="col" className="px-4 py-3">When</th>
                <th scope="col" className="px-4 py-3">Source</th>
                <th scope="col" className="px-4 py-3">Action</th>
                <th scope="col" className="px-4 py-3">Actor</th>
                <th scope="col" className="px-4 py-3">Reason</th>
                <th scope="col" className="px-4 py-3">Outcome</th>
                <th scope="col" className="px-4 py-3">Operation</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-200">
              {data.audit.map((row) => (
                <tr key={row.operationId ?? `${row.sourceId}:${row.action}:${row.at}`}>
                  <td className="px-4 py-3 text-slate-600">{formatDate(row.at)}</td>
                  <td className="px-4 py-3 font-mono text-xs text-slate-700">{row.sourceId}</td>
                  <td className="px-4 py-3 font-medium text-slate-950">{row.action}</td>
                  <td className="px-4 py-3 text-slate-600">{row.actorLabel ?? 'Platform admin'}</td>
                  <td className="max-w-xs px-4 py-3 text-slate-600">{row.reason ?? '—'}</td>
                  <td className="px-4 py-3 text-slate-600">{row.outcome ?? 'committed'}</td>
                  <td className="px-4 py-3 font-mono text-xs text-slate-500">{row.operationId ?? '—'}</td>
                </tr>
              ))}
              {!data.audit.length ? (
                <tr><td colSpan={7} className="px-4 py-6 text-center text-slate-500">No operator commands recorded.</td></tr>
              ) : null}
            </tbody>
          </table>
        </div>
      </section>

      <VerdictMonitor verdict={data.verdict} />
      <VerdictGovernancePanel />
      <EmailOperationsPanel />

      {dialog ? (
        <SourceOperationDialog
          action={dialog.action}
          source={dialog.source}
          busy={submitting}
          error={commandError}
          bootstrapRepairs={data.bootstrap.repairs}
          onClose={closeDialog}
          onSubmit={(submission) => void submitOperation(submission)}
        />
      ) : null}
    </main>
  )
}
