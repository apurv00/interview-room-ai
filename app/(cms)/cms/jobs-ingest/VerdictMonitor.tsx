import type { JobsOperationsPayload } from './types'

interface VerdictMonitorProps {
  verdict: JobsOperationsPayload['verdict']
}

function Metric({ label, value }: { label: string; value: string | number }) {
  return (
    <div className="rounded-xl border border-slate-200 bg-slate-50 p-3">
      <div className="text-xs font-medium uppercase tracking-wide text-slate-500">{label}</div>
      <div className="mt-1 text-xl font-semibold tabular-nums text-slate-950">{value}</div>
    </div>
  )
}

function joinedCounts(counts: Record<string, number> | undefined): string {
  if (!counts || !Object.keys(counts).length) return '—'
  return Object.entries(counts).map(([key, value]) => `${key}: ${value}`).join(' · ')
}

export function VerdictMonitor({ verdict }: VerdictMonitorProps) {
  return (
    <section aria-labelledby="verdict-heading" className="rounded-2xl border border-slate-200 bg-white p-6">
      <h2 id="verdict-heading" className="text-xl font-semibold text-slate-950">LLM verdict monitor</h2>
      <p className="mt-1 text-sm text-slate-600">Monitoring only. Source lifecycle commands do not bypass verdict budgets or rollout gates.</p>
      <div className="mt-4 grid grid-cols-2 gap-4 sm:grid-cols-4">
        <Metric label="Collection" value={verdict.config.collectionEnabled ? 'On' : 'Off'} />
        <Metric label="Enforcement" value={verdict.config.enforceEnabled ? 'On' : 'Off'} />
        <Metric label="Pending" value={verdict.backlogPending.toLocaleString()} />
        <Metric label="Restricted" value={verdict.tombstones.toLocaleString()} />
      </div>
      <div className="mt-4 grid grid-cols-3 gap-4">
        <Metric label="Genuine" value={(verdict.distribution.genuine ?? 0).toLocaleString()} />
        <Metric label="Suspicious" value={(verdict.distribution.suspicious ?? 0).toLocaleString()} />
        <Metric label="Fraud" value={(verdict.distribution.fraud ?? 0).toLocaleString()} />
      </div>

      <h3 className="mt-6 text-base font-semibold text-slate-950">Recent verdict cycles</h3>
      <div className="mt-3 overflow-x-auto rounded-xl border border-slate-200">
        <table className="w-full min-w-[1280px] text-left text-sm">
          <caption className="sr-only">Recent LLM verdict collection and enforcement telemetry</caption>
          <thead className="bg-slate-50 text-xs uppercase tracking-wide text-slate-600">
            <tr>
              <th scope="col" className="px-3 py-3">Started</th>
              <th scope="col" className="px-3 py-3">Requested</th>
              <th scope="col" className="px-3 py-3">Scored</th>
              <th scope="col" className="px-3 py-3">Cache</th>
              <th scope="col" className="px-3 py-3">Errors</th>
              <th scope="col" className="px-3 py-3">Timeouts</th>
              <th scope="col" className="px-3 py-3">Soft-closed</th>
              <th scope="col" className="px-3 py-3">Disagree ↑/↓</th>
              <th scope="col" className="px-3 py-3">Cost</th>
              <th scope="col" className="px-3 py-3">Skips</th>
              <th scope="col" className="px-3 py-3">Health changes</th>
              <th scope="col" className="px-3 py-3">Epoch</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-200">
            {verdict.cycles.map((cycle, index) => (
              <tr key={`${cycle.startedAt}:${cycle.llm?.epoch ?? index}`} className="align-top">
                <td className="px-3 py-3 text-slate-600">{new Date(cycle.startedAt).toLocaleString()}</td>
                <td className="px-3 py-3 tabular-nums">{cycle.llm?.requested ?? 0}</td>
                <td className="px-3 py-3 tabular-nums">{cycle.llm?.scored ?? 0}</td>
                <td className="px-3 py-3 tabular-nums">{cycle.llm?.cacheHits ?? 0}</td>
                <td className={`px-3 py-3 tabular-nums ${(cycle.llm?.errors ?? 0) > 0 ? 'font-semibold text-red-700' : ''}`}>
                  {cycle.llm?.errors ?? 0}
                </td>
                <td className="px-3 py-3 tabular-nums">{cycle.llm?.timeouts ?? 0}</td>
                <td className="px-3 py-3 tabular-nums">{cycle.llm?.softClosed ?? 0}</td>
                <td className="px-3 py-3 tabular-nums">{cycle.llm ? `${cycle.llm.llmFlaggedCleanRow}/${cycle.llm.llmClearedFlaggedRow}` : '—'}</td>
                <td className="px-3 py-3 tabular-nums">${(cycle.llm?.costUsd ?? 0).toFixed(3)}</td>
                <td className="max-w-72 px-3 py-3 text-xs text-slate-600">{joinedCounts(cycle.llm?.skips)}</td>
                <td className="max-w-72 px-3 py-3 text-xs text-slate-600">{cycle.healthTransitions.join(' · ') || '—'}</td>
                <td className="px-3 py-3 font-mono text-xs text-slate-600">{cycle.llm?.epoch ?? '—'}</td>
              </tr>
            ))}
            {!verdict.cycles.length ? (
              <tr>
                <td colSpan={12} className="px-3 py-6 text-center text-slate-500">
                  No verdict cycles yet — collection is {verdict.config.collectionEnabled ? 'on' : 'off'}.
                </td>
              </tr>
            ) : null}
          </tbody>
        </table>
      </div>
    </section>
  )
}
