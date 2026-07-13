'use client'

import { useEffect, useState } from 'react'

// Keep it lightweight; this is an internal tool (score-telemetry precedent).

interface SourceRow {
  sourceId: string
  kind: string
  enabled: boolean
  health: string
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
interface Payload {
  sources: SourceRow[]
  cycles: CycleRow[]
  corpus: { open: number; closed: number }
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

  return (
    <main className="mx-auto max-w-5xl p-8">
      <h1 className="text-2xl font-semibold">Jobs Ingest</h1>

      <div className="mt-6 grid grid-cols-2 gap-4 sm:grid-cols-4">
        <Stat label="Open corpus" value={data.corpus.open} />
        <Stat label="Closed" value={data.corpus.closed} />
        <Stat label="Sources" value={data.sources.length} />
        <Stat label="Cycles (recent)" value={data.cycles.length} />
      </div>

      <h2 className="mt-10 text-lg font-medium">Sources</h2>
      <div className="mt-3 overflow-x-auto">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b text-left text-gray-500">
              <th className="py-2 pr-4">Source</th><th className="pr-4">Kind</th><th className="pr-4">Enabled</th>
              <th className="pr-4">Health</th><th className="pr-4">Cadence</th><th>Last sync</th>
            </tr>
          </thead>
          <tbody>
            {data.sources.map((s) => (
              <tr key={s.sourceId} className="border-b">
                <td className="py-2 pr-4 font-medium">{s.sourceId}</td>
                <td className="pr-4">{s.kind}</td>
                <td className="pr-4">{s.enabled ? '✅' : '—'}</td>
                <td className="pr-4">{s.health}</td>
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
    </main>
  )
}
