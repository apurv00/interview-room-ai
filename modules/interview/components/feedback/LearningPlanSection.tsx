'use client'

import Link from 'next/link'
import { BookOpen, Target, CheckCircle2, ArrowRight } from 'lucide-react'
import type { FeedbackData } from '@shared/types'

interface LearningPlanSectionProps {
  feedback: FeedbackData
}

export default function LearningPlanSection({ feedback }: LearningPlanSectionProps) {
  const { drill_recommendations, ideal_answers } = feedback
  const hasDrills = drill_recommendations && drill_recommendations.length > 0
  const hasIdealAnswers = ideal_answers && ideal_answers.length > 0

  if (!hasDrills && !hasIdealAnswers) return null

  return (
    <div className="space-y-6">
      <div className="flex items-center gap-2">
        <BookOpen className="w-5 h-5 text-brand-500" />
        <h3 className="text-heading text-[#0f1419]">Learning &amp; Development</h3>
      </div>

      {/* Drill Recommendations */}
      {hasDrills && (
        <div className="space-y-3">
          <h4 className="text-subheading text-[#536471]">Targeted Practice Drills</h4>
          {drill_recommendations.map((drill, i) => (
            <div
              key={i}
              className="surface-card-bordered p-5 space-y-3"
            >
              <div className="flex items-start gap-3">
                <Target className="w-5 h-5 text-brand-500 mt-0.5 shrink-0" />
                <div className="min-w-0">
                  <p className="text-sm font-semibold text-[#0f1419]">{drill.skillArea}</p>
                  <p className="text-body text-[#71767b] mt-1">{drill.description}</p>
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
          ))}
        </div>
      )}

      {/* Ideal Answer Outlines */}
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

      {/* Link to full pathway */}
      <Link
        href="/learn/pathway"
        className="flex items-center justify-between p-4 rounded-xl bg-brand-500/5 border border-brand-500/15 hover:bg-brand-500/10 transition-colors group"
      >
        <div>
          <p className="text-sm font-medium text-[#0f1419]">View Full Learning Pathway</p>
          <p className="text-caption text-[#71767b] mt-0.5">See your personalized practice plan and track progress</p>
        </div>
        <ArrowRight className="w-5 h-5 text-brand-500 group-hover:translate-x-0.5 transition-transform shrink-0" />
      </Link>
    </div>
  )
}
