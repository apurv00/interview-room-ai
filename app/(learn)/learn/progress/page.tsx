'use client'

import { useEffect, useState } from 'react'
import { useSession } from 'next-auth/react'
import { useRouter } from 'next/navigation'
import { ScoreRing } from '@interview/components/ScoreBar'

interface ProgressData {
  stats: {
    totalInterviews: number
    avgScore: number
    bestScore: number
    avgDuration: number
  }
  trends: Array<{
    score: number
    answerQuality: number
    communication: number
    delivery: number
    date: string
    role: string
  }>
  weaknesses: Array<{ dimension: string; avgScore: number }>
  mostImproved: string | null
}

const DIMENSION_LABELS: Record<string, string> = {
  relevance: 'Relevance',
  structure: 'Structure (STAR)',
  specificity: 'Specificity',
  ownership: 'Ownership',
}

export default function ProgressPage() {
  const router = useRouter()
  const { data: session, status: authStatus } = useSession()
  const [data, setData] = useState<ProgressData | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [period, setPeriod] = useState<'7d' | '30d' | 'all'>('all')

  useEffect(() => {
    if (authStatus === 'unauthenticated') {
      router.push('/signin')
      return
    }
    if (authStatus !== 'authenticated') return

    async function load() {
      setLoading(true)
      setError(null)
      try {
        const res = await fetch(`/api/learn/progress?period=${period}`)
        if (res.ok) {
          setData(await res.json())
        } else {
          setError('Failed to load progress data. Please try again.')
        }
      } catch {
        setError('Network error. Please check your connection and try again.')
      } finally {
        setLoading(false)
      }
    }

    load()
  }, [authStatus, period, router])

  if (loading) {
    return (
      <div className="min-h-screen bg-[#070b14] flex items-center justify-center">
        <div className="w-6 h-6 rounded-full border-2 border-indigo-400 border-t-transparent animate-spin" />
      </div>
    )
  }

  if (error) {
    return (
      <div className="min-h-screen bg-[#070b14] text-white">
        <div className="max-w-4xl mx-auto px-4 py-16 text-center">
          <h1 className="text-2xl font-bold mb-4">Progress Tracker</h1>
          <p className="text-red-400 mb-6">{error}</p>
          <button
            onClick={() => { setLoading(true); setError(null); setPeriod('all') }}
            className="px-6 py-3 bg-slate-800 hover:bg-slate-700 text-white rounded-xl font-medium transition"
          >
            Retry
          </button>
        </div>
      </div>
    )
  }

  if (!data || data.stats.totalInterviews === 0) {
    return (
      <div className="min-h-screen bg-[#070b14] text-white">
        <div className="max-w-4xl mx-auto px-4 py-16 text-center">
          <h1 className="text-2xl font-bold mb-4">Progress Tracker</h1>
          <p className="text-slate-400 mb-6">
            Complete your first interview to start tracking your progress.
          </p>
          <button
            onClick={() => router.push('/')}
            className="px-6 py-3 bg-indigo-600 hover:bg-indigo-500 text-white rounded-xl font-medium transition"
          >
            Start Your First Interview
          </button>
        </div>
      </div>
    )
  }

  const { stats, trends, weaknesses, mostImproved } = data

  // SVG trend chart
  const W = 400
  const H = 100
  const PAD = 15

  function renderTrendLine(
    values: number[],
    color: string,
    id: string
  ) {
    if (values.length < 2) return null
    const min = Math.min(...values) - 5
    const max = Math.max(...values) + 5
    const range = max - min || 1
    const coords = values.map((v, i) => ({
      x: PAD + (i / (values.length - 1)) * (W - PAD * 2),
      y: PAD + (H - PAD * 2) - ((v - min) / range) * (H - PAD * 2),
    }))
    const line = coords.map((c, i) => `${i === 0 ? 'M' : 'L'} ${c.x} ${c.y}`).join(' ')
    return (
      <g key={id}>
        <path d={line} fill="none" stroke={color} strokeWidth="2" strokeLinecap="round" />
        {coords.map((c, i) => (
          <circle key={i} cx={c.x} cy={c.y} r="3" fill={color} />
        ))}
      </g>
    )
  }

  return (
    <div className="min-h-screen bg-[#070b14] text-white">
      <div className="max-w-5xl mx-auto px-4 py-8 space-y-8">
        {/* Header */}
        <div className="flex items-center justify-between">
          <h1 className="text-2xl font-bold">Progress Tracker</h1>
          <div className="flex gap-1 bg-slate-900 border border-slate-800 rounded-xl p-1">
            {(['7d', '30d', 'all'] as const).map((p) => (
              <button
                key={p}
                onClick={() => setPeriod(p)}
                className={`px-3 py-1.5 rounded-lg text-xs font-medium transition ${
                  period === p
                    ? 'bg-indigo-600 text-white'
                    : 'text-slate-400 hover:text-slate-200'
                }`}
              >
                {p === '7d' ? '7 Days' : p === '30d' ? '30 Days' : 'All Time'}
              </button>
            ))}
          </div>
        </div>

        {/* Stats cards */}
        <section className="grid grid-cols-2 md:grid-cols-4 gap-4">
          {[
            { label: 'Total Interviews', value: stats.totalInterviews, icon: '📋' },
            { label: 'Avg Score', value: stats.avgScore, icon: '📊' },
            { label: 'Best Score', value: stats.bestScore, icon: '🏆' },
            {
              label: 'Avg Duration',
              value: `${Math.floor(stats.avgDuration / 60)}m`,
              icon: '⏱',
            },
          ].map((card) => (
            <div
              key={card.label}
              className="bg-slate-900 border border-slate-800 rounded-2xl p-5 text-center"
            >
              <span className="text-2xl">{card.icon}</span>
              <p className="text-2xl font-bold text-white mt-2">{card.value}</p>
              <p className="text-xs text-slate-500 mt-1">{card.label}</p>
            </div>
          ))}
        </section>

        {/* Most improved badge */}
        {mostImproved && (
          <div className="bg-emerald-950/30 border border-emerald-500/20 rounded-2xl p-4 flex items-center gap-3">
            <div className="w-10 h-10 rounded-full bg-emerald-500/20 flex items-center justify-center text-emerald-400 text-lg">
              📈
            </div>
            <div>
              <p className="text-sm font-medium text-emerald-400">Improving!</p>
              <p className="text-xs text-emerald-300/70">{mostImproved}</p>
            </div>
          </div>
        )}

        {/* Overall score trend */}
        {trends.length >= 2 && (
          <section className="bg-slate-900 border border-slate-800 rounded-2xl p-5 space-y-3">
            <h3 className="font-semibold text-slate-200">Overall Score Trend</h3>
            <svg viewBox={`0 0 ${W} ${H}`} className="w-full h-28">
              {renderTrendLine(
                trends.map((t) => t.score),
                'rgb(99,102,241)',
                'overall'
              )}
            </svg>
            <div className="flex justify-between text-[10px] text-slate-600 px-4">
              {trends.map((t, i) =>
                i === 0 || i === trends.length - 1 ? (
                  <span key={i}>
                    {new Date(t.date).toLocaleDateString('en-US', {
                      month: 'short',
                      day: 'numeric',
                    })}
                  </span>
                ) : null
              )}
            </div>
          </section>
        )}

        {/* Dimension trends */}
        {trends.length >= 2 && (
          <section className="grid md:grid-cols-3 gap-4">
            {[
              { label: 'Answer Quality', key: 'answerQuality' as const, color: 'rgb(129,140,248)' },
              { label: 'Communication', key: 'communication' as const, color: 'rgb(34,211,238)' },
              { label: 'Delivery', key: 'delivery' as const, color: 'rgb(167,139,250)' },
            ].map((dim) => (
              <div
                key={dim.key}
                className="bg-slate-900 border border-slate-800 rounded-2xl p-4 space-y-2"
              >
                <p className="text-sm font-medium text-slate-300">{dim.label}</p>
                <svg viewBox={`0 0 ${W} ${H}`} className="w-full h-16">
                  {renderTrendLine(
                    trends.map((t) => t[dim.key]),
                    dim.color,
                    dim.key
                  )}
                </svg>
              </div>
            ))}
          </section>
        )}

        {/* Weaknesses */}
        {weaknesses.length > 0 && (
          <section className="bg-slate-900 border border-slate-800 rounded-2xl p-5 space-y-4">
            <h3 className="font-semibold text-slate-200">Focus Areas</h3>
            <p className="text-xs text-slate-500">
              These dimensions consistently score lowest. Focus on improving them.
            </p>
            <div className="space-y-3">
              {weaknesses.map((w) => {
                const pct = Math.max(0, Math.min(100, w.avgScore))
                const color =
                  pct >= 75
                    ? 'bg-emerald-500'
                    : pct >= 55
                    ? 'bg-amber-500'
                    : 'bg-red-500'
                return (
                  <div key={w.dimension}>
                    <div className="flex justify-between text-xs mb-1">
                      <span className="text-slate-300">
                        {DIMENSION_LABELS[w.dimension] || w.dimension}
                      </span>
                      <span className="text-slate-400 tabular-nums">{w.avgScore}</span>
                    </div>
                    <div className="h-1.5 bg-slate-800 rounded-full overflow-hidden">
                      <div
                        className={`h-full rounded-full ${color} transition-all`}
                        style={{ width: `${pct}%` }}
                      />
                    </div>
                  </div>
                )
              })}
            </div>
          </section>
        )}
      </div>
    </div>
  )
}
