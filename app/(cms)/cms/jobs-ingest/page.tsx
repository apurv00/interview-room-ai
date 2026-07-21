'use client'

import { useEffect, useState } from 'react'

// Keep it lightweight; this is an internal tool (score-telemetry precedent).

interface SourceRow {
  sourceId: string
  kind: string
  enabled: boolean
  health: string
  controlRevision: number
  lastControl: {
    revision: number
    action: 'revoke' | 'restore'
    at: string
  } | null
  cadenceMinutes: number
  lastSyncAt: string | null
}
interface CycleRow {
  sourceId?: string
  startedAt: string
  finishedAt: string | null
  fetched: number
  normalized: number
  driftNulls: number
  newCount: number
  merged: number
  refreshed: number
  storeErrors: number
  quotaSpent: number
  drops: Record<string, number>
  healthTransitions: string[]
}
interface VerdictLlmBlock {
  requested: number
  scored: number
  cacheHits: number
  errors: number
  timeouts: number
  softClosed: number
  verdictDistribution: { genuine: number; suspicious: number; fraud: number }
  reasonCodeCounts: Record<string, number>
  llmFlaggedCleanRow: number
  llmClearedFlaggedRow: number
  costUsd: number
  epoch: string
  /** Why rows didn't score (Codex #545) — absent on pre-deploy rows. */
  skips?: Record<string, number>
}
interface VerdictPanel {
  config: {
    collectionEnabled: boolean
    enforceEnabled: boolean
    dailyVerdictCap: number
    dailyBudgetUsd: number
    monthlyBudgetUsd: number
  }
  backlogPending: number
  tombstones: number
  distribution: Record<string, number>
  cycles: Array<{ startedAt: string; finishedAt: string | null; llm: VerdictLlmBlock | null; healthTransitions: string[] }>
}
interface Payload {
  sources: SourceRow[]
  cycles: CycleRow[]
  corpus: {
    open: number
    closed: number
    retained: number
    retainedWarningAt: number
    retainedLimit: number
    retainedHeadroom: number
    retainedWarning: boolean
  }
  verdict: VerdictPanel
}

function Stat({ label, value }: { label: string; value: string | number }) {
  return (
    <div className="rounded-lg border p-4">
      <div className="text-xs uppercase tracking-wide text-gray-500">{label}</div>
      <div className="mt-1 text-2xl font-semibold">{value}</div>
    </div>
  )
}

export default function JobsIngestPage() {
  const [data, setData] = useState<Payload | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    fetch('/api/cms/jobs-ingest')
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error(`HTTP ${r.status}`))))
      .then(setData)
      .catch((e) => setError(String(e)))
  }, [])

  if (error) return <main className="p-8 text-red-600">Failed to load: {error}</main>
  if (!data) return <main className="p-8 text-gray-500">Loading…</main>

  const retainedOverLimit = data.corpus.retainedHeadroom < 0

  return (
    <main className="mx-auto max-w-5xl p-8">
      <h1 className="text-2xl font-semibold">Jobs Ingest</h1>

      <div className="mt-6 grid grid-cols-2 gap-4 sm:grid-cols-3 lg:grid-cols-6">
        <Stat label="Open corpus" value={data.corpus.open} />
        <Stat label="Closed" value={data.corpus.closed} />
        <Stat
          label={`Retained / ${data.corpus.retainedLimit.toLocaleString()}`}
          value={data.corpus.retained.toLocaleString()}
        />
        <Stat
          label={retainedOverLimit ? 'Over limit' : 'Headroom'}
          value={Math.abs(data.corpus.retainedHeadroom).toLocaleString()}
        />
        <Stat label="Sources" value={data.sources.length} />
        <Stat label="Cycles (recent)" value={data.cycles.length} />
      </div>

      {data.corpus.retainedWarning ? (
        <div
          role="alert"
          className={`mt-4 rounded-lg border p-4 text-sm ${
            retainedOverLimit
              ? 'border-red-300 bg-red-50 text-red-800'
              : 'border-amber-300 bg-amber-50 text-amber-900'
          }`}
        >
          <p className="font-medium">
            {retainedOverLimit
              ? 'Retained corpus exceeds the smoke-proven source-control limit.'
              : 'Retained corpus has reached the source-control warning threshold.'}
          </p>
          <p className="mt-1">
            {retainedOverLimit
              ? `${Math.abs(data.corpus.retainedHeadroom).toLocaleString()} rows are over the ${data.corpus.retainedLimit.toLocaleString()}-row deployment invariant. Pause ingestion and remediate the retained corpus before retrying source revocation.`
              : `${data.corpus.retainedHeadroom.toLocaleString()} rows of headroom remain before the ${data.corpus.retainedLimit.toLocaleString()}-row limit (warning at ${data.corpus.retainedWarningAt.toLocaleString()}). Review retention and capacity before headroom reaches zero.`}
          </p>
        </div>
      ) : null}

      <h2 className="mt-10 text-lg font-medium">Sources</h2>
      <div className="mt-3 overflow-x-auto">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b text-left text-gray-500">
              <th className="py-2 pr-4">Source</th><th className="pr-4">Kind</th><th className="pr-4">Enabled</th>
              <th className="pr-4">Health</th><th className="pr-4">Authority</th>
              <th className="pr-4">Last legal action</th><th className="pr-4">Cadence</th><th>Last sync</th>
            </tr>
          </thead>
          <tbody>
            {data.sources.map((s) => (
              <tr key={s.sourceId} className="border-b">
                <td className="py-2 pr-4 font-medium">{s.sourceId}</td>
                <td className="pr-4">{s.kind}</td>
                <td className="pr-4">{s.enabled ? '✅' : '—'}</td>
                <td className="pr-4">{s.health}</td>
                <td className="pr-4 font-mono">r{s.controlRevision}</td>
                <td className="pr-4">
                  {s.lastControl
                    ? `${s.lastControl.action} r${s.lastControl.revision} · ${new Date(s.lastControl.at).toLocaleString()}`
                    : 'none'}
                </td>
                <td className="pr-4">{s.cadenceMinutes}m</td>
                <td>{s.lastSyncAt ? new Date(s.lastSyncAt).toLocaleString() : 'never'}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <h2 className="mt-10 text-lg font-medium">Recent sync cycles</h2>
      <div className="mt-3 overflow-x-auto">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b text-left text-gray-500">
              <th className="py-2 pr-4">Started</th><th className="pr-4">Source</th><th className="pr-4">Fetched</th>
              <th className="pr-4">Drift</th><th className="pr-4">New</th><th className="pr-4">Merged</th>
              <th className="pr-4">Refreshed</th><th className="pr-4">Store err</th><th className="pr-4">Quota</th><th className="pr-4">Drops</th><th>Health Δ</th>
            </tr>
          </thead>
          <tbody>
            {data.cycles.map((c, i) => (
              <tr key={i} className="border-b align-top">
                <td className="py-2 pr-4">{new Date(c.startedAt).toLocaleString()}</td>
                <td className="pr-4">{c.sourceId ?? '—'}</td>
                <td className="pr-4">{c.fetched}</td>
                <td className="pr-4">{c.driftNulls}</td>
                <td className="pr-4">{c.newCount}</td>
                <td className="pr-4">{c.merged}</td>
                <td className="pr-4">{c.refreshed}</td>
                <td className="pr-4">{c.storeErrors > 0 ? `⚠ ${c.storeErrors}` : '0'}</td>
                <td className="pr-4">{c.quotaSpent}</td>
                <td className="pr-4">
                  {Object.entries(c.drops).map(([k, v]) => `${k}:${v}`).join(' ') || '—'}
                </td>
                <td>{c.healthTransitions.join(', ') || '—'}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <h2 className="mt-10 text-lg font-medium">LLM verdicts (§4.5 — shadow first)</h2>
      <p className="mt-1 text-sm text-gray-500">
        Switches are DB config (PATCH /api/cms/jobs-ingest), never env flags. Kick a sweep:
        POST /api/jobs/admin/sync {'{"mode":"verdict-sweep"}'}.
      </p>
      <div className="mt-3 grid grid-cols-2 gap-4 sm:grid-cols-4">
        <Stat label="Collection" value={data.verdict.config.collectionEnabled ? 'ON' : 'OFF'} />
        <Stat label="Enforcement" value={data.verdict.config.enforceEnabled ? 'ON' : 'OFF'} />
        <Stat label="Pending backlog" value={data.verdict.backlogPending} />
        <Stat label="Scam tombstones" value={data.verdict.tombstones} />
      </div>
      <div className="mt-4 grid grid-cols-3 gap-4">
        <Stat label="Genuine" value={data.verdict.distribution.genuine ?? 0} />
        <Stat label="Suspicious" value={data.verdict.distribution.suspicious ?? 0} />
        <Stat label="Fraud" value={data.verdict.distribution.fraud ?? 0} />
      </div>

      <h2 className="mt-10 text-lg font-medium">Recent verdict cycles</h2>
      <div className="mt-3 overflow-x-auto">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b text-left text-gray-500">
              <th className="py-2 pr-4">Started</th><th className="pr-4">Requested</th><th className="pr-4">Scored</th>
              <th className="pr-4">Cache</th><th className="pr-4">Err</th><th className="pr-4">Timeout</th>
              <th className="pr-4">Soft-closed</th><th className="pr-4">Disagree ↑/↓</th><th className="pr-4">Cost</th>
              <th className="pr-4">Skips (why not scored)</th><th>Epoch</th>
            </tr>
          </thead>
          <tbody>
            {data.verdict.cycles.map((c, i) => (
              <tr key={i} className="border-b align-top">
                <td className="py-2 pr-4">{new Date(c.startedAt).toLocaleString()}</td>
                <td className="pr-4">{c.llm?.requested ?? 0}</td>
                <td className="pr-4">{c.llm?.scored ?? 0}</td>
                <td className="pr-4">{c.llm?.cacheHits ?? 0}</td>
                <td className="pr-4">{(c.llm?.errors ?? 0) > 0 ? `⚠ ${c.llm?.errors}` : '0'}</td>
                <td className="pr-4">{c.llm?.timeouts ?? 0}</td>
                <td className="pr-4">{c.llm?.softClosed ?? 0}</td>
                <td className="pr-4">{c.llm ? `${c.llm.llmFlaggedCleanRow}/${c.llm.llmClearedFlaggedRow}` : '—'}</td>
                <td className="pr-4">${(c.llm?.costUsd ?? 0).toFixed(3)}</td>
                {/* The incident column (Codex #545): a requested-N/scored-0
                    row must NAME its cause right here, not only in Mongo. */}
                <td className="pr-4">
                  {c.llm?.skips && Object.keys(c.llm.skips).length
                    ? Object.entries(c.llm.skips).map(([k, v]) => `${k}:${v}`).join(' ')
                    : '—'}
                </td>
                <td>{c.llm?.epoch ?? '—'}</td>
              </tr>
            ))}
            {!data.verdict.cycles.length && (
              <tr><td className="py-2 text-gray-400" colSpan={11}>No verdict cycles yet — collection is {data.verdict.config.collectionEnabled ? 'on; the sweeper runs at :45' : 'off'}.</td></tr>
            )}
          </tbody>
        </table>
      </div>
    </main>
  )
}
