'use client'

import Link from 'next/link'
import { BookOpen, Target, CheckCircle2, ArrowRight } from 'lucide-react'
import type { FeedbackData } from '@shared/types'
import TextWithQuestionChips from '@feedback/components/TextWithQuestionChips'
import QuestionRefChip from '@feedback/components/QuestionRefChip'
// eslint-disable-next-line no-restricted-imports -- direct import required: the @interview barrel transitively pulls server-only Redis (ioredis → dns/net) into this client component.
import { parseQuestionRefs } from '@interview/utils/parseQuestionRefs'

interface LearningPlanSectionProps {
  feedback: FeedbackData
  sessionId?: string
  /** When true, the "Ideal Answer Outlines" block is suppressed — caller is
   *  rendering richer IdealAnswerComparisonCards above (LearningTab does this). */
  hideIdealAnswers?: boolean
  /** Click handler for Q-chips parsed out of drill descriptions. */
  onQuestionClick?: (questionIndex: number) => void
  /** Highest valid question index for Q-chip range validation. */
  maxQuestionIndex?: number
  /** Optional — assigns id="drill-<idx>" to each drill card so other components
   *  (e.g. CoachingPanel "Practice this →") can scrollIntoView the matching one. */
  drillRowId?: (drillIndex: number) => string
}

export default function LearningPlanSection({
  feedback,
  sessionId,
  hideIdealAnswers,
  onQuestionClick,
  maxQuestionIndex,
  drillRowId,
}: LearningPlanSectionProps) {
  const { drill_recommendations, ideal_answers } = feedback
  const hasDrills = drill_recommendations && drill_recommendations.length > 0
  const hasIdealAnswers = !hideIdealAnswers && ideal_answers && ideal_answers.length > 0
  const pathwayOutcome = feedback.sideEffectOutcomes?.find((outcome) => outcome.name === 'pathwayPlan')
  const canTrackFeedbackUpdate = !!sessionId && sessionId !== 'local'
  const pathwayHref = canTrackFeedbackUpdate ? `/learn/pathway?fromFeedback=${encodeURIComponent(sessionId)}` : '/learn/pathway'
  const pathwayCopy = (() => {
    if (pathwayOutcome?.status === 'scheduled') {
      return { title: 'Your pathway update is queued', description: 'Open Pathway to see the current plan while the latest interview update catches up.' }
    }
    if (pathwayOutcome?.status === 'skipped') {
      return { title: 'Pathway update unavailable', description: 'This feedback did not create a new pathway update. You can still continue from the current plan.' }
    }
    return { title: 'Continue from your pathway', description: 'Personalized milestones, drills, and your next recommended session — all in one place.' }
  })()

  if (!hasDrills && !hasIdealAnswers) return null

  return (
    <div className="space-y-6">
      <div className="flex items-center gap-2">
        <BookOpen className="w-5 h-5 text-brand-500" />
        <h3 className="text-heading text-[#0f1419]">Learning &amp; Development</h3>
      </div>

      <Link
        href={pathwayHref}
        className="flex items-center justify-between p-4 rounded-xl bg-gradient-to-r from-brand-500/10 to-blue-500/10 border border-brand-500/20 hover:from-brand-500/15 hover:to-blue-500/15 transition-colors group"
      >
        <div className="min-w-0">
          <p className="text-sm font-semibold text-[#0f1419]">{pathwayCopy.title}</p>
          <p className="text-caption text-[#536471] mt-0.5">{pathwayCopy.description}</p>
        </div>
        <ArrowRight className="w-5 h-5 text-brand-500 group-hover:translate-x-0.5 transition-transform shrink-0" />
      </Link>

      {hasDrills && (
        <div className="space-y-3">
          <h4 className="text-subheading text-[#536471]">Targeted Practice Drills</h4>
          {drill_recommendations.map((drill, i) => {
            // Phase B (2026-05-16): prefer the structured `targetQuestions`
            // field. Falls back to Phase A's regex parse of `Q\d+` tokens
            // in the prose description for old DB rows that pre-date Phase B.
            const drillQuestionIndices =
              drill.targetQuestions && drill.targetQuestions.length > 0
                ? drill.targetQuestions
                : parseQuestionRefs(drill.description)
            return (
              <div
                key={i}
                id={drillRowId ? drillRowId(i) : undefined}
                className="surface-card-bordered p-5 space-y-3 scroll-mt-[180px]"
              >
                <div className="flex items-start gap-3">
                  <Target className="w-5 h-5 text-brand-500 mt-0.5 shrink-0" />
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center justify-between gap-2 flex-wrap">
                      <p className="text-sm font-semibold text-[#0f1419]">{drill.skillArea}</p>
                      {drillQuestionIndices.length > 0 && (
                        <div className="flex items-center gap-1 flex-wrap">
                          <span className="text-[10px] uppercase tracking-wide text-[#71767b] font-medium">
                            For
                          </span>
                          {drillQuestionIndices.slice(0, 3).map((qIdx) => (
                            <QuestionRefChip
                              key={qIdx}
                              questionIndex={qIdx}
                              maxQuestionIndex={maxQuestionIndex}
                              onClick={onQuestionClick}
                              tone="accent"
                            />
                          ))}
                        </div>
                      )}
                    </div>
                    <p className="text-body text-[#71767b] mt-1 leading-relaxed">
                      <TextWithQuestionChips
                        text={drill.description}
                        onQuestionClick={onQuestionClick}
                        maxQuestionIndex={maxQuestionIndex}
                      />
                    </p>
                  </div>
                </div>
                {drill.practiceQuestions.length > 0 && (
                  <div className="ml-8 space-y-2">
                    <p className="text-caption text-[#8b98a5] uppercase tracking-wide font-medium">Practice Questions</p>
                    {drill.practiceQuestions.map((q, j) => (
                      <div key={j} className="flex items-start gap-2 p-3 rounded-lg bg-[#f8fafc] border border-[#eff3f4]">
                        <span className="text-brand-500 mt-0.5 shrink-0 text-xs font-mono">{j + 1}.</span>
                        <p className="text-sm text-[#0f1419] leading-relaxed">&ldquo;{q}&rdquo;</p>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            )
          })}
        </div>
      )}

      {hasIdealAnswers && (
        <div className="space-y-3">
          <h4 className="text-subheading text-[#536471]">Ideal Answer Outlines</h4>
          {ideal_answers.map((answer, i) => (
            <div
              key={i}
              className="surface-card-bordered p-5 space-y-3"
            >
              <p className="text-sm font-semibold text-[#0f1419]">
                Q{answer.questionIndex + 1} — What a strong answer includes
              </p>
              <p className="text-body text-[#536471] leading-relaxed">{answer.strongAnswer}</p>
              {answer.keyElements.length > 0 && (
                <div className="flex flex-wrap gap-2 mt-2">
                  {answer.keyElements.map((el, j) => (
                    <span
                      key={j}
                      className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-emerald-50 border border-emerald-200 text-xs text-emerald-700"
                    >
                      <CheckCircle2 className="w-3.5 h-3.5" />
                      {el}
                    </span>
                  ))}
                </div>
              )}
            </div>
          ))}
        </div>
      )}

    </div>
  )
}
