'use client'

import Link from 'next/link'
import { Loader2, RotateCw } from 'lucide-react'
import { useState } from 'react'
import type { PathwayAction } from '@learn/services/pathwayViewModel'

interface PathwayPendingBannerProps {
  action: PathwayAction
  /** After the client poll budget expires, offer pathway retry. */
  pollExhausted?: boolean
  onRetried?: () => void
}

export default function PathwayPendingBanner({
  action,
  pollExhausted = false,
  onRetried,
}: PathwayPendingBannerProps) {
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const sessionId = action.metadata?.sessionId

  const handleRetry = async () => {
    if (busy || typeof sessionId !== 'string') return
    setBusy(true)
    setError(null)
    try {
      const res = await fetch('/api/learn/pathway/retry', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sessionId }),
      })
      if (!res.ok) {
        const data = (await res.json().catch(() => ({}))) as { error?: string }
        setError(data.error || `Retry failed (${res.status})`)
        return
      }
      onRetried?.()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Network error retrying pathway update.')
    } finally {
      setBusy(false)
    }
  }

  return (
    <section
      className={`surface-card-bordered p-4 sm:p-5 ${pollExhausted ? 'border-red-200 bg-red-50' : 'border-amber-200 bg-amber-50'}`}
      data-testid="pathway-pending-banner"
    >
      <div className="flex flex-col sm:flex-row sm:items-center gap-3">
        <div
          className={`w-9 h-9 rounded-lg flex items-center justify-center shrink-0 ${
            pollExhausted ? 'bg-red-100 text-red-700' : 'bg-amber-100 text-amber-700'
          }`}
        >
          <Loader2 className={`w-4 h-4 ${pollExhausted ? '' : 'animate-spin'}`} />
        </div>
        <div className="flex-1 min-w-0">
          <p className="text-sm font-semibold text-[#0f1419]">
            {pollExhausted ? 'Pathway update is taking longer than expected' : action.title}
          </p>
          <p className="text-xs text-[#536471] mt-0.5">
            {pollExhausted
              ? 'Your current plan is still shown below. Retry to enqueue another background update, or return to feedback.'
              : action.description}
          </p>
          {error && (
            <p className="text-xs text-red-700 mt-1" role="alert">
              {error}
            </p>
          )}
        </div>
        <div className="flex items-center gap-2 shrink-0">
          {action.href && !pollExhausted && (
            <Link
              href={action.href}
              className="text-sm font-semibold text-amber-800 hover:text-amber-900"
            >
              {action.ctaLabel}
            </Link>
          )}
          {pollExhausted && (
            <button
              type="button"
              onClick={() => void handleRetry()}
              disabled={busy}
              className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-md bg-red-600 text-white text-xs font-semibold hover:bg-red-700 disabled:opacity-60"
              data-testid="pathway-pending-retry-button"
            >
              <RotateCw className={`w-3 h-3 ${busy ? 'animate-spin' : ''}`} />
              {busy ? 'Retrying…' : 'Retry pathway update'}
            </button>
          )}
        </div>
      </div>
    </section>
  )
}
