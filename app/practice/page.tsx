'use client'

import { useEffect, useState } from 'react'
import { useSession } from 'next-auth/react'
import { useRouter } from 'next/navigation'
import Link from 'next/link'
import { STORAGE_KEYS } from '@shared/storageKeys'
import type { InterviewConfig, ExperienceLevel, Duration } from '@shared/types'

interface PracticeSet {
  id: string
  domain: string
  domainLabel: string
  domainIcon: string
  interviewType: string
  interviewTypeLabel: string
  interviewTypeIcon: string
  difficulty: 'beginner' | 'intermediate' | 'advanced'
  estimatedMinutes: number
  focus: string
  description: string
  personalizedTip?: string
  practiceCount: number
  lastScore?: number
  avgScore?: number
  status: 'not_started' | 'in_progress' | 'mastered'
}

interface PracticeData {
  practiceSets: PracticeSet[]
  profile: {
    targetRole: string | null
    experienceLevel: string | null
    weakAreas: string[]
    interviewGoal: string | null
    isCareerSwitcher: boolean
  }
}

const DIFFICULTY_STYLES = {
  beginner: { bg: 'bg-emerald-500/10', border: 'border-emerald-500/20', text: 'text-emerald-400', label: 'Beginner' },
  intermediate: { bg: 'bg-amber-500/10', border: 'border-amber-500/20', text: 'text-amber-400', label: 'Intermediate' },
  advanced: { bg: 'bg-red-500/10', border: 'border-red-500/20', text: 'text-red-400', label: 'Advanced' },
}

const STATUS_STYLES = {
  not_started: { bg: 'bg-slate-700', text: 'text-slate-400', label: 'Not Started' },
  in_progress: { bg: 'bg-indigo-500/20', text: 'text-indigo-400', label: 'In Progress' },
  mastered: { bg: 'bg-emerald-500/20', text: 'text-emerald-400', label: 'Mastered' },
}

const GOAL_LABELS: Record<string, string> = {
  first_interview: 'First Interview Prep',
  improve_scores: 'Score Improvement',
  career_switch: 'Career Switch Practice',
  promotion: 'Promotion Prep',
  general_practice: 'General Practice',
}

export default function PracticePage() {
  const router = useRouter()
  const { status: authStatus } = useSession()
  const [data, setData] = useState<PracticeData | null>(null)
  const [loading, setLoading] = useState(true)
  const [filter, setFilter] = useState<'all' | 'not_started' | 'in_progress' | 'mastered'>('all')

  useEffect(() => {
    if (authStatus === 'unauthenticated') {
      router.push('/signin')
      return
    }
    if (authStatus !== 'authenticated') return

    fetch('/api/practice-sets')
      .then(r => r.json())
      .then(setData)
      .catch(() => {})
      .finally(() => setLoading(false))
  }, [authStatus, router])

  function startPractice(set: PracticeSet) {
    const expMap: Record<string, ExperienceLevel> = {
      beginner: '0-2', intermediate: '3-6', advanced: '7+',
    }
    const durMap: Record<string, Duration> = {
      beginner: 10, intermediate: 20, advanced: 30,
    }
    const config: InterviewConfig = {
      role: set.domain,
      interviewType: set.interviewType,
      experience: data?.profile?.experienceLevel as ExperienceLevel || expMap[set.difficulty],
      duration: durMap[set.difficulty],
    }
    localStorage.setItem(STORAGE_KEYS.INTERVIEW_CONFIG, JSON.stringify(config))
    router.push('/lobby')
  }

  if (loading) {
    return (
      <main className="min-h-screen flex items-center justify-center">
        <div className="w-6 h-6 rounded-full border-2 border-indigo-400 border-t-transparent animate-spin" />
      </main>
    )
  }

  const filtered = data?.practiceSets.filter(s => filter === 'all' || s.status === filter) || []
  const stats = {
    total: data?.practiceSets.length || 0,
    mastered: data?.practiceSets.filter(s => s.status === 'mastered').length || 0,
    inProgress: data?.practiceSets.filter(s => s.status === 'in_progress').length || 0,
    notStarted: data?.practiceSets.filter(s => s.status === 'not_started').length || 0,
  }

  return (
    <main className="min-h-screen px-4 py-8 max-w-5xl mx-auto">
      {/* Header */}
      <div className="flex items-start justify-between mb-8">
        <div>
          <h1 className="text-2xl font-bold text-white">Practice Sets</h1>
          <p className="text-sm text-slate-400 mt-1">
            {data?.profile?.interviewGoal
              ? `Personalized for: ${GOAL_LABELS[data.profile.interviewGoal] || data.profile.interviewGoal}`
              : 'Tailored practice based on your profile'}
          </p>
        </div>
        <Link
          href="/settings"
          className="text-xs text-indigo-400 hover:text-indigo-300 transition-colors"
        >
          Update Profile
        </Link>
      </div>

      {/* Stats summary */}
      <section className="grid grid-cols-4 gap-3 mb-8">
        {[
          { label: 'Total Sets', value: stats.total, color: 'text-white' },
          { label: 'Mastered', value: stats.mastered, color: 'text-emerald-400' },
          { label: 'In Progress', value: stats.inProgress, color: 'text-indigo-400' },
          { label: 'Not Started', value: stats.notStarted, color: 'text-slate-400' },
        ].map(s => (
          <div key={s.label} className="bg-slate-900 border border-slate-800 rounded-xl p-4 text-center">
            <p className={`text-xl font-bold ${s.color}`}>{s.value}</p>
            <p className="text-[10px] text-slate-500 mt-1">{s.label}</p>
          </div>
        ))}
      </section>

      {/* Progress bar */}
      {stats.total > 0 && (
        <div className="mb-8">
          <div className="flex items-center justify-between mb-2">
            <span className="text-xs text-slate-400">Overall Progress</span>
            <span className="text-xs text-slate-500">
              {Math.round((stats.mastered / stats.total) * 100)}% mastered
            </span>
          </div>
          <div className="h-2 bg-slate-800 rounded-full overflow-hidden flex">
            {stats.mastered > 0 && (
              <div
                className="h-full bg-emerald-500 transition-all"
                style={{ width: `${(stats.mastered / stats.total) * 100}%` }}
              />
            )}
            {stats.inProgress > 0 && (
              <div
                className="h-full bg-indigo-500 transition-all"
                style={{ width: `${(stats.inProgress / stats.total) * 100}%` }}
              />
            )}
          </div>
        </div>
      )}

      {/* Filter tabs */}
      <div className="flex gap-1 bg-slate-900 border border-slate-800 rounded-xl p-1 mb-6 w-fit">
        {(['all', 'not_started', 'in_progress', 'mastered'] as const).map(f => (
          <button
            key={f}
            onClick={() => setFilter(f)}
            className={`px-3 py-1.5 rounded-lg text-xs font-medium transition ${
              filter === f
                ? 'bg-indigo-600 text-white'
                : 'text-slate-400 hover:text-slate-200'
            }`}
          >
            {f === 'all' ? 'All' : f === 'not_started' ? 'Not Started' : f === 'in_progress' ? 'In Progress' : 'Mastered'}
          </button>
        ))}
      </div>

      {/* Practice set cards */}
      {filtered.length === 0 ? (
        <div className="text-center py-12">
          <p className="text-slate-400">No practice sets match this filter.</p>
          {!data?.profile?.targetRole && (
            <p className="text-sm text-slate-500 mt-2">
              <Link href="/settings" className="text-indigo-400 hover:text-indigo-300">Complete your profile</Link> to get personalized practice sets.
            </p>
          )}
        </div>
      ) : (
        <div className="grid md:grid-cols-2 gap-4">
          {filtered.map(set => {
            const diff = DIFFICULTY_STYLES[set.difficulty]
            const stat = STATUS_STYLES[set.status]
            return (
              <div
                key={set.id}
                className="bg-slate-900 border border-slate-800 rounded-2xl p-5 hover:border-slate-700 transition-all group"
              >
                {/* Header */}
                <div className="flex items-start justify-between mb-3">
                  <div className="flex items-center gap-2">
                    <span className="text-xl">{set.domainIcon}</span>
                    <div>
                      <h3 className="text-sm font-semibold text-white">{set.domainLabel}</h3>
                      <p className="text-xs text-slate-500 flex items-center gap-1">
                        <span>{set.interviewTypeIcon}</span>
                        {set.interviewTypeLabel}
                      </p>
                    </div>
                  </div>
                  <div className="flex items-center gap-2">
                    <span className={`px-2 py-0.5 rounded-full text-[10px] font-semibold ${diff.bg} ${diff.border} border ${diff.text}`}>
                      {diff.label}
                    </span>
                    <span className={`px-2 py-0.5 rounded-full text-[10px] font-semibold ${stat.bg} ${stat.text}`}>
                      {stat.label}
                    </span>
                  </div>
                </div>

                {/* Focus area */}
                <p className="text-xs text-slate-400 mb-3">
                  Focus: {set.focus}
                </p>

                {/* Personalized tip */}
                {set.personalizedTip && (
                  <div className="bg-indigo-500/5 border border-indigo-500/10 rounded-lg px-3 py-2 mb-3">
                    <p className="text-[11px] text-indigo-300">{set.personalizedTip}</p>
                  </div>
                )}

                {/* Stats row */}
                <div className="flex items-center gap-4 mb-4 text-xs text-slate-500">
                  <span>{set.estimatedMinutes} min</span>
                  <span>{set.practiceCount} sessions</span>
                  {set.avgScore !== undefined && (
                    <span>Avg: <span className={set.avgScore >= 75 ? 'text-emerald-400' : set.avgScore >= 55 ? 'text-amber-400' : 'text-red-400'}>{set.avgScore}</span></span>
                  )}
                  {set.lastScore !== undefined && (
                    <span>Last: {set.lastScore}</span>
                  )}
                </div>

                {/* CTA */}
                <button
                  onClick={() => startPractice(set)}
                  className="w-full py-2.5 rounded-xl text-sm font-medium bg-indigo-600 hover:bg-indigo-500 text-white transition-colors group-hover:shadow-[0_0_20px_rgba(99,102,241,0.15)]"
                >
                  {set.status === 'not_started' ? 'Start Practice' : set.status === 'mastered' ? 'Practice Again' : 'Continue Practice'}
                </button>
              </div>
            )
          })}
        </div>
      )}
    </main>
  )
}
