'use client'

import Link from 'next/link'
import { Loader2 } from 'lucide-react'
import type { PathwayAction } from '@learn/services/pathwayViewModel'

interface PathwayPendingBannerProps {
  action: PathwayAction
}

export default function PathwayPendingBanner({ action }: PathwayPendingBannerProps) {
  return (
    <section className="surface-card-bordered p-4 sm:p-5 border-amber-200 bg-amber-50">
      <div className="flex flex-col sm:flex-row sm:items-center gap-3">
        <div className="w-9 h-9 rounded-lg bg-amber-100 text-amber-700 flex items-center justify-center shrink-0">
          <Loader2 className="w-4 h-4 animate-spin" />
        </div>
        <div className="flex-1 min-w-0">
          <p className="text-sm font-semibold text-[#0f1419]">{action.title}</p>
          <p className="text-xs text-[#536471] mt-0.5">{action.description}</p>
        </div>
        {action.href && (
          <Link
            href={action.href}
            className="text-sm font-semibold text-amber-800 hover:text-amber-900"
          >
            {action.ctaLabel}
          </Link>
        )}
      </div>
    </section>
  )
}
