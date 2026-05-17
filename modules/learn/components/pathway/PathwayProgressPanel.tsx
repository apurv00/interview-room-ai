'use client'

import { AlertTriangle, CheckCircle2, Repeat, Target } from 'lucide-react'
import type { PathwayProgress } from '@learn/services/pathwayViewModel'
import MomentumSparkline from '@learn/components/pathway/MomentumSparkline'

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
          {progress.blockers.map((blocker) => {
            // Pathway P2 Wave 3 — recurrence + momentum live outside
            // the stored blocker shape (computed by the view model
            // against prior plans + UserCompetencyState). Default to
            // empty insight when the panel is rendered without them.
            const insight = progress.blockerInsights?.[blocker.competency] ?? {
              recurrenceCount: 0,
              momentum: [],
            }
            return (
              <div
                key={blocker.competency}
                className="p-3 rounded-lg bg-amber-50 border border-amber-100 space-y-2"
              >
                <div className="flex items-center justify-between gap-3">
                  <div className="min-w-0">
                    <div className="flex items-center gap-2 flex-wrap">
                      <p className="text-sm font-medium text-[#0f1419] capitalize">
                        {blocker.competency.replace(/_/g, ' ')}
                      </p>
                      {/* #8 — recurrence flag. Only when a prior plan
                          had this blocker; one-offs render no badge. */}
                      {insight.recurrenceCount > 0 && (
                        <span
                          data-testid={`recurrence-badge-${blocker.competency}`}
                          className="inline-flex items-center gap-1 text-[10px] font-semibold uppercase tracking-wide text-amber-800 bg-amber-100 border border-amber-200 px-1.5 py-0.5 rounded"
                          title={`Flagged in ${insight.recurrenceCount} prior plan${insight.recurrenceCount === 1 ? '' : 's'}`}
                        >
                          <Repeat className="w-3 h-3" aria-hidden="true" />
                          Recurring ({insight.recurrenceCount}×)
                        </span>
                      )}
                    </div>
                    <p className="text-xs text-[#71767b] mt-0.5">{blocker.reason}</p>
                  </div>
                  <div className="flex items-center gap-3 shrink-0">
                    {/* #2 — momentum sparkline; self-hides for <2 points */}
                    <MomentumSparkline
                      points={insight.momentum}
                      targetScore={blocker.targetScore}
                    />
                    <div className="text-xs text-[#536471] shrink-0">
                      {blocker.currentScore}/{blocker.targetScore}
                    </div>
                  </div>
                </div>
              </div>
            )
          })}
        </div>
      ) : (
        <div className="flex items-center gap-2 text-sm text-[#536471]">
          <CheckCircle2 className="w-4 h-4 text-emerald-600" />
          No blocking weakness is currently holding the plan back.
        </div>
      )}

      {/* Pathway P2 Wave 3 #9 — milestone detail. The summary count
          above shows X/Y, this list answers "what are they?" */}
      {progress.milestones && progress.milestones.length > 0 && (
        <div className="mt-5 space-y-2">
          <div className="flex items-center gap-2 text-sm font-semibold text-[#0f1419]">
            <Target className="w-4 h-4 text-blue-600" />
            Milestones
          </div>
          <ul className="space-y-1.5" role="list">
            {progress.milestones.map((m) => (
              <li
                key={m.name}
                data-testid={`milestone-${m.name}`}
                className={`flex items-start gap-2 text-xs p-2 rounded-lg border ${
                  m.achieved
                    ? 'bg-emerald-50 border-emerald-100'
                    : 'bg-[#f8fafc] border-[#eff3f4]'
                }`}
              >
                {m.achieved ? (
                  <CheckCircle2 className="w-3.5 h-3.5 text-emerald-600 shrink-0 mt-0.5" aria-hidden="true" />
                ) : (
                  <span className="w-3.5 h-3.5 rounded-full border border-[#cbd5e1] shrink-0 mt-0.5" aria-hidden="true" />
                )}
                <div className="min-w-0 flex-1">
                  <p className="text-[#0f1419] font-medium">{m.name}</p>
                  {m.description && (
                    <p className="text-[11px] text-[#71767b] mt-0.5 leading-snug">{m.description}</p>
                  )}
                </div>
                <span className="text-[11px] text-[#536471] shrink-0 tabular-nums">
                  {m.currentScore}/{m.targetScore}
                </span>
              </li>
            ))}
          </ul>
        </div>
      )}
    </section>
  )
}
