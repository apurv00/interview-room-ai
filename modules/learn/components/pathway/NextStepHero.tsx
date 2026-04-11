'use client'

import Link from 'next/link'
import { Play, Target, Sparkles, ArrowRight } from 'lucide-react'
import { motion } from 'framer-motion'

interface PracticeTask {
  taskId: string
  type: 'drill' | 'full_session' | 'review' | 'homework'
  title: string
  description: string
  targetCompetency: string
  difficulty: 'easy' | 'medium' | 'hard'
  estimatedMinutes: number
  completed: boolean
}

interface NextStepHeroProps {
  practiceTasks: PracticeTask[]
  nextSessionRecommendation: {
    domain?: string
    interviewType?: string
    focusCompetencies?: string[]
    difficulty?: string
    reason?: string
  } | null
  readinessScore: number
  onStartInterview: () => void
}

/**
 * "Your next step" hero pinned above the readiness gauge on /learn/pathway.
 *
 * Priority cascade:
 *   1. If there's a next-session recommendation, surface it as the primary
 *      action ("Run your next mock"). This is the strongest habit-loop
 *      signal — the planner has already named the exact mock to practice.
 *   2. Else show the first uncompleted practice task (drill or otherwise)
 *      with a direct deep-link if it's a drill.
 *   3. Else (everything done, high score): encourage harder practice.
 */
export default function NextStepHero({
  practiceTasks,
  nextSessionRecommendation,
  readinessScore,
  onStartInterview,
}: NextStepHeroProps) {
  const firstUncompleted = practiceTasks.find((t) => !t.completed)
  const hasRecommendation = !!nextSessionRecommendation?.reason

  // Priority 1: next-session recommendation
  if (hasRecommendation) {
    return (
      <motion.section
        className="surface-card-bordered p-5 sm:p-6 bg-gradient-to-br from-blue-50 to-indigo-50 border-blue-200"
        initial={{ opacity: 0, y: -8 }}
        animate={{ opacity: 1, y: 0 }}
      >
        <div className="flex items-start gap-4">
          <div className="shrink-0 w-10 h-10 rounded-xl bg-blue-600 flex items-center justify-center shadow-sm shadow-blue-600/20">
            <Play className="w-5 h-5 text-white" fill="white" />
          </div>
          <div className="flex-1 min-w-0">
            <div className="text-[11px] uppercase tracking-wide text-blue-600 font-semibold mb-1">
              Your next step
            </div>
            <h2 className="text-lg font-semibold text-[#0f1419]">Run your next mock interview</h2>
            <p className="text-sm text-[#536471] mt-1">{nextSessionRecommendation!.reason}</p>
            {(nextSessionRecommendation?.focusCompetencies?.length ?? 0) > 0 && (
              <div className="flex flex-wrap gap-1.5 mt-3">
                {nextSessionRecommendation!.focusCompetencies!.slice(0, 3).map((c) => (
                  <span
                    key={c}
                    className="text-[11px] px-2 py-0.5 rounded-full bg-blue-100 text-blue-700 capitalize"
                  >
                    {c.replace(/_/g, ' ')}
                  </span>
                ))}
              </div>
            )}
          </div>
          <button
            type="button"
            onClick={onStartInterview}
            className="shrink-0 inline-flex items-center gap-1.5 px-4 py-2.5 bg-blue-600 hover:bg-blue-700 text-white text-sm font-semibold rounded-lg shadow-sm shadow-blue-600/20 transition-colors"
          >
            Start <ArrowRight className="w-4 h-4" />
          </button>
        </div>
      </motion.section>
    )
  }

  // Priority 2: first uncompleted practice task
  if (firstUncompleted) {
    const isDrill = firstUncompleted.type === 'drill'
    return (
      <motion.section
        className="surface-card-bordered p-5 sm:p-6 bg-gradient-to-br from-amber-50 to-orange-50 border-amber-200"
        initial={{ opacity: 0, y: -8 }}
        animate={{ opacity: 1, y: 0 }}
      >
        <div className="flex items-start gap-4">
          <div className="shrink-0 w-10 h-10 rounded-xl bg-amber-600 flex items-center justify-center shadow-sm shadow-amber-600/20">
            <Target className="w-5 h-5 text-white" />
          </div>
          <div className="flex-1 min-w-0">
            <div className="text-[11px] uppercase tracking-wide text-amber-700 font-semibold mb-1">
              Your next step
            </div>
            <h2 className="text-lg font-semibold text-[#0f1419]">{firstUncompleted.title}</h2>
            {firstUncompleted.description && (
              <p className="text-sm text-[#536471] mt-1">{firstUncompleted.description}</p>
            )}
            <div className="flex items-center gap-2 mt-2 text-[11px] text-[#8b98a5]">
              <span className="capitalize">{firstUncompleted.difficulty}</span>
              <span>·</span>
              <span>{firstUncompleted.estimatedMinutes} min</span>
            </div>
          </div>
          {isDrill ? (
            <Link
              href={`/practice/drill?competency=${firstUncompleted.targetCompetency}`}
              className="shrink-0 inline-flex items-center gap-1.5 px-4 py-2.5 bg-amber-600 hover:bg-amber-700 text-white text-sm font-semibold rounded-lg transition-colors"
            >
              Start drill <ArrowRight className="w-4 h-4" />
            </Link>
          ) : (
            <button
              type="button"
              onClick={onStartInterview}
              className="shrink-0 inline-flex items-center gap-1.5 px-4 py-2.5 bg-amber-600 hover:bg-amber-700 text-white text-sm font-semibold rounded-lg transition-colors"
            >
              Start <ArrowRight className="w-4 h-4" />
            </button>
          )}
        </div>
      </motion.section>
    )
  }

  // Priority 3: all clear — encourage harder practice
  return (
    <motion.section
      className="surface-card-bordered p-5 sm:p-6 bg-gradient-to-br from-emerald-50 to-teal-50 border-emerald-200"
      initial={{ opacity: 0, y: -8 }}
      animate={{ opacity: 1, y: 0 }}
    >
      <div className="flex items-start gap-4">
        <div className="shrink-0 w-10 h-10 rounded-xl bg-emerald-600 flex items-center justify-center shadow-sm shadow-emerald-600/20">
          <Sparkles className="w-5 h-5 text-white" />
        </div>
        <div className="flex-1 min-w-0">
          <div className="text-[11px] uppercase tracking-wide text-emerald-700 font-semibold mb-1">
            You&apos;re on track
          </div>
          <h2 className="text-lg font-semibold text-[#0f1419]">Take on something harder</h2>
          <p className="text-sm text-[#536471] mt-1">
            Your readiness is at {readinessScore}/100. Try a deeper interview type or a new domain to keep growing.
          </p>
        </div>
        <button
          type="button"
          onClick={onStartInterview}
          className="shrink-0 inline-flex items-center gap-1.5 px-4 py-2.5 bg-emerald-600 hover:bg-emerald-700 text-white text-sm font-semibold rounded-lg transition-colors"
        >
          Start <ArrowRight className="w-4 h-4" />
        </button>
      </div>
    </motion.section>
  )
}
