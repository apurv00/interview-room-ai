'use client'

import { useMemo } from 'react'
import LearningPlanSection from '@feedback/components/LearningPlanSection'
import IdealAnswerComparisonCard from '@feedback/components/IdealAnswerComparisonCard'
import type { FeedbackData, StoredInterviewData } from '@shared/types'
import { dimensionLabels } from '@shared/lib/answerSuggestion'

interface LearningTabProps {
  feedback: FeedbackData
  data: StoredInterviewData
  sessionId?: string
  /** Click handler for Q-chips inside drill descriptions and ideal-answer cards. */
  onQuestionClick?: (questionIndex: number) => void
  /** Highest valid question index for chip range guard (typically `data.evaluations.length - 1`). */
  maxQuestionIndex?: number
}

/** Stable id for each drill card so other tabs can deep-link / scrollIntoView. */
function drillRowId(idx: number): string {
  return `drill-${idx}`
}

interface DimensionStat {
  key: string
  label: string
  score: number
}

/** Mirrors the same per-question filter the rest of the redesigned feedback page uses.
 *  Session-level (aggregate) labels, domain-aware via config.interviewType — matches the
 *  Scores-tab Strongest/Weakest pills so the "what to fix" strip and the cards below agree. */
function computeDimensionStats(data: StoredInterviewData): DimensionStat[] {
  const evals = (data.evaluations || []).filter(
    (e) => (e as unknown as { status?: string }).status !== 'failed'
  )
  if (evals.length === 0) return []

  const labels = dimensionLabels(data.config?.interviewType)
  const dims: DimensionStat[] = (Object.keys(labels) as (keyof typeof labels)[]).map(
    (key) => ({
      key,
      label: labels[key],
      score: Math.round(
        evals.reduce((s, e) => s + ((e as unknown as Record<string, number>)[key] || 0), 0) /
          evals.length
      ),
    })
  )
  return dims
}

export default function LearningTab({
  feedback,
  data,
  sessionId,
  onQuestionClick,
  maxQuestionIndex,
}: LearningTabProps) {
  const idealAnswers = feedback.ideal_answers || []
  const hasIdealAnswers = idealAnswers.length > 0
  const hasDrills = (feedback.drill_recommendations || []).length > 0

  // Lookup helpers — original question text + user's verbatim answer per index.
  // Question text lookup prefers transcript (interviewer entries with matching
  // questionIndex); falls back to evaluations[i].question.
  const originalQuestionByIdx = useMemo(() => {
    const map = new Map<number, string>()
    for (const entry of data.transcript || []) {
      if (entry.speaker === 'interviewer' && entry.questionIndex != null) {
        if (!map.has(entry.questionIndex)) {
          map.set(entry.questionIndex, entry.text)
        }
      }
    }
    for (const ev of data.evaluations || []) {
      if (ev.questionIndex != null && !map.has(ev.questionIndex)) {
        map.set(ev.questionIndex, ev.question)
      }
    }
    return map
  }, [data.transcript, data.evaluations])

  const userAnswerByIdx = useMemo(() => {
    const map = new Map<number, string>()
    for (const ev of data.evaluations || []) {
      if (ev.questionIndex != null) map.set(ev.questionIndex, ev.answer)
    }
    return map
  }, [data.evaluations])

  const evalByIdx = useMemo(() => {
    const map = new Map<number, (typeof data.evaluations)[number]>()
    for (const ev of data.evaluations || []) {
      if (ev.questionIndex != null) map.set(ev.questionIndex, ev)
    }
    return map
  }, [data.evaluations])

  // "What to fix, prioritized" header strip — surface the 1–2 weakest
  // dimensions across answered questions so the drills below have anchor.
  const weakestDimensions = useMemo(() => {
    const dims = computeDimensionStats(data)
    return [...dims].sort((a, b) => a.score - b.score).slice(0, 2)
  }, [data])

  return (
    <div className="space-y-6 animate-fade-in">
      {/* Header strip — anchors the rest of the tab */}
      {weakestDimensions.length > 0 && (
        <section className="surface-card-bordered p-4 sm:p-5">
          <p className="text-caption text-[#71767b] uppercase tracking-wide font-medium mb-2">
            What to fix, prioritized
          </p>
          <p className="text-body text-[#0f1419]">
            Your weakest dimensions:{' '}
            {weakestDimensions.map((d, i) => (
              <span key={d.key}>
                {i > 0 && ' · '}
                <span className="font-semibold">
                  {d.label} ({d.score})
                </span>
              </span>
            ))}
            . The drills below target these gaps.
          </p>
        </section>
      )}

      {/* Per-question deep dives — original Q + user answer + score breakdown + strong outline */}
      {hasIdealAnswers && (
        <section className="space-y-4">
          <h3 className="text-subheading text-[#536471]">Per-question deep-dives</h3>
          {idealAnswers.map((ideal) => (
            <IdealAnswerComparisonCard
              key={ideal.questionIndex}
              ideal={ideal}
              originalQuestion={originalQuestionByIdx.get(ideal.questionIndex) || ''}
              userAnswer={userAnswerByIdx.get(ideal.questionIndex) || ''}
              evaluation={evalByIdx.get(ideal.questionIndex) || null}
              interviewType={data.config?.interviewType}
            />
          ))}
        </section>
      )}

      {/* Drills + pathway CTA — reuse LearningPlanSection but skip its own ideal_answers
          block (we render the richer IdealAnswerComparisonCard above). */}
      {(hasDrills || !hasIdealAnswers) && (
        <LearningPlanSection
          feedback={feedback}
          sessionId={sessionId}
          hideIdealAnswers
          onQuestionClick={onQuestionClick}
          maxQuestionIndex={maxQuestionIndex}
          drillRowId={drillRowId}
        />
      )}
    </div>
  )
}
