'use client'

import Link from 'next/link'
import { ArrowRight, CheckCircle2, PlayCircle, RotateCcw } from 'lucide-react'
import type { PathwayAction, PathwayState } from '@learn/services/pathwayViewModel'

interface TodayActionCardProps {
  action: PathwayAction
  state: PathwayState
  completing?: boolean
  onCompleteTask: (taskId: string) => void
}

const STATE_LABELS: Record<PathwayState, string> = {
  empty: 'Start here',
  active: 'Today',
  pending: 'Updating',
  returning: 'Resume',
  abandoned: 'Pick back up',
  completed: 'Next challenge',
}

export default function TodayActionCard({
  action,
  state,
  completing = false,
  onCompleteTask,
}: TodayActionCardProps) {
  const icon = state === 'completed'
    ? <CheckCircle2 className="w-5 h-5" />
    : state === 'returning' || state === 'abandoned'
      ? <RotateCcw className="w-5 h-5" />
      : <PlayCircle className="w-5 h-5" />

  return (
    <section className="surface-card-bordered p-5 sm:p-6 border-blue-500/20">
      <div className="flex flex-col sm:flex-row sm:items-center gap-5">
        <div className="w-11 h-11 rounded-xl bg-blue-600 text-white flex items-center justify-center shrink-0">
          {icon}
        </div>
        <div className="flex-1 min-w-0">
          <div className="text-[11px] font-semibold uppercase tracking-[0.12em] text-blue-600 mb-1">
            {STATE_LABELS[state]}
          </div>
          <h2 className="text-lg font-semibold text-[#0f1419]">{action.title}</h2>
          <p className="text-sm text-[#536471] mt-1.5">{action.description}</p>
        </div>
        {action.href ? (
          <Link
            href={action.href}
            className="inline-flex items-center justify-center gap-2 px-5 py-2.5 bg-blue-600 hover:bg-blue-700 text-white text-sm font-semibold rounded-lg transition-colors"
          >
            {action.ctaLabel}
            <ArrowRight className="w-4 h-4" />
          </Link>
        ) : action.taskId ? (
          <button
            type="button"
            onClick={() => onCompleteTask(action.taskId!)}
            disabled={completing}
            className="inline-flex items-center justify-center gap-2 px-5 py-2.5 bg-blue-600 hover:bg-blue-700 disabled:bg-blue-600/60 text-white text-sm font-semibold rounded-lg transition-colors"
          >
            {completing ? 'Saving...' : action.ctaLabel}
            <CheckCircle2 className="w-4 h-4" />
          </button>
        ) : null}
      </div>
    </section>
  )
}
