'use client'

import { useState } from 'react'
import { dimensionLabels, dimensionShortLabels } from '@shared/lib/answerSuggestion'

interface Evaluation {
  /** 1-based original question number, preserved across filters in OverviewTab.
   *  Falls back to array position for older callers that don't supply it. */
  questionNumber?: number
  question: string
  answer: string
  relevance: number
  structure: number
  specificity: number
  ownership: number
  flags: string[]
}

interface TranscriptEntry {
  speaker: string
  text: string
}

interface QuestionHeatmapProps {
  evaluations: Evaluation[]
  transcript: TranscriptEntry[]
  /**
   * Click handler for a question row. When provided, suppresses the local
   * inline-expand behavior — parent owns navigation (e.g. ScoresTab scrolls
   * to and expands the matching QuestionBreakdown row instead).
   * `questionIndex` is the array index `i` (0-based), matching how
   * QuestionBreakdown indexes its accordion rows.
   */
  onCellClick?: (questionIndex: number) => void
  /**
   * Session interview-type slug (config.interviewType). Drives domain-aware
   * column labels so the heatmap doesn't show "Str"/"Structure" for a cell that
   * holds a code_quality/architecture/conceptual_depth score (which the
   * QuestionBreakdown below labels "Code Quality"/etc.). Session-level: the
   * heatmap columns are shared across rows, so the academics warm-up per-row
   * remap isn't applied here.
   */
  interviewType?: string
}

const DIMENSIONS = ['relevance', 'structure', 'specificity', 'ownership'] as const

// Header and body cells share these exact classes so the columns line up.
// (The previous version rendered the header as a real <table> row and each
// body row as a single colSpan cell wrapping a flexbox — two independent
// layout systems whose columns never aligned. Everything is one flex grid now.)
const SCORE_CELL_WIDTH = 'w-12'
const CELL_MARGIN = { margin: '1px' } as const

function getCellStyle(score: number): string {
  if (score >= 75) return 'bg-green-100 text-green-700'
  if (score >= 50) return 'bg-yellow-50 text-yellow-700'
  return 'bg-red-50 text-red-700'
}

function truncate(text: string, max: number): string {
  if (!text) return ''
  return text.length > max ? text.slice(0, max) + '...' : text
}

export default function QuestionHeatmap({ evaluations, transcript: _transcript, onCellClick, interviewType }: QuestionHeatmapProps) {
  const [expandedIdx, setExpandedIdx] = useState<number | null>(null)
  const shortLabels = dimensionShortLabels(interviewType)
  const fullLabels = dimensionLabels(interviewType)

  if (!evaluations || evaluations.length === 0) {
    return (
      <div className="text-center py-8 text-[#71767b] text-sm">
        No evaluation data available.
      </div>
    )
  }

  return (
    <div className="bg-white rounded-2xl border border-[#e1e8ed] p-4 overflow-x-auto">
      <h4 className="text-sm font-semibold text-[#0f1419] mb-3">Question Score Heatmap</h4>
      {/* One flex grid for header + rows. min-width keeps the fixed score
          columns intact on narrow screens (the wrapper scrolls horizontally). */}
      <div className="min-w-[420px] text-sm">
        {/* Header row — mirrors the body row's flex geometry EXACTLY:
            a flex-1 "Question" label + one fixed-width cell per dimension + Avg. */}
        <div className="flex items-center border-b border-[#e1e8ed] pb-2 mb-1">
          <div className="flex-1 pr-3 text-left text-[#71767b] text-xs font-medium">Question</div>
          {DIMENSIONS.map((dim) => (
            <div
              key={dim}
              className={`${SCORE_CELL_WIDTH} text-center text-[#71767b] text-xs font-medium`}
              style={CELL_MARGIN}
              title={fullLabels[dim]}
            >
              {shortLabels[dim]}
            </div>
          ))}
          <div className={`${SCORE_CELL_WIDTH} text-center text-[#71767b] text-xs font-medium`} style={CELL_MARGIN}>
            Avg
          </div>
        </div>

        {evaluations.map((ev, i) => {
          const avg = Math.round(
            (ev.relevance + ev.structure + ev.specificity + ev.ownership) / 4
          )
          const isExpanded = expandedIdx === i

          return (
            <div key={i} className="group">
              {/* Clickable row */}
              <button
                onClick={() => {
                  if (onCellClick) {
                    onCellClick(i)
                  } else {
                    setExpandedIdx(isExpanded ? null : i)
                  }
                }}
                className="w-full text-left hover:bg-[#f8fafc] transition"
              >
                <div className="flex items-center">
                  <div className="flex-1 py-2 pr-3 min-w-0">
                    <span className="text-xs text-[#71767b]">Q{ev.questionNumber ?? i + 1}</span>
                    <span className="ml-2 text-xs text-[#0f1419] truncate">
                      {truncate(ev.question, 40)}
                    </span>
                    <svg
                      className={`inline-block w-3 h-3 ml-1 text-[#71767b] transition-transform ${
                        isExpanded ? 'rotate-180' : ''
                      }`}
                      fill="none"
                      viewBox="0 0 24 24"
                      stroke="currentColor"
                      strokeWidth={2}
                      // When parent owns navigation, point right to suggest "jumps to row" instead of "expands here"
                      style={onCellClick ? { transform: 'rotate(-90deg)' } : undefined}
                    >
                      <path strokeLinecap="round" strokeLinejoin="round" d="M19 9l-7 7-7-7" />
                    </svg>
                  </div>
                  {DIMENSIONS.map((dim) => {
                    const score = ev[dim]
                    return (
                      <div
                        key={dim}
                        className={`${SCORE_CELL_WIDTH} text-center py-2 text-xs font-semibold rounded ${getCellStyle(score)}`}
                        style={CELL_MARGIN}
                      >
                        {score}
                      </div>
                    )
                  })}
                  <div
                    className={`${SCORE_CELL_WIDTH} text-center py-2 text-xs font-bold rounded ${getCellStyle(avg)}`}
                    style={CELL_MARGIN}
                  >
                    {avg}
                  </div>
                </div>
              </button>

              {/* Expanded detail (suppressed when parent owns navigation via onCellClick) */}
              {isExpanded && !onCellClick && (
                <div className="px-3 pb-3 pt-1 border-t border-[#e1e8ed] bg-[#f8fafc]">
                  <div className="space-y-2">
                    <div>
                      <span className="text-xs text-[#71767b] font-medium">Question: </span>
                      <span className="text-xs text-[#0f1419]">
                        {truncate(ev.question, 100)}
                      </span>
                    </div>
                    <div>
                      <span className="text-xs text-[#71767b] font-medium">Answer: </span>
                      <span className="text-xs text-[#0f1419]">
                        {truncate(ev.answer || '', 200)}
                      </span>
                    </div>
                    {ev.flags && ev.flags.length > 0 && (
                      <div className="flex flex-wrap gap-1.5 pt-1">
                        {ev.flags.map((flag, fi) => (
                          <span
                            key={fi}
                            className="px-2 py-0.5 bg-red-500/10 border border-red-500/20 rounded-full text-xs text-red-500"
                          >
                            {flag}
                          </span>
                        ))}
                      </div>
                    )}
                  </div>
                </div>
              )}
            </div>
          )
        })}
      </div>
    </div>
  )
}
