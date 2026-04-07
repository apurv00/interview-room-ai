'use client'

import { useEffect, useState } from 'react'
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

interface Milestone {
  name: string
  description: string
  targetScore: number
  currentScore: number
  achieved: boolean
}

interface PathwayData {
  pathway: {
    readinessLevel: string
    readinessScore: number
    topBlockingWeaknesses: Array<{
      competency: string
      currentScore: number
      targetScore: number
      reason: string
    }>
    strengthsToPreserve: string[]
    nextSessionRecommendation: {
      domain: string
      interviewType: string
      focusCompetencies: string[]
      difficulty: string
      reason: string
    }
    practiceTasks: PracticeTask[]
    milestones: Milestone[]
    userGoal: string
    targetRole: string
  } | null
  competencySummary: {
    avgScore: number
    totalCompetencies: number
    improving: number
    declining: number
    stable: number
  } | null
  weaknesses: Array<{
    competencyName: string
    currentScore: number
    trend: string
  }>
}

const READINESS_STAGES = [
  { key: 'not_ready', label: 'Foundation', color: 'bg-red-500' },
  { key: 'developing', label: 'Developing', color: 'bg-amber-500' },
  { key: 'approaching', label: 'Approaching', color: 'bg-blue-500' },
  { key: 'ready', label: 'Interview Ready', color: 'bg-emerald-500' },
  { key: 'strong', label: 'Strong', color: 'bg-purple-500' },
]

const DIFFICULTY_COLORS: Record<string, string> = {
  easy: 'bg-emerald-500/10 text-[#059669]',
  medium: 'bg-amber-500/10 text-[#d97706]',
  hard: 'bg-red-500/10 text-[#f4212e]',
}

const TYPE_ICONS: Record<string, string> = {
  drill: 'D',
  full_session: 'S',
  review: 'R',
  homework: 'H',
}

export default function PathwayPage() {
  const [data, setData] = useState<PathwayData | null>(null)
  const [loading, setLoading] = useState(true)
  const [completing, setCompleting] = useState<string | null>(null)

  useEffect(() => {
    fetch('/api/learn/pathway')
      .then(r => r.json())
      .then(d => { setData(d); setLoading(false) })
      .catch(() => setLoading(false))
  }, [])

  const completeTask = async (taskId: string) => {
    setCompleting(taskId)
    try {
      const res = await fetch('/api/learn/pathway', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'complete_task', taskId }),
      })
      if (res.ok && data?.pathway) {
        setData({
          ...data,
          pathway: {
            ...data.pathway,
            practiceTasks: data.pathway.practiceTasks.map(t =>
              t.taskId === taskId ? { ...t, completed: true } : t
            ),
          },
        })
      }
    } catch {
      // silently fail
    } finally {
      setCompleting(null)
    }
  }

  if (loading) {
    return (
      <main className="max-w-4xl mx-auto px-4 py-8">
        <div className="animate-pulse space-y-6">
          <div className="h-8 bg-[#eff3f4] rounded w-48" />
          <div className="h-32 bg-[#eff3f4] rounded-xl" />
          <div className="h-48 bg-[#eff3f4] rounded-xl" />
        </div>
      </main>
    )
  }

  const pathway = data?.pathway

  if (!pathway) {
    return (
      <main className="max-w-4xl mx-auto px-4 py-8 text-center py-16">
        <h1 className="text-2xl font-bold text-[#0f1419] mb-4">Learning Pathway</h1>
        <p className="text-[#71767b] mb-6">Complete your first interview to generate a personalized learning pathway.</p>
        <a
          href="/lobby"
          className="inline-flex items-center gap-2 px-5 py-2.5 bg-blue-600 hover:bg-blue-500 text-white text-sm font-medium rounded-lg transition-colors"
        >
          Start an Interview
        </a>
      </main>
    )
  }

  const stageIndex = READINESS_STAGES.findIndex(s => s.key === pathway.readinessLevel)
  const completedTasks = pathway.practiceTasks.filter(t => t.completed).length
  const totalTasks = pathway.practiceTasks.length
  const achievedMilestones = pathway.milestones.filter(m => m.achieved).length

  return (
    <main className="max-w-4xl mx-auto px-4 py-8 space-y-8">
      <motion.h1
        className="text-2xl font-bold text-[#0f1419]"
        initial={{ opacity: 0, y: -10 }}
        animate={{ opacity: 1, y: 0 }}
      >
        Learning Pathway
      </motion.h1>

      {/* Readiness Gauge */}
      <motion.section
        className="surface-card-bordered p-5 sm:p-6"
        initial={{ opacity: 0, y: 12 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ delay: 0.1 }}
      >
        <div className="flex items-center justify-between mb-4">
          <h2 className="text-sm font-semibold text-[#0f1419]">Interview Readiness</h2>
          <span className="text-2xl font-bold text-[#0f1419]">{pathway.readinessScore}/100</span>
        </div>

        {/* Progress bar */}
        <div className="relative h-2 bg-[#eff3f4] rounded-full mb-4 overflow-hidden">
          <motion.div
            className="absolute inset-y-0 left-0 rounded-full bg-gradient-to-r from-red-500 via-amber-500 via-blue-500 to-emerald-500"
            initial={{ width: 0 }}
            animate={{ width: `${pathway.readinessScore}%` }}
            transition={{ duration: 1, ease: 'easeOut' }}
          />
        </div>

        {/* Stage indicators */}
        <div className="flex justify-between">
          {READINESS_STAGES.map((stage, i) => (
            <div key={stage.key} className="flex flex-col items-center gap-1">
              <div className={`w-3 h-3 rounded-full ${
                i <= stageIndex ? stage.color : 'bg-[#e1e8ed]'
              }`} />
              <span className={`text-[10px] ${
                i === stageIndex ? 'text-[#0f1419] font-medium' : 'text-[#8b98a5]'
              }`}>
                {stage.label}
              </span>
            </div>
          ))}
        </div>
      </motion.section>

      {/* Milestones */}
      {pathway.milestones.length > 0 && (
        <motion.section
          className="surface-card-bordered p-5 sm:p-6"
          initial={{ opacity: 0, y: 12 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ delay: 0.2 }}
        >
          <h2 className="text-sm font-semibold text-[#0f1419] mb-4">
            Milestones ({achievedMilestones}/{pathway.milestones.length})
          </h2>
          <div className="space-y-3">
            {pathway.milestones.map((m, i) => (
              <div key={i} className="flex items-center gap-3">
                <div className={`w-5 h-5 rounded-full flex items-center justify-center shrink-0 ${
                  m.achieved ? 'bg-emerald-500' : 'bg-[#e1e8ed]'
                }`}>
                  {m.achieved && (
                    <svg className="w-3 h-3 text-white" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={3}>
                      <path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7" />
                    </svg>
                  )}
                </div>
                <div className="flex-1 min-w-0">
                  <div className={`text-sm ${m.achieved ? 'text-[#8b98a5] line-through' : 'text-[#536471]'}`}>
                    {m.name}
                  </div>
                  <div className="text-xs text-[#8b98a5]">{m.description}</div>
                </div>
                <span className="text-xs text-[#71767b] shrink-0">{m.currentScore}/{m.targetScore}</span>
              </div>
            ))}
          </div>
        </motion.section>
      )}

      {/* Practice Tasks */}
      <motion.section
        className="surface-card-bordered p-5 sm:p-6"
        initial={{ opacity: 0, y: 12 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ delay: 0.3 }}
      >
        <div className="flex items-center justify-between mb-4">
          <h2 className="text-sm font-semibold text-[#0f1419]">
            Practice Tasks ({completedTasks}/{totalTasks})
          </h2>
          {totalTasks > 0 && (
            <div className="w-24 h-1.5 bg-[#eff3f4] rounded-full overflow-hidden">
              <div
                className="h-full bg-blue-500 rounded-full transition-all"
                style={{ width: `${(completedTasks / totalTasks) * 100}%` }}
              />
            </div>
          )}
        </div>

        <div className="space-y-2">
          {pathway.practiceTasks.map(task => (
            <div
              key={task.taskId}
              className={`flex items-start gap-3 p-3 rounded-xl transition-colors ${
                task.completed ? 'bg-[#f8fafc]' : 'bg-[#eff3f4]'
              }`}
            >
              <button
                onClick={() => !task.completed && completeTask(task.taskId)}
                disabled={task.completed || completing === task.taskId}
                className={`mt-0.5 w-5 h-5 rounded border-2 flex items-center justify-center shrink-0 transition-colors ${
                  task.completed
                    ? 'bg-emerald-500 border-emerald-500'
                    : completing === task.taskId
                    ? 'border-blue-500 animate-pulse'
                    : 'border-[#e1e8ed] hover:border-blue-500'
                }`}
              >
                {task.completed && (
                  <svg className="w-3 h-3 text-white" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={3}>
                    <path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7" />
                  </svg>
                )}
              </button>

              <div className="flex-1 min-w-0">
                <div className={`text-sm ${task.completed ? 'text-[#71767b] line-through' : 'text-[#536471]'}`}>
                  {task.title}
                </div>
                {task.description && (
                  <div className="text-xs text-[#8b98a5] mt-0.5">{task.description}</div>
                )}
                <div className="flex items-center gap-2 mt-1.5">
                  <span className="text-[10px] px-1.5 py-0.5 rounded bg-[#eff3f4] text-[#8b98a5]">
                    {TYPE_ICONS[task.type]} {task.type.replace('_', ' ')}
                  </span>
                  <span className={`text-[10px] px-1.5 py-0.5 rounded ${DIFFICULTY_COLORS[task.difficulty] || 'bg-[#eff3f4] text-[#8b98a5]'}`}>
                    {task.difficulty}
                  </span>
                  <span className="text-[10px] text-[#8b98a5]">{task.estimatedMinutes}m</span>
                  {task.type === 'drill' && !task.completed && (
                    <a
                      href={`/practice/drill?competency=${task.targetCompetency}`}
                      className="text-[10px] text-blue-400 hover:text-blue-300"
                      onClick={e => e.stopPropagation()}
                    >
                      Start drill
                    </a>
                  )}
                </div>
              </div>
            </div>
          ))}
        </div>
      </motion.section>

      {/* Blocking Weaknesses */}
      {pathway.topBlockingWeaknesses.length > 0 && (
        <motion.section
          className="surface-card-bordered p-5 sm:p-6"
          initial={{ opacity: 0, y: 12 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ delay: 0.4 }}
        >
          <h2 className="text-sm font-semibold text-[#0f1419] mb-4">Blocking Weaknesses</h2>
          <div className="space-y-3">
            {pathway.topBlockingWeaknesses.map((w, i) => (
              <div key={i} className="flex items-center gap-3 p-3 rounded-xl bg-red-500/5">
                <div className="flex-1 min-w-0">
                  <div className="text-sm text-[#536471] capitalize">{w.competency.replace(/_/g, ' ')}</div>
                  <div className="text-xs text-[#71767b] mt-0.5">{w.reason}</div>
                </div>
                <div className="text-right shrink-0">
                  <div className="text-sm font-medium text-[#f4212e]">{w.currentScore}</div>
                  <div className="text-[10px] text-[#8b98a5]">target: {w.targetScore}</div>
                </div>
              </div>
            ))}
          </div>
        </motion.section>
      )}

      {/* Next Session Recommendation */}
      {pathway.nextSessionRecommendation?.reason && (
        <motion.section
          className="surface-card-bordered p-5 sm:p-6 border-blue-500/20"
          initial={{ opacity: 0, y: 12 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ delay: 0.5 }}
        >
          <h2 className="text-sm font-semibold text-[#0f1419] mb-3">Recommended Next Session</h2>
          <p className="text-sm text-[#8b98a5] mb-4">{pathway.nextSessionRecommendation.reason}</p>
          <div className="flex items-center gap-3 flex-wrap mb-4">
            {pathway.nextSessionRecommendation.focusCompetencies.map(c => (
              <span key={c} className="text-xs px-2 py-1 rounded-lg bg-blue-500/10 text-blue-400 capitalize">
                {c.replace(/_/g, ' ')}
              </span>
            ))}
          </div>
          <a
            href="/lobby"
            className="inline-flex items-center gap-2 px-5 py-2.5 bg-blue-600 hover:bg-blue-500 text-white text-sm font-medium rounded-lg transition-colors"
          >
            Start Practice
          </a>
        </motion.section>
      )}
    </main>
  )
}
