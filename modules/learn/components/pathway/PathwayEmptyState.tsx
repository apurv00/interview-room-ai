'use client'

import Link from 'next/link'
import { ArrowRight, ClipboardList } from 'lucide-react'
import type { PathwayAction } from '@learn/services/pathwayViewModel'

interface PathwayEmptyStateProps {
  action: PathwayAction
}

export default function PathwayEmptyState({ action }: PathwayEmptyStateProps) {
  return (
    <section className="surface-card-bordered p-6 sm:p-8">
      <div className="flex flex-col sm:flex-row sm:items-center gap-5">
        <div className="w-12 h-12 rounded-xl bg-blue-600/10 text-blue-600 flex items-center justify-center shrink-0">
          <ClipboardList className="w-6 h-6" />
        </div>
        <div className="flex-1 min-w-0">
          <p className="text-[11px] font-semibold uppercase tracking-[0.12em] text-[#71767b] mb-1">
            No pathway yet
          </p>
          <h2 className="text-xl font-semibold text-[#0f1419]">{action.title}</h2>
          <p className="text-sm text-[#536471] mt-2 max-w-2xl">{action.description}</p>
        </div>
        {action.href && (
          <Link
            href={action.href}
            className="inline-flex items-center justify-center gap-2 px-5 py-2.5 bg-blue-600 hover:bg-blue-700 text-white text-sm font-semibold rounded-lg transition-colors"
          >
            {action.ctaLabel}
            <ArrowRight className="w-4 h-4" />
          </Link>
        )}
      </div>
    </section>
  )
}
