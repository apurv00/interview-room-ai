'use client'

import { useState } from 'react'
import { ScoreBar } from '@shared/ui/ScoreBar'
import type { TranscriptEntry, AnswerEvaluation } from '@shared/types'

// Safe string coerce to prevent React #310
function s(v: unknown): string {
  if (v === null || v === undefined) return ''
  if (typeof v === 'object') return JSON.stringify(v)
  return String(v)
}

interface QuestionBreakdownProps {
  transcript: TranscriptEntry[]
  evaluations: AnswerEvaluation[]
}

export default function QuestionBreakdown({ transcript, evaluations }: QuestionBreakdownProps) {
  const [expandedIdx, setExpandedIdx] = useState<number | null>(null)

  if (evaluations.length === 0) {
    return (
      <div className="text-center py-10 text-[#8b98a5] text-sm">
        No per-question evaluations available.
      </div>
    )
  }

  return (
    <div className="space-y-3">
      {evaluations.map((ev, i) => {
        const avgScore = Math.round(
          (ev.relevance + ev.structure + ev.specificity + ev.ownership) / 4
        )
        const isOpen = expandedIdx === i
        const scoreColor =
          avgScore >= 75 ? 'text-[#059669]' : avgScore >= 55 ? 'text-amber-600' : 'text-red-500'
        const scoreBg =
          avgScore >= 75
            ? 'bg-emerald-500/10 border-emerald-500/30'
            : avgScore >= 55
            ? 'bg-amber-500/10 border-amber-500/30'
            : 'bg-red-500/10 border-red-500/30'

        // Find follow-up Q&A for this question index
        const followUpEntries = transcript.filter(
          (t) =>
            t.questionIndex === ev.questionIndex &&
            t.speaker === 'interviewer' &&
            t.text !== ev.question
        )

        return (
          <div
            key={i}
            className="bg-white border border-[#e1e8ed] rounded-2xl overflow-hidden transition-all"
          >
            {/* Header — always visible */}
            <button
              onClick={() => setExpandedIdx(isOpen ? null : i)}
              className="w-full flex items-center gap-3 sm:gap-4 p-3 sm:p-4 text-left hover:bg-[#f8fafc] transition"
            >
              <div
                className={`shrink-0 w-11 h-11 sm:w-10 sm:h-10 rounded-xl border flex items-center justify-center text-sm font-bold ${scoreBg} ${scoreColor}`}
              >
                {avgScore}
              </div>
              <div className="flex-1 min-w-0">
                <p className="text-xs text-[#8b98a5] mb-0.5">Question {i + 1}</p>
                <p className="text-sm text-[#0f1419] truncate">{s(ev.question)}</p>
              </div>
              <svg
                className={`w-4 h-4 text-[#8b98a5] shrink-0 transition-transform ${
                  isOpen ? 'rotate-180' : ''
                }`}
                fill="none"
                viewBox="0 0 24 24"
                stroke="currentColor"
                strokeWidth={2}
              >
                <path strokeLinecap="round" strokeLinejoin="round" d="M19 9l-7 7-7-7" />
              </svg>
            </button>

            {/* Expanded detail */}
            {isOpen && (
              <div className="px-4 pb-4 space-y-4 border-t border-[#e1e8ed]">
                {/* Question */}
                <div className="pt-3">
                  <p className="text-xs text-[#8b98a5] font-medium mb-1 uppercase tracking-wide">
                    Question
                  </p>
                  <p className="text-sm text-[#536471] leading-relaxed">{s(ev.question)}</p>
                </div>

                {/* Answer */}
                <div>
                  <p className="text-xs text-[#8b98a5] font-medium mb-1 uppercase tracking-wide">
                    Your Answer
                  </p>
                  <p className="text-sm text-[#536471] leading-relaxed bg-[#f8fafc] rounded-xl p-3">
                    {ev.answer ? s(ev.answer) : (
                      <span className="italic text-[#8b98a5]">No answer captured</span>
                    )}
                  </p>
                </div>

                {/* Score breakdown */}
                <div>
                  <p className="text-xs text-[#8b98a5] font-medium mb-2 uppercase tracking-wide">
                    Score Breakdown
                  </p>
                  <div className="space-y-2">
                    <ScoreBar label="Relevance" score={ev.relevance} delay={0} />
                    <ScoreBar label="Structure (STAR)" score={ev.structure} delay={50} />
                    <ScoreBar label="Specificity" score={ev.specificity} delay={100} />
                    <ScoreBar label="Ownership" score={ev.ownership} delay={150} />
                    {ev.jdAlignment != null && (
                      <ScoreBar label="JD Alignment" score={ev.jdAlignment} color="cyan" delay={200} />
                    )}
                  </div>
                </div>

                {/* Flags */}
                {ev.flags.length > 0 && (
                  <div className="flex flex-wrap gap-1.5">
                    {ev.flags.map((flag, fi) => (
                      <span
                        key={fi}
                        className="px-2 py-0.5 bg-red-500/10 border border-red-500/20 rounded-full text-xs text-red-400"
                      >
                        {s(flag)}
                      </span>
                    ))}
                  </div>
                )}

                {/* Low score suggestions */}
                {avgScore < 60 && (
                  <div className="bg-amber-50 border border-amber-200 rounded-xl p-3">
                    <p className="text-xs text-amber-700 font-medium mb-1">Suggestion</p>
                    <p className="text-xs text-amber-600">
                      {ev.structure < 55
                        ? 'Try using the STAR framework: describe the Situation, your Task, the Action you took, and the Result.'
                        : ev.specificity < 55
                        ? 'Include specific metrics, numbers, or concrete examples to strengthen your answer.'
                        : ev.ownership < 55
                        ? 'Use "I" instead of "we" and clearly describe your personal contributions.'
                        : 'Focus on answering the specific question asked. Keep your response targeted and relevant.'}
                    </p>
                  </div>
                )}

                {/* Follow-up Q&A */}
                {followUpEntries.length > 0 && (
                  <div className="border-t border-[#e1e8ed] pt-3">
                    <p className="text-xs text-[#8b98a5] font-medium mb-2 uppercase tracking-wide">
                      Follow-up
                    </p>
                    {followUpEntries.map((fq, fi) => (
                      <div key={fi} className="mb-2">
                        <p className="text-xs text-blue-600 mb-1">{s(fq.text)}</p>
                        {/* Find the candidate's follow-up answer */}
                        {transcript
                          .filter(
                            (t) =>
                              t.speaker === 'candidate' &&
                              t.questionIndex === ev.questionIndex &&
                              t.timestamp > fq.timestamp
                          )
                          .slice(0, 1)
                          .map((a, ai) => (
                            <p key={ai} className="text-xs text-[#8b98a5] bg-[#f8fafc] rounded-lg p-2">
                              {s(a.text)}
                            </p>
                          ))}
                      </div>
                    ))}
                  </div>
                )}
              </div>
            )}
          </div>
        )
      })}
    </div>
  )
}
