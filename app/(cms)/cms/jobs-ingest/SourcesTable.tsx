import type { JobsSourceAction, SourceRow } from './types'

interface SourcesTableProps {
  sources: SourceRow[]
  pendingSourceId: string | null
  onAction: (source: SourceRow, action: JobsSourceAction) => void
}

const ACTION_ORDER: JobsSourceAction[] = [
  'run-now',
  'validate',
  'enable',
  'pause',
  'update-settings',
  'revoke',
  'restore',
]

const ACTION_LABELS: Record<JobsSourceAction, string> = {
  bootstrap: 'Initialize',
  enable: 'Enable',
  pause: 'Pause',
  'update-settings': 'Settings',
  'run-now': 'Run now',
  validate: 'Validate',
  revoke: 'Revoke',
  restore: 'Restore',
}

const STATE_STYLES: Record<SourceRow['state'], string> = {
  active: 'border-green-200 bg-green-50 text-green-800',
  paused: 'border-slate-200 bg-slate-50 text-slate-700',
  validating: 'border-blue-200 bg-blue-50 text-blue-800',
  quarantined: 'border-amber-200 bg-amber-50 text-amber-900',
  dead: 'border-red-200 bg-red-50 text-red-800',
  revoked: 'border-red-300 bg-red-100 text-red-900',
}

const CREDENTIAL_STYLES: Record<SourceRow['credential']['status'], string> = {
  ready: 'text-green-700',
  'not-required': 'text-slate-600',
  missing: 'text-red-700',
  invalid: 'text-red-700',
  unknown: 'text-amber-800',
  'configured-rejected': 'text-amber-800',
}

function formatDate(value: string | null): string {
  if (!value) return 'Never'
  const date = new Date(value)
  return Number.isNaN(date.getTime()) ? 'Unknown' : date.toLocaleString()
}

function percent(numerator: number, denominator: number): string {
  if (denominator <= 0) return '0%'
  return `${Math.round((numerator / denominator) * 100)}%`
}

export function SourcesTable({ sources, pendingSourceId, onAction }: SourcesTableProps) {
  return (
    <div className="overflow-x-auto rounded-xl border border-slate-200 bg-white">
      <table className="w-full min-w-[1180px] text-left text-sm">
        <caption className="sr-only">Configured Jobs ingestion sources and available operator actions</caption>
        <thead className="bg-slate-50 text-xs uppercase tracking-wide text-slate-600">
          <tr>
            <th scope="col" className="px-4 py-3">Source</th>
            <th scope="col" className="px-4 py-3">State</th>
            <th scope="col" className="px-4 py-3">Credential</th>
            <th scope="col" className="px-4 py-3">Supply (24h / 7d)</th>
            <th scope="col" className="px-4 py-3">Quality (7d)</th>
            <th scope="col" className="px-4 py-3">Budget</th>
            <th scope="col" className="px-4 py-3">Last activity</th>
            <th scope="col" className="px-4 py-3">Actions</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-slate-200">
          {sources.map((source) => {
            const blockers = Array.from(new Set(Object.values(source.blockers).flatMap((items) => items ?? [])))
            const visibleActions = ACTION_ORDER.filter((action) => (
              source.allowedActions.includes(action) || (source.blockers[action]?.length ?? 0) > 0
            ))
            const isPending = pendingSourceId === source.sourceId
            return (
              <tr key={source.sourceId} className="align-top">
                <th scope="row" className="px-4 py-4 font-normal">
                  <div className="font-semibold text-slate-950">{source.displayName}</div>
                  <div className="mt-1 font-mono text-xs text-slate-500">{source.sourceId}</div>
                  <div className="mt-1 text-xs text-slate-500">{source.kind}</div>
                  <div className="mt-1 font-mono text-[11px] text-slate-400">
                    authority r{source.controlRevision} · operations r{source.operationalRevision}
                  </div>
                </th>
                <td className="px-4 py-4">
                  <span className={`inline-flex rounded-full border px-2.5 py-1 text-xs font-semibold capitalize ${STATE_STYLES[source.state]}`}>
                    {source.state}
                  </span>
                  <div className="mt-2 text-xs text-slate-600">Health: {source.health}</div>
                  {blockers.length ? (
                    <ul className="mt-2 max-w-48 list-disc space-y-1 pl-4 text-xs text-amber-900">
                      {blockers.slice(0, 2).map((blocker) => <li key={blocker}>{blocker}</li>)}
                    </ul>
                  ) : null}
                </td>
                <td className="px-4 py-4">
                  <div className={`font-medium ${CREDENTIAL_STYLES[source.credential.status]}`}>
                    {source.credential.label}
                  </div>
                  {source.credential.remediation ? (
                    <p className="mt-1 max-w-44 text-xs text-slate-500">{source.credential.remediation}</p>
                  ) : null}
                </td>
                <td className="px-4 py-4 tabular-nums text-slate-700">
                  <div><span className="font-semibold text-slate-950">{source.metrics24h.newCount}</span> / {source.metrics7d.newCount} new</div>
                  <div className="mt-1 text-xs text-slate-500">{source.metrics24h.normalized} / {source.metrics7d.normalized} normalized</div>
                  <div className="mt-1 text-xs text-slate-500">{source.postings.open} open · {source.postings.retained} retained</div>
                </td>
                <td className="px-4 py-4 tabular-nums text-slate-700">
                  <div>Drift {percent(source.metrics7d.driftNulls, source.metrics7d.fetched)}</div>
                  <div className="mt-1">Drops {source.metrics7d.drops}</div>
                  <div className={`mt-1 ${source.metrics7d.storeErrors ? 'font-semibold text-red-700' : 'text-slate-500'}`}>
                    Store errors {source.metrics7d.storeErrors}
                  </div>
                </td>
                <td className="px-4 py-4 tabular-nums">
                  {source.budget.status === 'available' && source.budget.percent != null ? (
                    <>
                      <div className={source.budget.blocked ? 'font-semibold text-red-700' : 'text-slate-700'}>
                        {source.budget.usedToday} / {source.budget.dailyCap} today
                      </div>
                      <progress
                        className="mt-2 h-2 w-32"
                        max={100}
                        value={Math.min(100, Math.max(0, source.budget.percent))}
                        aria-label={`${source.displayName} request budget used`}
                      />
                      <div className="mt-1 text-xs text-slate-500">
                        {source.budget.usedThisMonth} / {source.budget.monthlyCap} this month
                      </div>
                    </>
                  ) : (
                    <div className="font-semibold text-amber-800">
                      Shared meter unavailable
                      <div className="mt-1 text-xs font-normal text-slate-500">Usage is unknown; dispatch is blocked.</div>
                    </div>
                  )}
                </td>
                <td className="px-4 py-4 text-xs text-slate-600">
                  <div>Sync: {formatDate(source.lastSyncAt)}</div>
                  <div className="mt-1">Next: {formatDate(source.nextSyncAt)}</div>
                  <div className="mt-2">
                    Validation: {source.lastValidation
                      ? `${source.lastValidation.status} · ${formatDate(source.lastValidation.at)}`
                      : 'Not run'}
                  </div>
                  {source.lastOperation ? (
                    <div className="mt-1">
                      Last command: {source.lastOperation.action} · {source.lastOperation.outcome ?? 'committed'} ·{' '}
                      {formatDate(source.lastOperation.completedAt ?? source.lastOperation.at)}
                      {source.lastOperation.errorCode ? ` · ${source.lastOperation.errorCode}` : ''}
                    </div>
                  ) : null}
                </td>
                <td className="px-4 py-4">
                  <div className="flex max-w-56 flex-wrap gap-2">
                    {visibleActions.map((action) => {
                      const actionBlockers = source.blockers[action] ?? []
                      const isBlocked = actionBlockers.length > 0 || !source.allowedActions.includes(action)
                      return (
                      <button
                        key={action}
                        type="button"
                        onClick={() => { if (!isBlocked && !isPending) onAction(source, action) }}
                        disabled={isPending}
                        aria-disabled={isBlocked || isPending}
                        aria-label={`${ACTION_LABELS[action]} ${source.displayName} source`}
                        title={actionBlockers.join(' ')}
                        className={`rounded-lg border px-2.5 py-1.5 text-xs font-semibold disabled:cursor-not-allowed disabled:opacity-50 ${
                          isBlocked
                            ? 'cursor-not-allowed border-slate-200 bg-slate-50 text-slate-400'
                            :
                          action === 'revoke'
                            ? 'border-red-300 text-red-700 hover:bg-red-50'
                            : 'border-slate-300 text-slate-700 hover:border-blue-400 hover:bg-blue-50 hover:text-blue-800'
                        }`}
                      >
                        {isPending ? 'Working…' : ACTION_LABELS[action]}
                      </button>
                      )
                    })}
                  </div>
                  {Object.entries(source.blockers).map(([action, reasons]) => reasons?.length ? (
                    <p key={action} className="mt-2 max-w-56 text-xs leading-5 text-slate-500">
                      <span className="font-medium text-slate-700">{ACTION_LABELS[action as JobsSourceAction]} blocked:</span>{' '}
                      {reasons.join(' ')}
                    </p>
                  ) : null)}
                  {!visibleActions.length ? <span className="text-xs text-slate-500">No action available</span> : null}
                </td>
              </tr>
            )
          })}
        </tbody>
      </table>
    </div>
  )
}
