'use client'

import { Lightbulb } from 'lucide-react'
// eslint-disable-next-line no-restricted-imports -- direct import: the
// @interview barrel transitively pulls server-only modules (Redis,
// modelRouter, etc.) into this client component.
import { deriveCoachingTip } from '@interview/config/coachingTips'
// eslint-disable-next-line no-restricted-imports -- same reason.
import type { AnswerEvaluation } from '@shared/types'
import { resolveEvalDepthSlug } from '@shared/lib/answerSuggestion'

/**
 * QuestionInsightStrip — coach hint shown above the drill textarea
 * when the source session does NOT have `feedback.ideal_answers` for
 * this question (older sessions, generation failure, etc.).
 *
 * Pathway P2 Wave 5 (feature 5B, fallback path). The primary path uses
 * `IdealAnswerComparisonCard` from feedback components — far richer
 * (strongAnswer + keyElements + dimension bars). This strip is the
 * thinner one-sentence-coach-tip surface for sessions that pre-date
 * `ideal_answers` generation or where generation failed.
 *
 * Self-hides when:
 *   - We have no scores (can't synthesize an AnswerEvaluation for
 *     `deriveCoachingTip`)
 *   - `deriveCoachingTip` returns the generic placeholder (means we
 *     couldn't compute a meaningful tip — better to show nothing than
 *     a banal one)
 */
export default function QuestionInsightStrip({
  question,
  questionIndex,
  scores,
  primaryGap,
  domain,
  interviewType,
}: {
  question: string
  questionIndex: number
  scores: {
    relevance: number
    structure: number
    specificity: number
    ownership: number
  } | null
  primaryGap: string | null
  domain: string | null
  interviewType: string | null
}) {
  if (!scores) return null

  // Synthesize the minimum AnswerEvaluation shape the tip generator
  // needs. We use empty strings for `answer` because the tip generator
  // only reads the 4 dim scores + primaryGap (verified by reading
  // coachingTips.ts:51-onwards).
  const evaluation: AnswerEvaluation = {
    questionIndex,
    question,
    answer: '',
    relevance: scores.relevance,
    structure: scores.structure,
    specificity: scores.specificity,
    ownership: scores.ownership,
  }

  // Academics warm-ups (Q0/Q1) are scored with the behavioral rubric — resolve the
  // eval depth per-row so the coaching tip matches what QuestionBreakdown shows for
  // that answer, not the session slug (#496 per-row rule).
  const evalDepth = resolveEvalDepthSlug(interviewType ?? '', questionIndex)
  const tip = deriveCoachingTip(
    evaluation,
    domain ?? undefined,
    evalDepth || undefined,
    primaryGap ?? undefined,
  )

  // Hide on the generic-fallback tip — `deriveCoachingTip` returns
  // GENERIC_TIP ("Keep going — you are doing well.") when scores are
  // invalid or no rule matched. Better to show nothing than a banal
  // congratulation on a drill page (the user is here BECAUSE they
  // scored poorly).
  if (!tip || tip === 'Keep going — you are doing well.') {
    return null
  }

  return (
    <section
      data-testid="question-insight-strip"
      aria-label="Coach hint for this drill question"
      className="rounded-xl border border-amber-200/80 bg-amber-50/40 p-3 flex items-start gap-2.5"
    >
      <span
        className="shrink-0 w-7 h-7 rounded-full flex items-center justify-center bg-amber-100 text-amber-700"
        aria-hidden="true"
      >
        <Lightbulb className="w-3.5 h-3.5" />
      </span>
      <div className="min-w-0 flex-1">
        <p className="text-[10px] uppercase tracking-[0.12em] font-semibold text-amber-700 mb-0.5">
          Coach hint{primaryGap ? ` · focus on ${primaryGap}` : ''}
        </p>
        <p className="text-xs text-[#0f1419] leading-relaxed">{tip}</p>
      </div>
    </section>
  )
}
