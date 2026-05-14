'use client'

import Link from 'next/link'
import { ArrowUpRight, CheckCircle2, Circle, Clock } from 'lucide-react'
import type { PathwayPlanItem } from '@learn/services/pathwayViewModel'

interface PathwayPlanQueueProps {
  items: PathwayPlanItem[]
  completingTaskId?: string | null
  onCompleteTask: (taskId: string) => void
}

const DIFFICULTY_STYLES: Record<string, string> = {
  easy: 'bg-emerald-50 text-emerald-700',
  medium: 'bg-amber-50 text-amber-700',
  hard: 'bg-red-50 text-red-700',
}

export default function PathwayPlanQueue({
  items,
  completingTaskId,
  onCompleteTask,
}: PathwayPlanQueueProps) {
  const completed = items.filter((item) => item.status === 'done').length

  return (
    <section className="surface-card-bordered p-5 sm:p-6">
      <div className="flex items-center justify-between gap-4 mb-4">
        <div>
          <h2 className="text-sm font-semibold text-[#0f1419]">Plan</h2>
          <p className="text-xs text-[#71767b] mt-0.5">
            {completed}/{items.length} actions complete
          </p>
        </div>
        {items.length > 0 && (
          <div className="w-28 h-1.5 bg-[#eff3f4] rounded-full overflow-hidden">
            <div
              className="h-full bg-blue-600 rounded-full transition-all"
              style={{ width: `${(completed / items.length) * 100}%` }}
            />
          </div>
        )}
      </div>

      {items.length === 0 ? (
        <p className="text-sm text-[#71767b]">
          No practice actions are queued yet. Run a baseline interview to generate the first plan.
        </p>
      ) : (
        <div className="space-y-2">
          {items.map((item) => {
            const done = item.status === 'done'
            return (
              <div
                key={item.id}
                className={`flex items-start gap-3 p-3 rounded-xl border transition-colors ${
                  done ? 'bg-[#f8fafc] border-[#eff3f4]' : 'bg-white border-[#e1e8ed]'
                }`}
              >
                <button
                  type="button"
                  onClick={() => !done && onCompleteTask(item.id)}
                  disabled={done || completingTaskId === item.id}
                  className={`mt-0.5 shrink-0 transition-colors ${
                    done ? 'text-emerald-600' : 'text-[#8b98a5] hover:text-blue-600'
                  }`}
                  aria-label={done ? `${item.title} complete` : `Mark ${item.title} complete`}
                >
                  {done ? <CheckCircle2 className="w-5 h-5" /> : <Circle className="w-5 h-5" />}
                </button>
                <div className="flex-1 min-w-0">
                  <p className={`text-sm font-medium ${done ? 'text-[#71767b] line-through' : 'text-[#0f1419]'}`}>
                    {item.title}
                  </p>
                  {item.description && (
                    <p className="text-xs text-[#71767b] mt-1">{item.description}</p>
                  )}
                  <div className="flex flex-wrap items-center gap-2 mt-2">
                    <span className="text-[11px] px-2 py-0.5 rounded bg-[#eff3f4] text-[#536471] capitalize">
                      {item.type.replace('_', ' ')}
                    </span>
                    <span className={`text-[11px] px-2 py-0.5 rounded ${DIFFICULTY_STYLES[item.difficulty] || 'bg-[#eff3f4] text-[#536471]'}`}>
                      {item.difficulty}
                    </span>
                    <span className="inline-flex items-center gap-1 text-[11px] text-[#8b98a5]">
                      <Clock className="w-3 h-3" />
                      {item.estimatedMinutes}m
                    </span>
                    {item.targetCompetency && (
                      <span className="text-[11px] text-[#8b98a5] capitalize">
                        {item.targetCompetency.replace(/_/g, ' ')}
                      </span>
                    )}
                  </div>
                </div>
                {item.href && !done && (
                  <Link
                    href={item.href}
                    className="shrink-0 inline-flex items-center gap-1 px-2.5 py-1 rounded-lg text-xs font-medium text-blue-600 hover:bg-blue-50 transition-colors"
                  >
                    Open
                    <ArrowUpRight className="w-3 h-3" />
                  </Link>
                )}
              </div>
            )
          })}
        </div>
      )}
    </section>
  )
}
