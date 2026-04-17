'use client'

import { useCallback, useEffect, useState } from 'react'
import { motion } from 'framer-motion'
import { Sparkles } from 'lucide-react'
import PhaseProgressCard, { PathwayPhaseName, PhaseStatusProps } from './PhaseProgressCard'
import LessonCard, { LessonListEntry } from './LessonCard'

interface UniversalPlan {
  _id?: string
  planType?: string
  sessionsCompleted?: number
  currentPhase?: PathwayPhaseName
  phaseThresholds?: Record<string, number>
  lessons?: LessonListEntry[]
  targetRole?: string
}

interface UniversalPathwayResponse {
  plan: UniversalPlan | null
  phaseStatus: PhaseStatusProps | null
}

interface UniversalPathwayViewProps {
  domain: string
  depth: string
}

const CREATE_DOMAIN_DEFAULT = 'general'
const CREATE_DEPTH_DEFAULT = 'behavioral'

export default function UniversalPathwayView({ domain, depth }: UniversalPathwayViewProps) {
  const [plan, setPlan] = useState<UniversalPlan | null>(null)
  const [phaseStatus, setPhaseStatus] = useState<PhaseStatusProps | null>(null)
  const [loading, setLoading] = useState(true)
  const [creating, setCreating] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const load = useCallback(async () => {
    setLoading(true)
    try {
      const res = await fetch('/api/learn/pathway/universal')
      if (!res.ok) {
        setError('Could not load your pathway.')
      } else {
        const data: UniversalPathwayResponse = await res.json()
        setPlan(data.plan)
        setPhaseStatus(data.phaseStatus)
      }
    } catch {
      setError('Network error loading pathway.')
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    load()
  }, [load])

  const createPlan = async () => {
    setCreating(true)
    setError(null)
    try {
      const res = await fetch('/api/learn/pathway/universal', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          domain: domain || CREATE_DOMAIN_DEFAULT,
          depth: depth || CREATE_DEPTH_DEFAULT,
        }),
      })
      if (!res.ok) {
        setError('Could not generate a pathway. Try again.')
      } else {
        const data: UniversalPathwayResponse = await res.json()
        setPlan(data.plan)
        setPhaseStatus(data.phaseStatus)
      }
    } catch {
      setError('Network error generating pathway.')
    } finally {
      setCreating(false)
    }
  }

  const completeLesson = async (lessonId: string) => {
    const res = await fetch('/api/learn/pathway/universal', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'complete_lesson', lessonId }),
    })
    if (res.ok) {
      setPlan((prev) => {
        if (!prev) return prev
        return {
          ...prev,
          lessons: (prev.lessons ?? []).map((l) =>
            l.lessonId === lessonId ? { ...l, completed: true } : l,
          ),
        }
      })
    }
  }

  if (loading) {
    return (
      <div className="animate-pulse space-y-4">
        <div className="h-32 bg-[#eff3f4] rounded-xl" />
        <div className="h-16 bg-[#eff3f4] rounded-xl" />
        <div className="h-16 bg-[#eff3f4] rounded-xl" />
        <div className="h-16 bg-[#eff3f4] rounded-xl" />
      </div>
    )
  }

  if (!plan || !phaseStatus) {
    return (
      <motion.section
        className="surface-card-bordered p-6 sm:p-8 bg-gradient-to-br from-indigo-50 to-blue-50 border-indigo-200 text-center"
        initial={{ opacity: 0, y: 10 }}
        animate={{ opacity: 1, y: 0 }}
      >
        <div className="mx-auto w-12 h-12 rounded-xl bg-indigo-600 flex items-center justify-center shadow-sm shadow-indigo-600/20 mb-3">
          <Sparkles className="w-6 h-6 text-white" />
        </div>
        <h3 className="text-lg font-semibold text-[#0f1419] mb-1">Start your guided pathway</h3>
        <p className="text-sm text-[#536471] max-w-md mx-auto mb-4">
          Get a personalised 6-phase curriculum — assessment through mastery — paced to your sessions.
          Each phase unlocks lessons targeting your weakest competencies.
        </p>
        {error && <p className="text-sm text-[#f4212e] mb-3">{error}</p>}
        <button
          type="button"
          onClick={createPlan}
          disabled={creating}
          className="inline-flex items-center gap-1.5 px-5 py-2.5 bg-indigo-600 hover:bg-indigo-700 disabled:opacity-60 text-white text-sm font-semibold rounded-lg shadow-sm shadow-indigo-600/20 transition-colors"
        >
          {creating ? 'Generating…' : 'Generate my pathway'}
        </button>
      </motion.section>
    )
  }

  const lessons = plan.lessons ?? []
  const completedCount = lessons.filter((l) => l.completed).length

  return (
    <div className="space-y-5">
      <PhaseProgressCard phaseStatus={phaseStatus} />

      {error && <div className="text-sm text-[#f4212e]">{error}</div>}

      <motion.section
        className="space-y-2"
        initial={{ opacity: 0, y: 8 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ delay: 0.1 }}
      >
        <div className="flex items-center justify-between px-1">
          <h2 className="text-sm font-semibold text-[#0f1419]">
            Lessons ({completedCount}/{lessons.length})
          </h2>
          {lessons.length > 0 && (
            <div className="w-24 h-1.5 bg-[#eff3f4] rounded-full overflow-hidden">
              <div
                className="h-full bg-emerald-500 rounded-full transition-all"
                style={{ width: `${lessons.length ? (completedCount / lessons.length) * 100 : 0}%` }}
              />
            </div>
          )}
        </div>

        {lessons.length === 0 ? (
          <div className="text-sm text-[#8b98a5] p-4">
            Your pathway is ready. Lessons will appear here as your curriculum populates.
          </div>
        ) : (
          <div className="space-y-2">
            {lessons.map((entry, i) => (
              <LessonCard
                key={entry.lessonId}
                entry={entry}
                index={i}
                domain={domain || CREATE_DOMAIN_DEFAULT}
                depth={depth || CREATE_DEPTH_DEFAULT}
                onComplete={completeLesson}
              />
            ))}
          </div>
        )}
      </motion.section>
    </div>
  )
}
