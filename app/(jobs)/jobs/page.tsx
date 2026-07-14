'use client'

import { useEffect, useState } from 'react'
import Link from 'next/link'

/**
 * /jobs — public Tier-A feed (PRODUCT_FLOW §1 Stage 0; P-2: anon browse).
 * Vocabulary discipline: at this tier every card claims ONLY
 * "title & location match" — no resume/readiness language exists until the
 * onboarding wave (3.2) attaches one. Demotions arrive pre-applied in rank
 * order from the API; nothing is hidden client-side. Empty state stays the
 * honest one from the scaffold.
 */

interface FeedCard {
  id: string
  title: string
  company: string
  locations: string[]
  isRemote: boolean
  domain?: string
  postedAt?: string
  salaryText?: string
  applyTier?: string
  matchedSkills?: string[]
}
interface FeedPayload {
  cards: FeedCard[]
  page: number
  hasMore: boolean
  sharpened?: number
}
interface JobsTarget {
  method: 'paste' | 'upload' | 'questions' | 'import'
  role: string
  city: string
  skills: string[]
}

const TIER_BADGE: Record<string, string> = {
  'direct-ats': 'Direct application',
  employer: "Employer's site",
  'aggregator-deep': 'Via job board',
  'platform-funnel': 'Via platform',
  'aggregator-redirect': 'Redirect link',
}

function daysAgo(iso?: string): string | null {
  if (!iso) return null
  const d = Math.floor((Date.now() - new Date(iso).getTime()) / 86_400_000)
  if (d <= 0) return 'Today'
  if (d === 1) return 'Yesterday'
  if (d > 30) return null
  return `${d}d ago`
}

export default function JobsPage() {
  const [data, setData] = useState<FeedPayload | null>(null)
  const [page, setPage] = useState(1)
  const [city, setCity] = useState('')
  const [cityInput, setCityInput] = useState('')
  const [error, setError] = useState(false)
  const [target, setTarget] = useState<JobsTarget | null>(null)
  const [targetLoaded, setTargetLoaded] = useState(false)
  const [capNotice, setCapNotice] = useState(false)

  // The confirm bar's output (sessionStorage — dies with the tab; a
  // stranger's resume structure never persists server-side).
  useEffect(() => {
    try {
      const raw = sessionStorage.getItem('JOBS_TARGET')
      if (raw) {
        const t = JSON.parse(raw) as JobsTarget
        setTarget(t)
        if (t.city) { setCity(t.city); setCityInput(t.city) }
      }
    } catch { /* private mode / corrupt entry — Tier-A feed */ }
    try { setCapNotice(sessionStorage.getItem('JOBS_CAP_NOTICE') === '1') } catch { /* noop */ }
    setTargetLoaded(true)
  }, [])

  function dismissCapNotice() {
    setCapNotice(false)
    try { sessionStorage.removeItem('JOBS_CAP_NOTICE') } catch { /* noop */ }
  }

  useEffect(() => {
    if (!targetLoaded) return
    const params = new URLSearchParams({ page: String(page) })
    if (city) params.set('city', city)
    if (target?.skills.length) params.set('skills', target.skills.join(','))
    if (target?.role) params.set('targetRole', target.role)
    fetch(`/api/jobs/feed?${params}`)
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error(String(r.status)))))
      .then(setData)
      .catch(() => setError(true))
    fetch('/api/events', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'jobs.feed_viewed', props: { page } }),
      keepalive: true,
    }).catch(() => {})
  }, [page, city, target, targetLoaded])

  // Reveal honesty (§4a): name the evidence ONLY when matched skills exist;
  // the 3-questions path never gets resume-flavored copy.
  const revealSkills = Array.from(new Set((data?.cards ?? []).flatMap((c) => c.matchedSkills ?? []))).slice(0, 3)
  const revealLine = !target
    ? null
    : target.method === 'questions'
      ? `Sorted by role & location — ${target.role}${target.city ? ` · ${target.city}` : ''}.`
      : (data?.sharpened ?? 0) > 0 && revealSkills.length
        ? `Sorted for you — based on your resume: ${revealSkills.join(', ')}.`
        : 'Feed refreshed.'

  return (
    <main className="mx-auto max-w-3xl px-4 py-10" aria-label="Job feed">
      <div className="flex items-baseline justify-between">
        <h1 className="text-2xl font-semibold">Jobs</h1>
        <Link href="/jobs/tracker" className="text-sm text-blue-600 hover:underline">My tracker</Link>
      </div>

      {target ? (
        <div className="mt-4 flex items-center justify-between rounded-xl border p-3">
          <p className="text-sm">{revealLine}</p>
          <Link href="/jobs/start" className="shrink-0 text-xs text-blue-600 hover:underline">Edit target</Link>
        </div>
      ) : (
        <div className="mt-4 rounded-xl border border-dashed p-4">
          <p className="text-sm font-medium">Attach your resume — we&apos;ll sort these for you.</p>
          <div className="mt-3 flex gap-3">
            <Link href="/jobs/start" className="rounded-lg bg-blue-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-blue-700">
              Attach or build
            </Link>
            <Link href="/jobs/start" className="rounded-lg border px-3 py-1.5 text-sm font-medium hover:bg-gray-50 dark:hover:bg-gray-800">
              Answer 3 questions
            </Link>
          </div>
        </div>
      )}

      <form
        className="mt-6 flex gap-2"
        onSubmit={(e) => { e.preventDefault(); setPage(1); setCity(cityInput.trim()) }}
      >
        <input
          value={cityInput}
          onChange={(e) => setCityInput(e.target.value)}
          placeholder="City (any location — remote always included)"
          aria-label="Filter by city"
          className="w-64 rounded-lg border px-3 py-1.5 text-sm dark:bg-gray-900"
        />
        <button type="submit" className="rounded-lg border px-3 py-1.5 text-sm font-medium hover:bg-gray-50 dark:hover:bg-gray-800">
          Filter
        </button>
      </form>

      {capNotice && (
        <div className="mt-4 flex items-start justify-between rounded-xl border border-amber-300 bg-amber-50 p-3 text-sm dark:border-amber-800 dark:bg-amber-950">
          <p>
            Your resume library is full (3/3), so we didn&apos;t save this one — your feed is still
            sorted by it. <Link href="/resume" className="underline">Manage resumes</Link>
          </p>
          <button onClick={dismissCapNotice} aria-label="Dismiss" className="ml-3 text-gray-500 hover:text-gray-700">✕</button>
        </div>
      )}

      {error && <p className="mt-8 text-sm text-red-600">The feed hit a snag — refresh to retry.</p>}
      {!data && !error && <p className="mt-8 text-sm text-gray-500">Loading jobs…</p>}

      {data && data.cards.length === 0 && (
        <div className="mt-8 rounded-xl border border-dashed p-6">
          <p className="font-medium">Your feed is warming up.</p>
          <p className="mt-1 text-sm text-gray-600 dark:text-gray-400">
            Fresh postings are being gathered{city ? ` — nothing live for “${city}” yet (remote roles appear here too)` : ''}. Check back soon.
          </p>
        </div>
      )}

      <ul className="mt-6 space-y-3">
        {data?.cards.map((c) => (
          <li key={c.id}>
            <Link
              href={`/jobs/${c.id}`}
              className="block rounded-xl border p-4 transition hover:border-blue-400 hover:shadow-sm"
            >
              <div className="flex items-baseline justify-between gap-3">
                <span className="font-medium">{c.title}</span>
                {daysAgo(c.postedAt) && <span className="shrink-0 text-xs text-gray-500">{daysAgo(c.postedAt)}</span>}
              </div>
              <div className="mt-1 text-sm text-gray-600 dark:text-gray-400">
                {c.company}
                {c.locations[0] ? ` · ${c.locations[0]}` : ''}
                {c.isRemote ? ' · Remote' : ''}
                {c.salaryText ? ` · ${c.salaryText}` : ''}
              </div>
              <div className="mt-2 flex gap-2 text-xs">
                {c.applyTier && TIER_BADGE[c.applyTier] && (
                  <span className="rounded-full border px-2 py-0.5 text-gray-600 dark:text-gray-400">{TIER_BADGE[c.applyTier]}</span>
                )}
                {c.matchedSkills?.length ? (
                  <span className="rounded-full border border-blue-300 px-2 py-0.5 text-blue-700 dark:border-blue-800 dark:text-blue-300">
                    Matches your resume: {c.matchedSkills.slice(0, 2).join(', ')}
                  </span>
                ) : (
                  <span className="rounded-full border px-2 py-0.5 text-gray-500">Looks relevant · title &amp; location match</span>
                )}
              </div>
            </Link>
          </li>
        ))}
      </ul>

      {data && (data.hasMore || page > 1) && (
        <div className="mt-6 flex items-center justify-between">
          <button
            disabled={page <= 1}
            onClick={() => setPage((p) => Math.max(1, p - 1))}
            className="rounded-lg border px-3 py-1.5 text-sm disabled:opacity-40"
          >
            ← Previous
          </button>
          <span className="text-xs text-gray-500">Page {page}</span>
          <button
            disabled={!data.hasMore}
            onClick={() => setPage((p) => p + 1)}
            className="rounded-lg border px-3 py-1.5 text-sm disabled:opacity-40"
          >
            Next →
          </button>
        </div>
      )}
    </main>
  )
}
