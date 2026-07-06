'use client'

import { useState, type ReactNode } from 'react'
import type { AnswerEvaluation } from '@shared/types'
import { dimensionLabels, suggestionFamily, resolveEvalDepthSlug } from '@shared/lib/answerSuggestion'

interface IdealAnswer {
  questionIndex: number
  strongAnswer: string
  keyElements: string[]
}

interface IdealAnswerComparisonCardProps {
  ideal: IdealAnswer
  /** Original interview question text (looked up by questionIndex from data.transcript or evaluations) */
  originalQuestion: string
  /** Verbatim user answer (from data.evaluations[questionIndex].answer) */
  userAnswer: string
  /** Per-question dimension scores. Drives the mini scorecard + the why-it-scored-low prose. */
  evaluation?: AnswerEvaluation | null
  /** Optional CTA — show "Practice this →" button when a matching drill exists. */
  practiceLinkLabel?: string
  onPracticeClick?: () => void
  /** Session interview-type slug — domain-aware dimension labels + why-it-scored-low prose. */
  interviewType?: string
}

function bandClass(score: number): string {
  if (score >= 75) return 'bg-emerald-500'
  if (score >= 55) return 'bg-amber-500'
  return 'bg-red-500'
}

interface DimRow {
  key: string
  label: string
  score: number
}

function buildDims(ev: AnswerEvaluation | null | undefined, interviewType?: string): DimRow[] {
  if (!ev) return []
  const labels = dimensionLabels(interviewType)
  const rows: DimRow[] = [
    { key: 'relevance', label: labels.relevance, score: ev.relevance },
    { key: 'structure', label: labels.structure, score: ev.structure },
    { key: 'specificity', label: labels.specificity, score: ev.specificity },
    { key: 'ownership', label: labels.ownership, score: ev.ownership },
  ]
  if (ev.jdAlignment != null) {
    rows.push({ key: 'jdAlignment', label: 'JD Alignment', score: ev.jdAlignment })
  }
  return rows
}

/**
 * Concrete "why it scored low" derivation from per-dimension scores. Pure
 * presentational synthesis — no LLM call. Picks at most 2 weakest dimensions
 * (<60) and emits a one-liner per dimension explaining what the user can fix.
 */
function buildWhyItScoredLow(dims: DimRow[], interviewType?: string): ReactNode {
  const weak = dims.filter((d) => d.score < 60).sort((a, b) => a.score - b.score).slice(0, 2)
  if (weak.length === 0) return null

  // The per-dimension prose below is behavioral-specific (STAR, "we"/passive). For
  // coding/system-design/academics the four slots are re-mapped (structure =
  // code_quality, etc.), so that prose would contradict the domain label — emit a
  // neutral line there and let the (domain-aware) label carry the meaning.
  const behavioral = suggestionFamily(interviewType) === 'behavioral'

  const lines = weak.map((d) => {
    if (!behavioral) {
      return `${d.label} (${d.score}) — one of your lowest-scoring areas here; see the scorecard above.`
    }
    switch (d.key) {
      case 'specificity':
        return `${d.label} (${d.score}) — answer lacked metrics, dates, or concrete examples.`
      case 'structure':
        return `${d.label} (${d.score}) — STAR framework not followed; situation/task/action/result not all visible.`
      case 'ownership':
        return `${d.label} (${d.score}) — used "we" / passive framing; personal contribution unclear.`
      case 'relevance':
        return `${d.label} (${d.score}) — answer drifted from what the question actually asked.`
      case 'jdAlignment':
        return `${d.label} (${d.score}) — answer didn't connect to the role's requirements.`
      default:
        return `${d.label} (${d.score}) — see scorecard above.`
    }
  })

  return (
    <ul className="text-sm text-[#536471] leading-relaxed space-y-1 list-disc list-outside ml-5">
      {lines.map((line, i) => (
        <li key={i}>{line}</li>
      ))}
    </ul>
  )
}

export default function IdealAnswerComparisonCard({
  ideal,
  originalQuestion,
  userAnswer,
  evaluation,
  practiceLinkLabel,
  onPracticeClick,
  interviewType,
}: IdealAnswerComparisonCardProps) {
  // The user's answer can be long — collapse by default if >300 chars to avoid
  // a wall-of-text. Strong outline + key elements stay always visible (they're
  // the primary value of this card).
  const [answerExpanded, setAnswerExpanded] = useState(false)
  const ANSWER_PREVIEW_LIMIT = 280
  const answerNeedsCollapse = userAnswer.length > ANSWER_PREVIEW_LIMIT
  const answerVisible = answerExpanded || !answerNeedsCollapse
    ? userAnswer
    : userAnswer.slice(0, ANSWER_PREVIEW_LIMIT).trimEnd() + '…'

  // Resolve the family from the depth THIS question was evaluated with, not the
  // session slug — academics warm-ups (Q0/Q1) are scored behavioral, so their
  // labels/prose must be behavioral too (matches QuestionBreakdown, #496).
  const rowType = resolveEvalDepthSlug(
    interviewType ?? '',
    evaluation?.questionIndex ?? ideal.questionIndex,
  )
  const dims = buildDims(evaluation, rowType)
  const whyContent = buildWhyItScoredLow(dims, rowType)
  const avgScore = dims.length > 0
    ? Math.round(dims.reduce((s, d) => s + d.score, 0) / dims.length)
    : null

  return (
    <article
      className="surface-card-bordered p-5 sm:p-6 space-y-5"
      data-question-idx={ideal.questionIndex}
    >
      {/* Header: Q-label + avg score */}
      <header className="flex items-baseline justify-between gap-3">
        <h3 className="text-subheading text-[#0f1419]">
          <span className="font-mono text-brand-500 mr-2">Q{ideal.questionIndex + 1}</span>
          {originalQuestion || '(question text unavailable)'}
        </h3>
        {avgScore != null && (
          <span
            className={`shrink-0 text-xs font-bold px-2 py-1 rounded-md border ${
              avgScore >= 75
                ? 'bg-emerald-500/10 border-emerald-500/30 text-emerald-700'
                : avgScore >= 55
                ? 'bg-amber-500/10 border-amber-500/30 text-amber-700'
                : 'bg-red-500/10 border-red-500/30 text-red-700'
            }`}
            title="Average across the 4–5 scoring dimensions"
          >
            {avgScore}/100
          </span>
        )}
      </header>

      {/* User's actual answer */}
      {userAnswer && (
        <section>
          <p className="text-caption text-[#71767b] uppercase tracking-wide font-medium mb-1.5">
            Your answer
          </p>
          <p className="text-body text-[#0f1419] leading-relaxed bg-[#f8fafc] rounded-xl p-3 whitespace-pre-line">
            {answerVisible}
          </p>
          {answerNeedsCollapse && (
            <button
              type="button"
              onClick={() => setAnswerExpanded((v) => !v)}
              className="mt-1.5 text-xs text-brand-500 hover:underline"
            >
              {answerExpanded ? 'Show less' : 'Show full answer'}
            </button>
          )}
        </section>
      )}

      {/* Mini dimension strip + why-it-scored-low */}
      {dims.length > 0 && (
        <section>
          <p className="text-caption text-[#71767b] uppercase tracking-wide font-medium mb-2">
            Score breakdown
          </p>
          <div className="space-y-1.5">
            {dims.map((d) => (
              <div key={d.key} className="flex items-center gap-3">
                <span className="text-xs text-[#536471] w-24 shrink-0">{d.label}</span>
                <div className="flex-1 h-1.5 bg-[#f1f5f9] rounded-full overflow-hidden">
                  <div
                    className={`h-full ${bandClass(d.score)}`}
                    style={{ width: `${Math.max(0, Math.min(100, d.score))}%` }}
                  />
                </div>
                <span className="text-xs font-bold text-[#0f1419] w-8 text-right">{d.score}</span>
              </div>
            ))}
          </div>
          {whyContent && (
            <div className="mt-3">
              <p className="text-caption text-[#71767b] uppercase tracking-wide font-medium mb-1">
                Why it scored low
              </p>
              {whyContent}
            </div>
          )}
        </section>
      )}

      {/* Example strong answer */}
      {ideal.strongAnswer && (
        <section>
          <p className="text-caption text-[#71767b] uppercase tracking-wide font-medium mb-1.5">
            Example strong answer
          </p>
          <p className="text-body text-[#0f1419] leading-relaxed bg-emerald-50 border border-emerald-200 rounded-xl p-3 whitespace-pre-line">
            {ideal.strongAnswer}
          </p>
        </section>
      )}

      {/* What to include — key elements that make a strong answer */}
      {ideal.keyElements && ideal.keyElements.length > 0 && (
        <section>
          <p className="text-caption text-[#71767b] uppercase tracking-wide font-medium mb-2">
            What to include
          </p>
          <div className="flex flex-wrap gap-1.5">
            {ideal.keyElements.map((el, i) => (
              <span
                key={i}
                className="px-2.5 py-1 bg-[#f1f5f9] border border-[#e1e8ed] rounded-full text-xs text-[#0f1419]"
              >
                {el}
              </span>
            ))}
          </div>
        </section>
      )}

      {/* Practice CTA — only when caller can route to a matching drill */}
      {onPracticeClick && practiceLinkLabel && (
        <div className="pt-2 border-t border-[#e1e8ed]">
          <button
            type="button"
            onClick={onPracticeClick}
            className="text-sm font-medium text-brand-500 hover:underline inline-flex items-center gap-1"
          >
            {practiceLinkLabel} →
          </button>
        </div>
      )}
    </article>
  )
}
