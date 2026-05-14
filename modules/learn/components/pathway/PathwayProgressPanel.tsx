'use client'

import { AlertTriangle, CheckCircle2 } from 'lucide-react'
import type { PathwayProgress } from '@learn/services/pathwayViewModel'

interface PathwayProgressPanelProps {
  progress: PathwayProgress
}

const READINESS_LABELS: Record<string, string> = {
  not_ready: 'Foundation',
  developing: 'Developing',
  approaching: 'Approaching',
  ready: 'Interview Ready',
  strong: 'Strong',
}

export default function PathwayProgressPanel({ progress }: PathwayProgressPanelProps) {
  const readinessLabel = progress.readinessLevel
    ? READINESS_LABELS[progress.readinessLevel] || 'In progress'
    : 'Not measured'

  return (
    <section className="surface-card-bordered p-5 sm:p-6">
      <div className="flex items-start justify-between gap-4 mb-4">
        <div>
          <h2 className="text-sm font-semibold text-[#0f1419]">Progress</h2>
          <p className="text-xs text-[#71767b] mt-0.5">{readinessLabel}</p>
        </div>
        <div className="text-right">
          <div className="text-2xl font-bold text-[#0f1419]">{progress.readinessScore}</div>
          <div className="text-[11px] text-[#8b98a5]">readiness</div>
        </div>
      </div>

      <div className="h-2 bg-[#eff3f4] rounded-full overflow-hidden mb-5">
        <div
          className="h-full bg-blue-600 rounded-full transition-all"
          style={{ width: `${Math.max(0, Math.min(100, progress.readinessScore))}%` }}
        />
      </div>

      <div className="grid grid-cols-2 gap-3 mb-5">
        <div className="p-3 rounded-lg bg-[#f8fafc] border border-[#eff3f4]">
          <p className="text-[11px] text-[#8b98a5] uppercase tracking-wide">Tasks</p>
          <p className="text-sm font-semibold text-[#0f1419] mt-1">
            {progress.completedTasks}/{progress.totalTasks}
          </p>
        </div>
        <div className="p-3 rounded-lg bg-[#f8fafc] border border-[#eff3f4]">
          <p className="text-[11px] text-[#8b98a5] uppercase tracking-wide">Milestones</p>
          <p className="text-sm font-semibold text-[#0f1419] mt-1">
            {progress.achievedMilestones}/{progress.totalMilestones}
          </p>
        </div>
      </div>

      {progress.blockers.length > 0 ? (
        <div className="space-y-2">
          <div className="flex items-center gap-2 text-sm font-semibold text-[#0f1419]">
            <AlertTriangle className="w-4 h-4 text-amber-600" />
            Current blockers
          </div>
          {progress.blockers.map((blocker) => (
            <div key={blocker.competency} className="flex items-center justify-between gap-3 p-3 rounded-lg bg-amber-50 border border-amber-100">
              <div className="min-w-0">
                <p className="text-sm font-medium text-[#0f1419] capitalize">
                  {blocker.competency.replace(/_/g, ' ')}
                </p>
                <p className="text-xs text-[#71767b] mt-0.5">{blocker.reason}</p>
              </div>
              <div className="text-xs text-[#536471] shrink-0">
                {blocker.currentScore}/{blocker.targetScore}
              </div>
            </div>
          ))}
        </div>
      ) : (
        <div className="flex items-center gap-2 text-sm text-[#536471]">
          <CheckCircle2 className="w-4 h-4 text-emerald-600" />
          No blocking weakness is currently holding the plan back.
        </div>
      )}
    </section>
  )
}
