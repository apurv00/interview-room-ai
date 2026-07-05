'use client'

import { useMemo, useState } from 'react'
import { ScoreBar } from '@shared/ui/ScoreBar'
import type { TranscriptEntry, AnswerEvaluation } from '@shared/types'
import { answerSuggestion, dimensionLabels, resolveEvalDepthSlug } from '@shared/lib/answerSuggestion'

// Safe string coerce to prevent React #310
function s(v: unknown): string {
  if (v === null || v === undefined) return ''
  if (typeof v === 'object') return JSON.stringify(v)
  return String(v)
}

export type QuestionBreakdownSortOrder = 'index' | 'asc' | 'desc'

interface QuestionBreakdownProps {
  transcript: TranscriptEntry[]
  evaluations: AnswerEvaluation[]
  /** Iteration order. 'index' = interview order (default), 'asc' = lowest score first, 'desc' = highest first. */
  sortOrder?: QuestionBreakdownSortOrder
  /**
   * Optional controlled-mode expansion. When provided, the component does not
   * own expansion state — parent does. Lets ScoresTab drive expansion from
   * heatmap-cell clicks. Keys are the ORIGINAL evaluation index (the `i` in
   * the unsorted array), so heatmap-row → accordion-row mapping is stable
   * across sort changes.
   */
  expandedIdx?: number | null
  onExpandedChange?: (idx: number | null) => void
  /**
   * Session interview-type slug (config.interviewType). Drives domain-aware
   * dimension labels (e.g. "Code Quality" vs "Structure (STAR)") and the
   * per-answer suggestion copy. Omitted → behavioral-family defaults.
   */
  interviewType?: string
}

function dimensionBandClass(score: number): string {
  if (score >= 75) return 'bg-emerald-500'
  if (score >= 55) return 'bg-amber-500'
  return 'bg-red-500'
}

interface MiniDimension {
  key: string
  label: string
  score: number
}

function buildMiniStrip(ev: AnswerEvaluation, interviewType?: string): MiniDimension[] {
  const labels = dimensionLabels(interviewType)
  const dims: MiniDimension[] = [
    { key: 'relevance', label: labels.relevance, score: ev.relevance },
    { key: 'structure', label: labels.structure, score: ev.structure },
    { key: 'specificity', label: labels.specificity, score: ev.specificity },
    { key: 'ownership', label: labels.ownership, score: ev.ownership },
  ]
  if (ev.jdAlignment != null) {
    dims.push({ key: 'jdAlignment', label: 'JD Alignment', score: ev.jdAlignment })
  }
  return dims
}

export default function QuestionBreakdown({
  transcript,
  evaluations,
  sortOrder = 'index',
  expandedIdx: controlledExpandedIdx,
  onExpandedChange,
  interviewType,
}: QuestionBreakdownProps) {
  const [uncontrolledExpandedIdx, setUncontrolledExpandedIdx] = useState<number | null>(null)
  const isControlled = controlledExpandedIdx !== undefined
  const expandedIdx = isControlled ? controlledExpandedIdx : uncontrolledExpandedIdx
  const setExpandedIdx = (next: number | null) => {
    if (isControlled) {
      onExpandedChange?.(next)
    } else {
      setUncontrolledExpandedIdx(next)
      onExpandedChange?.(next)
    }
  }

  // Sort while preserving the original index (so heatmap → accordion mapping
  // and the visible question numbering stay consistent across sort changes).
  const orderedEvaluations = useMemo(() => {
    const indexed = evaluations.map((ev, originalIdx) => ({ ev, originalIdx }))
    if (sortOrder === 'index') return indexed
    const score = (ev: AnswerEvaluation) =>
      (ev as unknown as { status?: string }).status === 'failed'
        ? -1 // surface failed at the bottom of asc OR top of desc consistently
        : Math.round((ev.relevance + ev.structure + ev.specificity + ev.ownership) / 4)
    return [...indexed].sort((a, b) =>
      sortOrder === 'asc' ? score(a.ev) - score(b.ev) : score(b.ev) - score(a.ev)
    )
  }, [evaluations, sortOrder])

  if (evaluations.length === 0) {
    return (
      <div className="text-center py-10 text-[#8b98a5] text-sm">
        No per-question evaluations available.
      </div>
    )
  }

  return (
    <div className="space-y-3">
      {orderedEvaluations.map(({ ev, originalIdx }) => {
        const i = originalIdx
        // status='failed' = client never received a real evaluation (timeout /
        // non-OK from useInterviewAPI). The 50/50/50/50 fallback exists only so
        // type contracts hold; surfacing it as a real score is misleading.
        const isFailed = (ev as unknown as { status?: string }).status === 'failed'
        const avgScore = Math.round(
          (ev.relevance + ev.structure + ev.specificity + ev.ownership) / 4
        )
        const isOpen = expandedIdx === i
        // Resolve the family from the depth this ROW was actually evaluated with,
        // not the session slug: academics warm-ups (Q0/Q1) are scored with the
        // behavioral rubric (resolveEvalDepthSlug), so their four slots mean
        // behavioral Structure/Specificity/Ownership — not Conceptual Depth /
        // Derivation / Breadth. Labelling/advising them as academic would be
        // misleading (Codex P2 on #496).
        const rowType = resolveEvalDepthSlug(interviewType ?? '', ev.questionIndex)
        const miniStrip = buildMiniStrip(ev, rowType)
        const dimLabels = dimensionLabels(rowType)
        // Weakest-dimension + domain-aware coaching tip (null when avg ≥ 60).
        const suggestion = isFailed ? null : answerSuggestion(ev, rowType)
        const scoreColor = isFailed
          ? 'text-[#71767b]'
          : avgScore >= 75 ? 'text-[#059669]' : avgScore >= 55 ? 'text-amber-600' : 'text-red-500'
        const scoreBg = isFailed
          ? 'bg-[#f1f5f9] border-[#e1e8ed]'
          : avgScore >= 75
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
            data-question-idx={i}
            className="bg-white border border-[#e1e8ed] rounded-2xl overflow-hidden transition-all scroll-mt-[180px]"
          >
            {/* Header — always visible */}
            <button
              onClick={() => setExpandedIdx(isOpen ? null : i)}
              className="w-full flex items-center gap-3 sm:gap-4 p-3 sm:p-4 text-left hover:bg-[#f8fafc] transition"
            >
              <div
                className={`shrink-0 w-11 h-11 sm:w-10 sm:h-10 rounded-xl border flex items-center justify-center text-xs font-bold ${scoreBg} ${scoreColor}`}
                title={isFailed ? 'Could not score — model timed out or returned a non-OK response' : undefined}
              >
                {isFailed ? '—' : avgScore}
              </div>
              {/* Mini dimension strip — at-a-glance which dimension dragged this question down */}
              {!isFailed && (
                <div
                  className="shrink-0 hidden sm:flex items-end gap-0.5 h-7"
                  aria-label="Per-dimension scores"
                >
                  {miniStrip.map((d) => {
                    const h = Math.max(4, Math.round((d.score / 100) * 28))
                    return (
                      <span
                        key={d.key}
                        className={`w-1 rounded-sm ${dimensionBandClass(d.score)}`}
                        style={{ height: `${h}px` }}
                        title={`${d.label}: ${d.score}`}
                      />
                    )
                  })}
                </div>
              )}
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
                  {isFailed ? (
                    <div className="bg-[#f8fafc] border border-[#e1e8ed] rounded-xl p-3">
                      <p className="text-xs text-[#71767b]">
                        Could not score this answer — the model timed out or returned a non-OK response.
                        This question is excluded from your overall and dimension averages.
                      </p>
                    </div>
                  ) : (
                    <div className="space-y-2">
                      <ScoreBar label={dimLabels.relevance} score={ev.relevance} delay={0} />
                      <ScoreBar label={dimLabels.structure} score={ev.structure} delay={50} />
                      <ScoreBar label={dimLabels.specificity} score={ev.specificity} delay={100} />
                      <ScoreBar label={dimLabels.ownership} score={ev.ownership} delay={150} />
                      {ev.jdAlignment != null && (
                        <ScoreBar label="JD Alignment" score={ev.jdAlignment} color="cyan" delay={200} />
                      )}
                    </div>
                  )}
                </div>

                {/* Flags */}
                {(ev.flags?.length ?? 0) > 0 && (
                  <div className="flex flex-wrap gap-1.5">
                    {ev.flags!.map((flag, fi) => (
                      <span
                        key={fi}
                        className="px-2 py-0.5 bg-red-500/10 border border-red-500/20 rounded-full text-xs text-red-400"
                      >
                        {s(flag)}
                      </span>
                    ))}
                  </div>
                )}

                {/* Weakest-dimension + domain-aware coaching tip (see shared/lib/answerSuggestion). */}
                {suggestion && (
                  <div className="bg-amber-50 border border-amber-200 rounded-xl p-3">
                    <p className="text-xs text-amber-700 font-medium mb-1">Suggestion</p>
                    <p className="text-xs text-amber-600">{suggestion}</p>
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
