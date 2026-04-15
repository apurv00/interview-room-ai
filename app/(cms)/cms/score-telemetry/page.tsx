'use client'

import { useEffect, useState } from 'react'

/**
 * CMS score-telemetry dashboard (Work Item G.1).
 *
 * Shows the delta distribution between Claude's raw overall_score and
 * the current deterministic formula, so we can validate the G.8
 * rebalance BEFORE flipping flags on. Intended for platform_admin only.
 *
 * Minimal UI — no charts library, just a numeric summary + a bucketed
 * histogram rendered as horizontal bars. Keep it lightweight; this is
 * an internal tool, not a user-facing surface.
 */

interface TelemetrySummary {
  windowHours: number
  since: string
  totalRows: number
  withDelta: number
  avgDelta: number | null
  meanAbsDelta: number | null
  claudeHigherCount: number
  formulaHigherCount: number
  truncatedCount: number
  reasonCounts: Record<string, number>
  modelCounts: Record<string, number>
  histogram: Record<string, number>
}

const WINDOW_OPTIONS = [
  { label: '24h', hours: 24 },
  { label: '7d', hours: 168 },
  { label: '30d', hours: 720 },
]

// Fixed bucket order so the chart doesn't shuffle between renders.
const BUCKET_ORDER = [
  '-50..-40',
  '-40..-30',
  '-30..-20',
  '-20..-10',
  '-10..0',
  '0..10',
  '10..20',
  '20..30',
  '30..40',
  '40..50',
]

export default function ScoreTelemetryPage() {
  const [hours, setHours] = useState<number>(168)
  const [data, setData] = useState<TelemetrySummary | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false
    setLoading(true)
    setError(null)
    fetch(`/api/cms/score-telemetry?hours=${hours}`)
      .then(async (r) => {
        if (!r.ok) throw new Error(`HTTP ${r.status}`)
        return r.json() as Promise<TelemetrySummary>
      })
      .then((d) => {
        if (!cancelled) setData(d)
      })
      .catch((e) => {
        if (!cancelled) setError(e instanceof Error ? e.message : 'Failed to load')
      })
      .finally(() => {
        if (!cancelled) setLoading(false)
      })
    return () => {
      cancelled = true
    }
  }, [hours])

  const maxBucket = data
    ? Math.max(1, ...BUCKET_ORDER.map((k) => data.histogram[k] ?? 0))
    : 1

  return (
    <div className="max-w-5xl space-y-6">
      <header className="space-y-2">
        <h1 className="text-2xl font-semibold text-[#0f1419]">Score telemetry</h1>
        <p className="text-sm text-[#536471]">
          Claude raw <code>overall_score</code> vs the deterministic formula
          output. Use this to decide whether the scoring-rebalance flags
          (G.8+) are ready to ship.
        </p>
      </header>

      <div className="flex gap-2 items-center">
        <span className="text-xs text-[#8b98a5]">Window:</span>
        {WINDOW_OPTIONS.map((opt) => (
          <button
            key={opt.hours}
            onClick={() => setHours(opt.hours)}
            className={`px-3 py-1 text-xs rounded-full border transition-colors ${
              hours === opt.hours
                ? 'bg-[#2563eb] text-white border-[#2563eb]'
                : 'bg-white text-[#536471] border-[#e1e8ed] hover:border-[#2563eb]'
            }`}
          >
            {opt.label}
          </button>
        ))}
      </div>

      {loading && (
        <div className="text-sm text-[#8b98a5]">Loading…</div>
      )}

      {error && (
        <div className="text-sm text-red-600">Error: {error}</div>
      )}

      {data && !loading && (
        <div className="space-y-6">
          <section className="grid grid-cols-2 md:grid-cols-4 gap-4">
            <Stat label="Rows" value={data.totalRows} />
            <Stat label="With Claude delta" value={data.withDelta} />
            <Stat
              label="Avg delta (Claude − formula)"
              value={data.avgDelta == null ? '—' : data.avgDelta.toString()}
            />
            <Stat
              label="Mean |delta|"
              value={data.meanAbsDelta == null ? '—' : data.meanAbsDelta.toString()}
            />
            <Stat label="Claude higher" value={data.claudeHigherCount} />
            <Stat label="Formula higher" value={data.formulaHigherCount} />
            <Stat label="Truncated" value={data.truncatedCount} />
            <Stat label="Models seen" value={Object.keys(data.modelCounts).length} />
          </section>

          <section>
            <h2 className="text-sm font-semibold text-[#0f1419] mb-3">
              Delta distribution (Claude − formula, bucketed)
            </h2>
            <div className="space-y-1">
              {BUCKET_ORDER.map((k) => {
                const count = data.histogram[k] ?? 0
                const pct = count === 0 ? 0 : Math.max(2, Math.round((count / maxBucket) * 100))
                return (
                  <div key={k} className="flex items-center gap-3 text-xs">
                    <span className="w-20 tabular-nums text-[#8b98a5]">{k}</span>
                    <div className="flex-1 bg-[#f1f5f9] rounded h-5 overflow-hidden">
                      <div
                        className="h-full bg-[#2563eb]"
                        style={{ width: `${pct}%` }}
                      />
                    </div>
                    <span className="w-12 tabular-nums text-right text-[#536471]">
                      {count}
                    </span>
                  </div>
                )
              })}
            </div>
          </section>

          <section className="grid md:grid-cols-2 gap-6">
            <BreakdownList title="Record reasons" data={data.reasonCounts} />
            <BreakdownList title="Models seen" data={data.modelCounts} />
          </section>

          <footer className="text-xs text-[#8b98a5] pt-4 border-t border-[#e1e8ed]">
            Window: last {data.windowHours}h · since {new Date(data.since).toLocaleString()}
          </footer>
        </div>
      )}
    </div>
  )
}

function Stat({ label, value }: { label: string; value: number | string }) {
  return (
    <div className="bg-white border border-[#e1e8ed] rounded p-4">
      <div className="text-xs text-[#8b98a5]">{label}</div>
      <div className="text-2xl font-semibold tabular-nums text-[#0f1419] mt-1">
        {value}
      </div>
    </div>
  )
}

function BreakdownList({
  title,
  data,
}: {
  title: string
  data: Record<string, number>
}) {
  const entries = Object.entries(data).sort((a, b) => b[1] - a[1])
  return (
    <div>
      <h3 className="text-sm font-semibold text-[#0f1419] mb-2">{title}</h3>
      <div className="space-y-1">
        {entries.length === 0 && (
          <div className="text-xs text-[#8b98a5]">No data in window.</div>
        )}
        {entries.map(([k, v]) => (
          <div key={k} className="flex justify-between text-xs">
            <span className="text-[#536471] truncate pr-2">{k}</span>
            <span className="tabular-nums text-[#0f1419]">{v}</span>
          </div>
        ))}
      </div>
    </div>
  )
}
