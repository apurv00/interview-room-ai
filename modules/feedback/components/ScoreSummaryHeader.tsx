'use client'

import { useMemo } from 'react'
import type { AnswerEvaluation } from '@shared/types'
import { scoreTextClass } from '@shared/ui/ScoreBar'

interface ScoreSummaryHeaderProps {
  evaluations: AnswerEvaluation[]
  /**
   * The session's single overall score (feedback.overall_score) — the SAME
   * number as the hero ScoreRing. Shown here as a small anchor so the
   * per-question / per-dimension detail below reads as components of one score,
   * not a competing average. Previously this header showed a separately-computed
   * "Avg score" (mean of the answer dimensions), which differed from the overall
   * and read as a second, contradictory score to candidates.
   */
  overallScore?: number | null
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
    return { answered: 0, total: evaluations.length, strongest: null, weakest: null }
  }

  const dims: DimensionStat[] = (Object.keys(DIMENSION_LABELS) as DimensionKey[]).map((key) => ({
    key,
    label: DIMENSION_LABELS[key],
    score: Math.round(scored.reduce((s, e) => s + (e[key] || 0), 0) / scored.length),
  }))

  const sorted = [...dims].sort((a, b) => b.score - a.score)
  const strongest = sorted[0]
  const weakest = sorted[sorted.length - 1]

  return { answered: scored.length, total: evaluations.length, strongest, weakest }
}

export default function ScoreSummaryHeader({ evaluations, overallScore }: ScoreSummaryHeaderProps) {
  const stats = useMemo(() => computeStats(evaluations), [evaluations])

  if (stats.answered === 0) {
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
        {/* Left — overall anchor (the SAME number as the hero ScoreRing) + completion */}
        <div className="flex items-baseline gap-3 shrink-0">
          {overallScore != null && (
            <span className={`text-3xl leading-none font-bold ${scoreTextClass(overallScore)}`}>
              {overallScore}
            </span>
          )}
          <div className="flex flex-col">
            {overallScore != null && (
              <span className="text-caption text-[#71767b] uppercase tracking-wide font-medium">
                Overall
              </span>
            )}
            <span className="text-caption text-[#71767b]">
              {stats.answered} of {stats.total} questions answered
            </span>
          </div>
        </div>

        {/* Right — dimension diagnosis pills (strongest / weakest across answers) */}
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
