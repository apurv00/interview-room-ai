'use client'

import { useMemo } from 'react'
import type { AnswerEvaluation } from '@shared/types'

interface ScoreSummaryHeaderProps {
  evaluations: AnswerEvaluation[]
}

type DimensionKey = 'relevance' | 'structure' | 'specificity' | 'ownership'

const DIMENSION_LABELS: Record<DimensionKey, string> = {
  relevance: 'Relevance',
  structure: 'Structure',
  specificity: 'Specificity',
  ownership: 'Ownership',
}

interface DimensionStat {
  key: DimensionKey
  label: string
  score: number
}

function computeStats(evaluations: AnswerEvaluation[]) {
  const scored = evaluations.filter(
    (e) => (e as unknown as { status?: string }).status !== 'failed'
  )
  if (scored.length === 0) {
    return { avg: null, answered: 0, total: evaluations.length, strongest: null, weakest: null }
  }

  const dims: DimensionStat[] = (Object.keys(DIMENSION_LABELS) as DimensionKey[]).map((key) => ({
    key,
    label: DIMENSION_LABELS[key],
    score: Math.round(scored.reduce((s, e) => s + (e[key] || 0), 0) / scored.length),
  }))

  const sorted = [...dims].sort((a, b) => b.score - a.score)
  const strongest = sorted[0]
  const weakest = sorted[sorted.length - 1]

  const avg = Math.round(
    dims.reduce((s, d) => s + d.score, 0) / dims.length
  )

  return { avg, answered: scored.length, total: evaluations.length, strongest, weakest }
}

function bandClass(score: number): string {
  if (score >= 75) return 'text-emerald-600'
  if (score >= 55) return 'text-amber-600'
  return 'text-red-500'
}

export default function ScoreSummaryHeader({ evaluations }: ScoreSummaryHeaderProps) {
  const stats = useMemo(() => computeStats(evaluations), [evaluations])

  if (stats.avg === null) {
    return (
      <section className="surface-card-bordered p-5 text-center">
        <p className="text-body text-[#71767b]">
          {stats.total === 0
            ? 'No questions were answered in this session.'
            : 'No scorable answers in this session.'}
        </p>
      </section>
    )
  }

  return (
    <section className="surface-card-bordered p-5 sm:p-6">
      <div className="flex flex-col sm:flex-row sm:items-center gap-5 sm:gap-6">
        {/* Left — average */}
        <div className="flex items-baseline gap-3 shrink-0">
          <span className={`text-[44px] leading-none font-bold ${bandClass(stats.avg)}`}>
            {stats.avg}
          </span>
          <div className="flex flex-col">
            <span className="text-caption text-[#71767b] uppercase tracking-wide font-medium">
              Avg score
            </span>
            <span className="text-caption text-[#71767b]">
              {stats.answered} of {stats.total} questions answered
            </span>
          </div>
        </div>

        {/* Right — dimension pills */}
        <div className="flex flex-wrap gap-2 sm:ml-auto">
          {stats.strongest && (
            <span
              className="inline-flex items-baseline gap-2 px-3 py-1.5 rounded-full border border-emerald-500/30 bg-emerald-500/10 text-sm"
              title={`Highest dimension average across answered questions`}
            >
              <span className="text-emerald-700 font-medium">Strongest</span>
              <span className="text-[#71767b]">·</span>
              <span className="text-[#0f1419] font-medium">{stats.strongest.label}</span>
              <span className="text-emerald-700 font-bold">{stats.strongest.score}</span>
            </span>
          )}
          {stats.weakest && stats.strongest && stats.weakest.key !== stats.strongest.key && (
            <span
              className="inline-flex items-baseline gap-2 px-3 py-1.5 rounded-full border border-red-500/30 bg-red-500/10 text-sm"
              title={`Lowest dimension average across answered questions`}
            >
              <span className="text-red-700 font-medium">Weakest</span>
              <span className="text-[#71767b]">·</span>
              <span className="text-[#0f1419] font-medium">{stats.weakest.label}</span>
              <span className="text-red-700 font-bold">{stats.weakest.score}</span>
            </span>
          )}
        </div>
      </div>
    </section>
  )
}
