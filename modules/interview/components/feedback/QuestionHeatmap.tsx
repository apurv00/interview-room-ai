'use client'

import { useState } from 'react'

interface Evaluation {
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
}

const DIMENSIONS = ['relevance', 'structure', 'specificity', 'ownership'] as const
const DIMENSION_LABELS: Record<string, string> = {
  relevance: 'Rel',
  structure: 'Str',
  specificity: 'Spec',
  ownership: 'Own',
}
const DIMENSION_FULL_LABELS: Record<string, string> = {
  relevance: 'Relevance',
  structure: 'Structure',
  specificity: 'Specificity',
  ownership: 'Ownership',
}

function getCellStyle(score: number): string {
  if (score >= 75) return 'bg-green-100 text-green-700'
  if (score >= 50) return 'bg-yellow-50 text-yellow-700'
  return 'bg-red-50 text-red-700'
}

function truncate(text: string, max: number): string {
  if (!text) return ''
  return text.length > max ? text.slice(0, max) + '...' : text
}

export default function QuestionHeatmap({ evaluations, transcript }: QuestionHeatmapProps) {
  const [expandedIdx, setExpandedIdx] = useState<number | null>(null)

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
      <table className="w-full text-sm">
        <thead>
          <tr>
            <th className="text-left text-[#71767b] text-xs font-medium pb-2 pr-3">Question</th>
            {DIMENSIONS.map((dim) => (
              <th
                key={dim}
                className="text-center text-[#71767b] text-xs font-medium pb-2 px-2"
                title={DIMENSION_FULL_LABELS[dim]}
              >
                {DIMENSION_LABELS[dim]}
              </th>
            ))}
            <th className="text-center text-[#71767b] text-xs font-medium pb-2 px-2">Avg</th>
          </tr>
        </thead>
        <tbody>
          {evaluations.map((ev, i) => {
            const avg = Math.round(
              (ev.relevance + ev.structure + ev.specificity + ev.ownership) / 4
            )
            const isExpanded = expandedIdx === i

            return (
              <tr key={i} className="group">
                <td colSpan={DIMENSIONS.length + 2} className="p-0">
                  {/* Clickable row */}
                  <button
                    onClick={() => setExpandedIdx(isExpanded ? null : i)}
                    className="w-full text-left hover:bg-[#f8fafc] transition"
                  >
                    <div className="flex items-center">
                      <div className="flex-1 py-2 pr-3 min-w-0">
                        <span className="text-xs text-[#71767b]">Q{i + 1}</span>
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
                        >
                          <path strokeLinecap="round" strokeLinejoin="round" d="M19 9l-7 7-7-7" />
                        </svg>
                      </div>
                      {DIMENSIONS.map((dim) => {
                        const score = ev[dim]
                        return (
                          <div
                            key={dim}
                            className={`w-12 text-center py-2 text-xs font-semibold rounded ${getCellStyle(score)}`}
                            style={{ margin: '1px' }}
                          >
                            {score}
                          </div>
                        )
                      })}
                      <div
                        className={`w-12 text-center py-2 text-xs font-bold rounded ${getCellStyle(avg)}`}
                        style={{ margin: '1px' }}
                      >
                        {avg}
                      </div>
                    </div>
                  </button>

                  {/* Expanded detail */}
                  {isExpanded && (
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
                </td>
              </tr>
            )
          })}
        </tbody>
      </table>
    </div>
  )
}
