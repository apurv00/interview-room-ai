'use client'

import { useEffect, useState } from 'react'
import Link from 'next/link'
import { JOB_DOMAIN_IDS } from '../config/domains'

/**
 * The Wave-5 press surface (PRODUCT_FLOW build plan 5.1) — ONE component,
 * three hosts (feedback CTA strip, pathway right column, homepage journey).
 * Honest-copy rules: counts come from the live feed; the domain is named
 * ONLY when the feed was actually filtered by it (unknown slugs fall back
 * to the unfiltered count with generic copy); zero jobs renders NOTHING —
 * no promises about an empty feed. No readiness-ranking claims exist here.
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

  useEffect(() => {
    const valid = !!domain && (JOB_DOMAIN_IDS as readonly string[]).includes(domain)
    const params = new URLSearchParams({ pageSize: '1' })
    if (valid && domain) params.set('domain', domain)
    fetch(`/api/jobs/feed?${params}`)
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => {
        if (d && typeof d.total === 'number') setState({ total: d.total, filtered: valid })
      })
      .catch(() => {})
  }, [domain])

  if (!state || state.total === 0) return null
  const count = `${state.total}${state.total >= 400 ? '+' : ''}`
  const href = state.filtered && domain ? `/jobs?domain=${domain}` : '/jobs'
  const what = state.filtered && domain ? `${domain} jobs` : 'jobs'

  if (variant === 'feedback') {
    return (
      <Link href={href} className="mt-2 inline-block rounded-lg border border-blue-200 bg-blue-50 px-3 py-1.5 text-sm text-blue-800 hover:border-blue-400 dark:border-blue-900 dark:bg-blue-950 dark:text-blue-200">
        {count} live {what} are hiring right now — this session counts toward them. Browse →
      </Link>
    )
  }
  if (variant === 'pathway') {
    return (
      <div className="rounded-xl border p-4">
        <h3 className="text-sm font-semibold">Jobs matching your prep</h3>
        <p className="mt-1 text-sm text-gray-600 dark:text-gray-400">
          {count} live {what} on the feed — practice here counts as evidence there.
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
