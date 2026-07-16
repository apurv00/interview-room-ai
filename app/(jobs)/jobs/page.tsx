'use client'

import { Suspense, useEffect, useState } from 'react'
import Link from 'next/link'
import { useSearchParams } from 'next/navigation'
import { JOB_DOMAIN_IDS } from '@jobs/config/domains'

/**
 * /jobs — public Tier-A feed (PRODUCT_FLOW §1 Stage 0; P-2: anon browse).
 * Vocabulary discipline: at this tier every card claims ONLY
 * "title & location match" — no resume/readiness language exists until the
 * onboarding wave (3.2) attaches one. Demotions arrive pre-applied in rank
 * order from the API; nothing is hidden client-side. Empty state stays the
 * honest one from the scaffold.
 *
 * ?domain= (Codex #527): the press surfaces (JobsCountLink) link here with a
 * domain filter — the page must honor it or the promised "N {domain} jobs"
 * lands on the unfiltered feed. Same validation as the API (JOB_DOMAIN_IDS;
 * unknown slugs ignored) and the active filter is always visible + clearable.
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
  pageSize: number
  hasMore: boolean
  total: number
  sharpened?: number
}
interface JobsTarget {
  method: 'paste' | 'upload' | 'questions' | 'import'
  role: string
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

function JobsFeed() {
  const searchParams = useSearchParams()
  const domainParam = searchParams.get('domain')
  const domain =
    domainParam && (JOB_DOMAIN_IDS as readonly string[]).includes(domainParam) ? domainParam : undefined

  const [data, setData] = useState<FeedPayload | null>(null)
  const [page, setPage] = useState(1)
  const [error, setError] = useState(false)
  const [target, setTarget] = useState<JobsTarget | null>(null)
  const [targetLoaded, setTargetLoaded] = useState(false)
  const [capNotice, setCapNotice] = useState(false)
  const [quickWins, setQuickWins] = useState<{ count: number; resumeId?: string } | null>(null)
  const [winsDismissed, setWinsDismissed] = useState(false)

  // Domain arrives via client-side nav too (query-only change doesn't remount);
  // reset pagination in-render so the fetch effect runs once, not racing twice.
  const [prevDomain, setPrevDomain] = useState(domain)
  if (domain !== prevDomain) {
    setPrevDomain(domain)
    setPage(1)
  }

  // The confirm bar's output (sessionStorage — dies with the tab; a
  // stranger's resume structure never persists server-side).
  useEffect(() => {
    try {
      const raw = sessionStorage.getItem('JOBS_TARGET')
      if (raw) {
        // Legacy blobs may still carry a `city` field — ignored (city is
        // neither an input nor a rank signal, founder directive 2026-07-16).
        setTarget(JSON.parse(raw) as JobsTarget)
      }
    } catch { /* private mode / corrupt entry — Tier-A feed */ }
    try { setCapNotice(sessionStorage.getItem('JOBS_CAP_NOTICE') === '1') } catch { /* noop */ }
    try { setWinsDismissed(sessionStorage.getItem('JOBS_WINS_DISMISSED') === '1') } catch { /* noop */ }
    setTargetLoaded(true)
    // Quick wins (package 10, zero LLM): 401 = anon, card hides.
    fetch('/api/jobs/quick-wins')
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => { if (d) setQuickWins(d) })
      .catch(() => {})
  }, [])

  function dismissWins() {
    setWinsDismissed(true)
    try { sessionStorage.setItem('JOBS_WINS_DISMISSED', '1') } catch { /* noop */ }
  }

  function dismissCapNotice() {
    setCapNotice(false)
    try { sessionStorage.removeItem('JOBS_CAP_NOTICE') } catch { /* noop */ }
  }

  useEffect(() => {
    if (!targetLoaded) return
    const params = new URLSearchParams({ page: String(page) })
    if (domain) params.set('domain', domain)
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
  }, [page, domain, target, targetLoaded])

  // Reveal honesty (§4a): name the evidence ONLY when matched skills exist;
  // the 3-questions path never gets resume-flavored copy.
  const revealSkills = Array.from(new Set((data?.cards ?? []).flatMap((c) => c.matchedSkills ?? []))).slice(0, 3)
  const revealLine = !target
    ? null
    : target.method === 'questions'
      ? `Sorted by role — ${target.role}.`
      : (data?.sharpened ?? 0) > 0 && revealSkills.length
        ? `Sorted for you — based on your resume: ${revealSkills.join(', ')}.`
        : target.role
          ? `Sorted by your target role — ${target.role}.`
          : 'Feed refreshed.'

  return (
    <main className="mx-auto max-w-3xl px-4 py-10" aria-label="Job feed">
      <div className="flex items-baseline justify-between">
        <h1 className="text-2xl font-semibold">Jobs</h1>
        <Link href="/jobs/tracker" className="text-sm text-blue-600 hover:underline">My tracker</Link>
      </div>

      {domain && (
        <div className="mt-4 flex items-center gap-2 text-sm">
          <span className="rounded-full border border-blue-300 bg-blue-50 px-3 py-1 text-blue-800">
            Showing {domain} jobs
          </span>
          <Link href="/jobs" className="text-xs text-blue-600 hover:underline">Clear filter</Link>
        </div>
      )}

      {target ? (
        <div className="mt-4 flex items-center justify-between rounded-xl border border-slate-200 p-3 bg-white">
          <p className="text-sm">{revealLine}</p>
          <Link href="/jobs/start" className="shrink-0 text-xs text-blue-600 hover:underline">Edit target</Link>
        </div>
      ) : (
        <div className="mt-4 rounded-xl border border-slate-200 border-dashed p-4 bg-white">
          <p className="text-sm font-medium">Attach your resume — we&apos;ll sort these for you.</p>
          <div className="mt-3 flex gap-3">
            <Link href="/jobs/start" className="rounded-lg bg-blue-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-blue-700">
              Attach or build
            </Link>
            <Link href="/jobs/start" className="rounded-lg border border-slate-200 px-3 py-1.5 text-sm font-medium hover:bg-slate-50">
              Answer 3 questions
            </Link>
          </div>
        </div>
      )}

      {quickWins && quickWins.count >= 2 && !winsDismissed && (
        <div className="mt-4 flex items-start justify-between rounded-xl border border-slate-200 p-3 text-sm bg-white">
          <p>
            Resume: <span className="font-medium">{quickWins.count} quick wins</span> — small fixes, better matches.{' '}
            <Link href={`/resume/builder${quickWins.resumeId ? `?id=${quickWins.resumeId}` : ''}`} className="text-blue-600 underline">Fix in builder</Link>
          </p>
          <button onClick={dismissWins} aria-label="Dismiss" className="ml-3 text-slate-500 hover:text-slate-600">✕</button>
        </div>
      )}

      {capNotice && (
        <div className="mt-4 flex items-start justify-between rounded-xl border border-amber-300 bg-amber-50 p-3 text-sm">
          <p>
            Your resume library is full (3/3), so we didn&apos;t save this one — your feed is still
            sorted by it. <Link href="/resume" className="underline">Manage resumes</Link>
          </p>
          <button onClick={dismissCapNotice} aria-label="Dismiss" className="ml-3 text-slate-600 hover:text-slate-600">✕</button>
        </div>
      )}

      {error && <p className="mt-8 text-sm text-red-600">The feed hit a snag — refresh to retry.</p>}
      {!data && !error && <p className="mt-8 text-sm text-slate-500">Loading jobs…</p>}

      {data && data.cards.length === 0 && (
        <div className="mt-8 rounded-xl border border-slate-200 border-dashed p-6 bg-white">
          <p className="font-medium">Your feed is warming up.</p>
          <p className="mt-1 text-sm text-slate-500">
            Fresh postings are being gathered
            {domain ? ` — nothing live in ${domain} right now` : ''}. Check back soon.
          </p>
        </div>
      )}

      <ul className="mt-6 space-y-3">
        {data?.cards.map((c) => (
          <li key={c.id}>
            <Link
              href={`/jobs/${c.id}`}
              className="block rounded-2xl border border-slate-200 p-4 shadow-sm transition hover:border-blue-400 hover:shadow-md bg-white"
            >
              <div className="flex items-baseline justify-between gap-3">
                <span className="font-medium">{c.title}</span>
                {daysAgo(c.postedAt) && <span className="shrink-0 text-xs text-slate-500">{daysAgo(c.postedAt)}</span>}
              </div>
              <div className="mt-1 text-sm text-slate-500">
                {c.company}
                {c.locations[0] ? ` · ${c.locations[0]}` : ''}
                {c.isRemote ? ' · Remote' : ''}
                {c.salaryText ? ` · ${c.salaryText}` : ''}
              </div>
              <div className="mt-2 flex gap-2 text-xs">
                {c.applyTier && TIER_BADGE[c.applyTier] && (
                  <span className="rounded-full border border-slate-200 px-2 py-0.5 text-slate-500 bg-white">{TIER_BADGE[c.applyTier]}</span>
                )}
                {c.matchedSkills?.length ? (
                  <span className="rounded-full border border-blue-300 px-2 py-0.5 text-blue-700 bg-white">
                    Matches your resume: {c.matchedSkills.slice(0, 2).join(', ')}
                  </span>
                ) : (
                  <span className="rounded-full border border-slate-200 px-2 py-0.5 text-slate-500 bg-white">Recently posted</span>
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
            className="rounded-lg border border-slate-200 px-3 py-1.5 text-sm disabled:opacity-40 bg-white"
          >
            ← Previous
          </button>
          <span className="text-xs text-slate-500">
            Page {page} of {Math.max(1, Math.ceil(data.total / (data.pageSize || 20)))} · {data.total} jobs
          </span>
          <button
            disabled={!data.hasMore}
            onClick={() => setPage((p) => p + 1)}
            className="rounded-lg border border-slate-200 px-3 py-1.5 text-sm disabled:opacity-40 bg-white"
          >
            Next →
          </button>
        </div>
      )}
    </main>
  )
}

export default function JobsPage() {
  // Suspense required because JobsFeed uses useSearchParams (?domain= from
  // the press surfaces) — repo pattern: lobby, tailor, drill pages.
  return (
    <Suspense fallback={<main className="mx-auto max-w-3xl px-4 py-10"><p className="mt-8 text-sm text-slate-500">Loading jobs…</p></main>}>
      <JobsFeed />
    </Suspense>
  )
}
