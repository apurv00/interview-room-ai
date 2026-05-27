'use client'

import Link from 'next/link'
import { Info } from 'lucide-react'
import type { PathwayAction } from '@learn/services/pathwayViewModel'

interface PathwayUnchangedBannerProps {
  action: PathwayAction
}

export default function PathwayUnchangedBanner({ action }: PathwayUnchangedBannerProps) {
  return (
    <section
      className="surface-card-bordered p-4 sm:p-5 border-slate-200 bg-slate-50"
      data-testid="pathway-unchanged-banner"
    >
      <div className="flex flex-col sm:flex-row sm:items-center gap-3">
        <div className="w-9 h-9 rounded-lg bg-slate-100 text-slate-600 flex items-center justify-center shrink-0">
          <Info className="w-4 h-4" />
        </div>
        <div className="flex-1 min-w-0">
          <p className="text-sm font-semibold text-[#0f1419]">{action.title}</p>
          <p className="text-xs text-[#536471] mt-0.5">{action.description}</p>
        </div>
        {action.href && (
          <Link
            href={action.href}
            className="text-sm font-semibold text-slate-800 hover:text-slate-900 shrink-0"
          >
            {action.ctaLabel}
          </Link>
        )}
      </div>
    </section>
  )
}
