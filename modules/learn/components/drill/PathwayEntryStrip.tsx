'use client'

import { useEffect, useState } from 'react'
import Link from 'next/link'
import { ArrowLeft, Target } from 'lucide-react'
import { deduplicatedFetch } from '@shared/cachedFetch'
import { validateReturnTo } from '@learn/lib/pathwaySetupContext'

interface PathwayTaskResponse {
  taskId: string
  title: string | null
  description: string
}

/**
 * PathwayEntryStrip — "From your pathway: {task.description}" header
 * with an optional "Back to pathway" link.
 *
 * Pathway P2 Wave 5 (feature 5A). The drill page is reached from the
 * Pathway page via `buildDrillHref` (pathwayViewModel.ts) which carries
 * `?source=pathway&actionId={taskId}&returnTo=/learn/pathway` — but the
 * drill page previously ignored everything except `competency`. Users
 * landed on a context-free "Drill Mode" header even though the Pathway
 * page had just told them WHY this drill matters.
 *
 * Self-hides when:
 *   - `source` !== 'pathway' (renders nothing for direct visits)
 *   - `actionId` resolves to no task in the user's current plan
 *     (Inngest pathway regen may have replaced the task list between
 *     URL mint and this page loading — that's expected, not an error)
 *
 * The "Back" link is gated through `validateReturnTo` so a forged
 * `?returnTo=https://evil.example.com` URL can't render a button that
 * redirects users off-domain (the InterviewSetupForm version that this
 * util was extracted from had this latent open-redirect risk).
 */
export default function PathwayEntryStrip({
  source,
  actionId,
  returnTo,
}: {
  source: string | undefined
  actionId: string | undefined
  returnTo: string | undefined
}) {
  const [task, setTask] = useState<PathwayTaskResponse | null>(null)

  useEffect(() => {
    if (source !== 'pathway' || !actionId) {
      setTask(null)
      return
    }

    let cancelled = false
    deduplicatedFetch(
      `/api/learn/drill/context/pathway?taskId=${encodeURIComponent(actionId)}`,
      { cache: 'no-store' },
    )
      .then((res) => (res.ok ? (res.json() as Promise<PathwayTaskResponse>) : null))
      .then((payload) => {
        if (cancelled) return
        setTask(payload)
      })
      .catch(() => {
        if (cancelled) return
        setTask(null)
      })

    return () => {
      cancelled = true
    }
  }, [source, actionId])

  if (source !== 'pathway' || !task) return null

  const safeReturnTo = validateReturnTo(returnTo)

  return (
    <section
      data-testid="pathway-entry-strip"
      aria-label="Context from the pathway action that opened this drill"
      className="surface-card-bordered p-4 sm:p-5 flex items-start gap-3 bg-gradient-to-br from-blue-50 to-white border-blue-200/70"
    >
      <span
        className="shrink-0 w-9 h-9 rounded-full flex items-center justify-center bg-blue-100 text-blue-700"
        aria-hidden="true"
      >
        <Target className="w-4 h-4" />
      </span>
      <div className="flex-1 min-w-0">
        <p className="text-[11px] uppercase tracking-[0.12em] font-semibold text-blue-700 mb-1">
          From your pathway
        </p>
        <p className="text-sm text-[#0f1419] leading-snug">{task.description}</p>
      </div>
      {safeReturnTo && (
        <Link
          href={safeReturnTo}
          className="shrink-0 inline-flex items-center gap-1 text-xs font-medium text-blue-700 hover:text-blue-800 transition-colors"
        >
          <ArrowLeft className="w-3 h-3" aria-hidden="true" />
          Back to pathway
        </Link>
      )}
    </section>
  )
}
