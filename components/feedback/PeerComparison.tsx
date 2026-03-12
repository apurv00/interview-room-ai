'use client'

import type { FeedbackData } from '@/lib/types'

// ─── Exported types for parent to use ────────────────────────────────────────

export interface PeerData {
  available: boolean
  count: number
  averages?: {
    overall: number
    answerQuality: number
    communication: number
    engagement: number
  }
  userScore?: number
  percentile?: number
}

interface PeerComparisonProps {
  data: PeerData | null
  loading: boolean
  userFeedback: FeedbackData
}

// ─── Config-driven dimensions ────────────────────────────────────────────────

type AvgKey = 'overall' | 'answerQuality' | 'communication' | 'engagement'

interface DimensionConfig {
  key: AvgKey
  label: string
  getUserScore: (fb: FeedbackData) => number
}

const DIMENSIONS: DimensionConfig[] = [
  {
    key: 'overall',
    label: 'Overall',
    getUserScore: (fb) => fb.overall_score,
  },
  {
    key: 'answerQuality',
    label: 'Answer Quality',
    getUserScore: (fb) => fb.dimensions.answer_quality.score,
  },
  {
    key: 'communication',
    label: 'Communication',
    getUserScore: (fb) => fb.dimensions.communication.score,
  },
  {
    key: 'engagement',
    label: 'Engagement',
    // Legacy fallback: use delivery_signals if engagement_signals is missing
    getUserScore: (fb) =>
      fb.dimensions.engagement_signals?.score ??
      fb.dimensions.delivery_signals?.score ??
      0,
  },
]

// ─── Helpers ─────────────────────────────────────────────────────────────────

function getPercentileTier(percentile: number): 'high' | 'medium' | 'low' {
  if (percentile >= 75) return 'high'
  if (percentile >= 40) return 'medium'
  return 'low'
}

const PERCENTILE_COLORS: Record<string, string> = {
  high: 'text-emerald-400 bg-emerald-500/10 border-emerald-500/30',
  medium: 'text-amber-400 bg-amber-500/10 border-amber-500/30',
  low: 'text-red-400 bg-red-500/10 border-red-500/30',
}

function getBarColor(userScore: number, avgScore: number): string {
  if (userScore >= avgScore) return 'bg-emerald-500'
  if (userScore >= avgScore - 10) return 'bg-amber-500'
  return 'bg-red-500'
}

// ─── Component (presentational — no internal fetch) ──────────────────────────

export default function PeerComparison({ data, loading, userFeedback }: PeerComparisonProps) {
  if (loading) {
    return (
      <section className="bg-slate-900 border border-slate-800 rounded-2xl p-5 animate-fade-in">
        <div className="flex items-center gap-3">
          <div className="w-4 h-4 rounded-full border-2 border-indigo-400 border-t-transparent animate-spin" />
          <span className="text-sm text-slate-500">Loading peer comparison...</span>
        </div>
      </section>
    )
  }

  if (!data || !data.available) {
    return (
      <section className="bg-slate-900 border border-slate-800 rounded-2xl p-5 text-center animate-fade-in">
        <p className="text-slate-400 text-sm">Not enough data yet — be one of the first!</p>
        <p className="text-slate-600 text-xs mt-1">
          Peer comparisons unlock after 5 sessions in your role + experience bucket
          {data?.count ? ` (${data.count}/5 so far)` : ''}.
        </p>
      </section>
    )
  }

  const { averages, percentile, count } = data
  if (!averages) return null

  // Build dimension rows with user scores using config
  const rows = DIMENSIONS.map((dim) => ({
    key: dim.key,
    label: dim.label,
    userScore: dim.getUserScore(userFeedback),
    avgScore: averages[dim.key],
  }))

  return (
    <section className="bg-slate-900 border border-slate-800 rounded-2xl p-5 space-y-4 animate-fade-in">
      <div className="flex items-center justify-between">
        <h3 className="font-semibold text-slate-200">How You Compare</h3>
        <span className="text-xs text-slate-500">{count} sessions in your bucket</span>
      </div>

      {/* Percentile badge */}
      {percentile !== undefined && (
        <div className="flex items-center gap-3">
          <div
            className={`px-3 py-1 rounded-full border text-sm font-medium ${PERCENTILE_COLORS[getPercentileTier(percentile)]}`}
            data-testid="percentile-badge"
            data-tier={getPercentileTier(percentile)}
          >
            {percentile >= 50 ? `Top ${100 - percentile}%` : `${percentile}th percentile`}
          </div>
        </div>
      )}

      {/* Dimension comparison bars */}
      <div className="space-y-4">
        {rows.map((dim) => (
          <div key={dim.key}>
            <div className="flex justify-between text-xs mb-1.5">
              <span className="text-slate-400">{dim.label}</span>
              <span className="text-slate-400 tabular-nums">
                You: <span className="text-slate-200 font-medium">{dim.userScore}</span>
                {' · '}
                Avg: <span className="text-slate-200 font-medium">{dim.avgScore}</span>
              </span>
            </div>
            <div className="relative h-2 bg-slate-800 rounded-full overflow-hidden">
              {/* User's score bar */}
              <div
                className={`absolute h-full rounded-full transition-all duration-700 ${getBarColor(dim.userScore, dim.avgScore)}`}
                style={{ width: `${Math.min(100, dim.userScore)}%` }}
              />
              {/* Average marker */}
              <div
                className="absolute w-0.5 h-4 -top-1 bg-slate-400 rounded"
                style={{ left: `${Math.min(100, dim.avgScore)}%` }}
                title={`Community avg: ${dim.avgScore}`}
              />
            </div>
          </div>
        ))}
      </div>

      <p className="text-[10px] text-slate-600">
        Compared against {count} completed sessions for your role and experience level. Refreshed every 6 hours.
      </p>
    </section>
  )
}
