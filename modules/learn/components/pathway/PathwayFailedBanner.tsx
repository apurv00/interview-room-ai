'use client'

import { useState } from 'react'
import Link from 'next/link'
import { AlertCircle, RotateCw } from 'lucide-react'
import type { PathwayAction } from '@learn/services/pathwayViewModel'

interface PathwayFailedBannerProps {
  action: PathwayAction
  /** Called after a successful retry POST so the parent can refetch
   *  the pathway view model and re-render. */
  onRetried?: () => void
}

/**
 * Rendered when `viewModel.state === 'failed'` — the upstream session's
 * Inngest `pathway/regenerate` job exhausted its 3 attempts and the
 * session document carries `pathwayGenerationStatus: 'failed'`.
 *
 * Bug B fix (2026-05-16) — previously this state was invisible to the
 * user: the pathway page kept showing the perpetual "catching up"
 * banner with no recovery affordance. Now we surface the failure
 * explicitly and offer a Retry button that re-enqueues the job via
 * /api/learn/pathway/retry.
 */
export default function PathwayFailedBanner({ action, onRetried }: PathwayFailedBannerProps) {
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const sessionId = action.metadata?.sessionId
  const fromFeedback = action.metadata?.fromFeedback

  const handleRetry = async () => {
    if (busy) return
    if (typeof sessionId !== 'string') {
      setError('Missing sessionId — cannot retry from this context.')
      return
    }
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
      className="surface-card-bordered p-4 sm:p-5 border-red-200 bg-red-50"
      data-testid="pathway-failed-banner"
    >
      <div className="flex flex-col sm:flex-row sm:items-center gap-3">
        <div className="w-9 h-9 rounded-lg bg-red-100 text-red-700 flex items-center justify-center shrink-0">
          <AlertCircle className="w-4 h-4" />
        </div>
        <div className="flex-1 min-w-0">
          <p className="text-sm font-semibold text-[#0f1419]">{action.title}</p>
          <p className="text-xs text-[#536471] mt-0.5">{action.description}</p>
          {error && (
            <p
              className="text-xs text-red-700 mt-1"
              role="alert"
              data-testid="pathway-failed-error"
            >
              {error}
            </p>
          )}
        </div>
        <div className="flex items-center gap-2 flex-shrink-0">
          {typeof fromFeedback === 'string' && (
            <Link
              href={`/feedback/${encodeURIComponent(fromFeedback)}`}
              className="text-xs text-stone-600 hover:text-stone-900"
            >
              Back to feedback
            </Link>
          )}
          <button
            type="button"
            onClick={handleRetry}
            disabled={busy}
            className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-md bg-red-600 text-white text-xs font-semibold hover:bg-red-700 disabled:opacity-60 disabled:cursor-not-allowed"
            data-testid="pathway-retry-button"
          >
            <RotateCw className={`w-3 h-3 ${busy ? 'animate-spin' : ''}`} />
            {busy ? 'Retrying…' : action.ctaLabel}
          </button>
        </div>
      </div>
    </section>
  )
}
