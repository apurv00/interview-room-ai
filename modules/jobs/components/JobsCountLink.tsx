'use client'

import { useEffect, useState } from 'react'
import Link from 'next/link'
import { resolveJobsDomainCapability } from '../config/domains'

/**
 * The Wave-5 press surface (PRODUCT_FLOW build plan 5.1) — ONE component,
 * three hosts (feedback CTA strip, pathway right column, homepage journey).
 * Honest-copy rules: counts come from the live feed; the domain is named
 * ONLY when the feed was actually filtered by it. Unsupported roles render
 * no CTA instead of silently linking to all jobs; zero jobs renders NOTHING.
 * No readiness-ranking claims exist here.
 * NO evidence claims either (Codex #527): practice evidence is recorded
 * only for jobs-attributed sessions (recordPracticeEvidence requires
 * attribution.source='jobs'), and sessions launched from these hosts have
 * no such attribution — the attributed case is JobsBridge's job.
 *
 * Client-safe by construction: deep-imports the pure domains config; hosts
 * import this file directly (the @jobs barrel drags mongoose).
 */

export default function JobsCountLink({
  domain,
  variant,
}: {
  domain?: string
  variant: 'feedback' | 'pathway' | 'home'
}) {
  const [state, setState] = useState<{ total: number; filtered: boolean } | null>(null)
  const capability = resolveJobsDomainCapability(domain)
  const filteredDomain = capability.kind === 'filtered' ? capability.domain : undefined
  const supported = capability.kind !== 'unsupported'

  useEffect(() => {
    let cancelled = false
    setState(null)
    if (!supported) {
      return () => { cancelled = true }
    }
    const params = new URLSearchParams({ pageSize: '1' })
    if (filteredDomain) params.set('domain', filteredDomain)
    fetch(`/api/jobs/feed?${params}`)
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => {
        if (!cancelled && d && typeof d.total === 'number') {
          setState({ total: d.total, filtered: !!filteredDomain })
        }
      })
      .catch(() => {})
    return () => { cancelled = true }
  }, [filteredDomain, supported])

  if (!supported || !state || state.total === 0) return null
  const count = state.total.toLocaleString()
  const href = state.filtered && filteredDomain ? `/jobs?domain=${filteredDomain}` : '/jobs'
  const what = state.filtered && filteredDomain ? `${filteredDomain} jobs` : 'jobs'

  if (variant === 'feedback') {
    return (
      <Link href={href} className="mt-2 inline-block rounded-lg border border-blue-200 bg-blue-50 px-3 py-1.5 text-sm text-blue-800 hover:border-blue-400">
        {count} live {what} listed on the feed. Browse →
      </Link>
    )
  }
  if (variant === 'pathway') {
    return (
      <div className="rounded-xl border border-slate-200 p-4 bg-white">
        <h3 className="text-sm font-semibold">{state.filtered ? 'Jobs in this practice area' : 'Live jobs on the feed'}</h3>
        <p className="mt-1 text-sm text-slate-500">
          {count} live {what} on the feed right now.
        </p>
        <Link href={href} className="mt-2 inline-block text-sm font-medium text-blue-600 hover:underline">
          Browse jobs →
        </Link>
      </div>
    )
  }
  // home: a journey-step-shaped compact card (the marketing page styles it)
  return (
    <Link href={href} className="text-sm font-medium text-blue-600 hover:underline">
      {count} live {what} →
    </Link>
  )
}
