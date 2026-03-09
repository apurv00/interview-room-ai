'use client'

import { useState } from 'react'
import { ScoreBar } from '@/components/ScoreBar'
import type { TranscriptEntry, AnswerEvaluation } from '@/lib/types'

interface QuestionBreakdownProps {
  transcript: TranscriptEntry[]
  evaluations: AnswerEvaluation[]
}

export default function QuestionBreakdown({ transcript, evaluations }: QuestionBreakdownProps) {
  const [expandedIdx, setExpandedIdx] = useState<number | null>(null)

  if (evaluations.length === 0) {
    return (
      <div className="text-center py-10 text-slate-500 text-sm">
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
          avgScore >= 75 ? 'text-emerald-400' : avgScore >= 55 ? 'text-amber-400' : 'text-red-400'
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
            className="bg-slate-900 border border-slate-800 rounded-2xl overflow-hidden transition-all"
          >
            {/* Header — always visible */}
            <button
              onClick={() => setExpandedIdx(isOpen ? null : i)}
              className="w-full flex items-center gap-4 p-4 text-left hover:bg-slate-800/50 transition"
            >
              <div
                className={`shrink-0 w-10 h-10 rounded-xl border flex items-center justify-center text-sm font-bold ${scoreBg} ${scoreColor}`}
              >
                {avgScore}
              </div>
              <div className="flex-1 min-w-0">
                <p className="text-xs text-slate-500 mb-0.5">Question {i + 1}</p>
                <p className="text-sm text-slate-200 truncate">{ev.question}</p>
              </div>
              <svg
                className={`w-4 h-4 text-slate-500 shrink-0 transition-transform ${
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
              <div className="px-4 pb-4 space-y-4 border-t border-slate-800">
                {/* Question */}
                <div className="pt-3">
                  <p className="text-xs text-slate-500 font-medium mb-1 uppercase tracking-wide">
                    Question
                  </p>
                  <p className="text-sm text-slate-300 leading-relaxed">{ev.question}</p>
                </div>

                {/* Answer */}
                <div>
                  <p className="text-xs text-slate-500 font-medium mb-1 uppercase tracking-wide">
                    Your Answer
                  </p>
                  <p className="text-sm text-slate-400 leading-relaxed bg-slate-800/50 rounded-xl p-3">
                    {ev.answer || (
                      <span className="italic text-slate-600">No answer captured</span>
                    )}
                  </p>
                </div>

                {/* Score breakdown */}
                <div>
                  <p className="text-xs text-slate-500 font-medium mb-2 uppercase tracking-wide">
                    Score Breakdown
                  </p>
                  <div className="space-y-2">
                    <ScoreBar label="Relevance" score={ev.relevance} delay={0} />
                    <ScoreBar label="Structure (STAR)" score={ev.structure} delay={50} />
                    <ScoreBar label="Specificity" score={ev.specificity} delay={100} />
                    <ScoreBar label="Ownership" score={ev.ownership} delay={150} />
                    {ev.jdAlignment !== undefined && (
                      <ScoreBar label="JD Alignment" score={ev.jdAlignment} color="cyan" delay={200} />
                    )}
                  </div>
                </div>

                {/* Flags */}
                {ev.flags.length > 0 && (
                  <div className="flex flex-wrap gap-1.5">
                    {ev.flags.map((flag) => (
                      <span
                        key={flag}
                        className="px-2 py-0.5 bg-red-500/10 border border-red-500/20 rounded-full text-xs text-red-400"
                      >
                        {flag}
                      </span>
                    ))}
                  </div>
                )}

                {/* Low score suggestions */}
                {avgScore < 60 && (
                  <div className="bg-amber-950/20 border border-amber-500/10 rounded-xl p-3">
                    <p className="text-xs text-amber-400 font-medium mb-1">Suggestion</p>
                    <p className="text-xs text-amber-300/70">
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
                  <div className="border-t border-slate-800 pt-3">
                    <p className="text-xs text-slate-500 font-medium mb-2 uppercase tracking-wide">
                      Follow-up
                    </p>
                    {followUpEntries.map((fq, fi) => (
                      <div key={fi} className="mb-2">
                        <p className="text-xs text-indigo-400 mb-1">{fq.text}</p>
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
                            <p key={ai} className="text-xs text-slate-500 bg-slate-800/50 rounded-lg p-2">
                              {a.text}
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
