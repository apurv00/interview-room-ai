'use client'

import { Suspense, useEffect, useRef, useState } from 'react'
import Link from 'next/link'
import { useSearchParams } from 'next/navigation'
import { useSession } from 'next-auth/react'
import { JOB_DOMAIN_IDS } from '@jobs/config/domains'
import { JOB_TARGET_QUESTION_CTA, postedAgeLabel } from '@jobs/config/truthfulLabels'
import { clearAllInterviewStorage } from '@shared/storageKeys'

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
  /** null = anonymous tab; undefined = legacy unscoped blob. */
  ownerId?: string | null
}

const JOBS_TARGET_METHODS = new Set<JobsTarget['method']>(['paste', 'upload', 'questions', 'import'])

function parseJobsTarget(raw: string | null): JobsTarget | null {
  if (!raw) return null
  try {
    const value = JSON.parse(raw) as Record<string, unknown>
    if (!value || typeof value !== 'object' || !JOBS_TARGET_METHODS.has(value.method as JobsTarget['method'])) {
      return null
    }

    const method = value.method as JobsTarget['method']
    const ownerId = value.ownerId === null
      ? null
      : typeof value.ownerId === 'string' && value.ownerId.length <= 128
        ? value.ownerId
        : undefined
    const role = typeof value.role === 'string' ? value.role.trim().slice(0, 80) : ''
    const skills: string[] = []
    const seen = new Set<string>()
    if (method !== 'questions' && Array.isArray(value.skills)) {
      for (const candidate of value.skills) {
        if (typeof candidate !== 'string') continue
        const skill = candidate.trim().slice(0, 40)
        const key = skill.toLowerCase()
        if (!skill || seen.has(key)) continue
        seen.add(key)
        skills.push(skill)
        if (skills.length === 20) break
      }
    }

    return role || skills.length ? { method, role, skills, ownerId } : null
  } catch {
    return null
  }
}

const TIER_BADGE: Record<string, string> = {
  'direct-ats': 'Direct application',
  employer: "Employer's site",
  'aggregator-deep': 'Via job board',
  'platform-funnel': 'Via platform',
  'aggregator-redirect': 'Redirect link',
}

function JobsFeed() {
  const searchParams = useSearchParams()
  const { data: session, status: authStatus } = useSession()
  const currentUserId = session?.user?.id ?? null
  const domainParam = searchParams.get('domain')
  const domain =
    domainParam && (JOB_DOMAIN_IDS as readonly string[]).includes(domainParam) ? domainParam : undefined

  const [data, setData] = useState<FeedPayload | null>(null)
  const [page, setPage] = useState(1)
  const [error, setError] = useState(false)
  const [target, setTarget] = useState<JobsTarget | null>(null)
  const [targetLoaded, setTargetLoaded] = useState(false)
  const [loadedTargetIdentityKey, setLoadedTargetIdentityKey] = useState<string | null>(null)
  const [quickWins, setQuickWins] = useState<{ count: number; resumeId?: string } | null>(null)
  const [winsDismissed, setWinsDismissed] = useState(false)
  const [accountUnavailable, setAccountUnavailable] = useState(false)
  const [feedRevision, setFeedRevision] = useState(0)
  const feedRequestRef = useRef(0)
  const targetIdentityKey = `${authStatus}:${currentUserId ?? 'anonymous'}`
  const targetIdentityReady = (
    authStatus !== 'loading' &&
    targetLoaded &&
    loadedTargetIdentityKey === targetIdentityKey
  )
  const effectiveTarget = targetIdentityReady && target?.ownerId !== undefined && target.ownerId === currentUserId
    ? target
    : null

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
    feedRequestRef.current += 1
    setTargetLoaded(false)
    setLoadedTargetIdentityKey(null)
    setTarget(null)
    setQuickWins(null)
    setData(null)
    setError(false)
    setAccountUnavailable(false)
    if (authStatus === 'loading') return
    try {
      const raw = sessionStorage.getItem('JOBS_TARGET')
      if (raw) {
        // Legacy blobs may still carry a `city` field — ignored (city is
        // neither an input nor a rank signal, founder directive 2026-07-16).
        const parsed = parseJobsTarget(raw)
        // Legacy targets have no trustworthy owner provenance. Fail closed
        // instead of exposing a prior signed-in user's role/skills after
        // logout or on a shared tab.
        const ownerMatches = parsed?.ownerId !== undefined && parsed.ownerId === currentUserId
        if (ownerMatches) setTarget(parsed)
        else sessionStorage.removeItem('JOBS_TARGET')
      }
    } catch { /* private mode / corrupt entry — Tier-A feed */ }
    // Old cap notices were unscoped. The current flow stays on review when a
    // save hits the cap, so no feed handoff notice is needed.
    try { sessionStorage.removeItem('JOBS_CAP_NOTICE') } catch { /* noop */ }
    try { setWinsDismissed(sessionStorage.getItem('JOBS_WINS_DISMISSED') === '1') } catch { /* noop */ }
    setLoadedTargetIdentityKey(targetIdentityKey)
    setTargetLoaded(true)
    // Quick wins (package 10, zero LLM): 401 = anon, card hides.
    let cancelled = false
    fetch('/api/jobs/quick-wins')
      .then(async (response) => {
        if (response.status === 401) {
          const body = await response.json().catch(() => null) as { code?: unknown } | null
          if (body?.code === 'ACCOUNT_UNAVAILABLE') {
            return { kind: 'account-unavailable' as const }
          }
        }
        if (!response.ok) return { kind: 'empty' as const }
        return { kind: 'data' as const, data: await response.json() }
      })
      .then((resolution) => {
        if (cancelled) return
        if (resolution.kind === 'account-unavailable') {
          feedRequestRef.current += 1
          clearAllInterviewStorage()
          setTarget(null)
          setQuickWins(null)
          setWinsDismissed(false)
          setData(null)
          setError(false)
          setAccountUnavailable(true)
          setFeedRevision((revision) => revision + 1)
          return
        }
        if (resolution.kind === 'data') setQuickWins(resolution.data)
      })
      .catch(() => {})
    return () => { cancelled = true }
  }, [authStatus, currentUserId, targetIdentityKey])

  function dismissWins() {
    setWinsDismissed(true)
    try { sessionStorage.setItem('JOBS_WINS_DISMISSED', '1') } catch { /* noop */ }
  }

  useEffect(() => {
    if (!targetIdentityReady) return
    const requestId = ++feedRequestRef.current
    const params = new URLSearchParams({ page: String(page) })
    if (domain) params.set('domain', domain)
    const personalized = !!effectiveTarget && (!!effectiveTarget.role || effectiveTarget.skills.length > 0)
    const feedRequest = personalized
      ? fetch('/api/jobs/feed', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          cache: 'no-store',
          body: JSON.stringify({
            page,
            ...(domain ? { domain } : {}),
            ...(effectiveTarget.role ? { targetRole: effectiveTarget.role } : {}),
            ...(effectiveTarget.skills.length ? { skills: effectiveTarget.skills } : {}),
          }),
        })
      : fetch(`/api/jobs/feed?${params}`)
    feedRequest
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error(String(r.status)))))
      .then((nextData) => {
        if (requestId !== feedRequestRef.current) return
        setData(nextData)
        setError(false)
      })
      .catch(() => {
        if (requestId === feedRequestRef.current) setError(true)
      })
    fetch('/api/events', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'jobs.feed_viewed', props: { page } }),
      keepalive: true,
    }).catch(() => {})
  }, [page, domain, effectiveTarget, targetIdentityReady, feedRevision])

  // Reveal honesty (§4a): name resume signals only when matched skills exist;
  // the role-question path never gets resume-flavored copy.
  const revealSkills = Array.from(new Set((data?.cards ?? []).flatMap((c) => c.matchedSkills ?? []))).slice(0, 3)
  const revealLine = !effectiveTarget
    ? null
    : effectiveTarget.method === 'questions'
      ? `Sorted by role — ${effectiveTarget.role}.`
      : (data?.sharpened ?? 0) > 0 && revealSkills.length
        ? `Sorted for you — based on your resume: ${revealSkills.join(', ')}.`
        : effectiveTarget.role
          ? `Sorted by your target role — ${effectiveTarget.role}.`
          : 'Feed refreshed.'

  if (!targetIdentityReady) {
    return (
      <main className="mx-auto max-w-3xl px-4 py-10" aria-label="Job feed">
        <p className="mt-8 text-sm text-slate-500">Loading jobs…</p>
      </main>
    )
  }

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

      {accountUnavailable && (
        <div role="status" className="mt-4 rounded-xl border border-slate-200 bg-slate-50 p-3 text-sm text-slate-600">
          Account deletion has started or completed, so your saved target and personalized match signals were cleared. Public jobs remain available.
        </div>
      )}

      {effectiveTarget ? (
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
              {JOB_TARGET_QUESTION_CTA}
            </Link>
          </div>
        </div>
      )}

      {quickWins && quickWins.count >= 2 && !winsDismissed && (
        <div className="mt-4 flex items-start justify-between rounded-xl border border-slate-200 p-3 text-sm bg-white">
          <p>
            Resume: <span className="font-medium">{quickWins.count} quick wins</span> — small fixes identified from your resume.{' '}
            <Link href={`/resume/builder${quickWins.resumeId ? `?id=${quickWins.resumeId}` : ''}`} className="text-blue-600 underline">Fix in builder</Link>
          </p>
          <button onClick={dismissWins} aria-label="Dismiss" className="ml-3 text-slate-500 hover:text-slate-600">✕</button>
        </div>
      )}

      {error && <p className="mt-8 text-sm text-red-600">The feed hit a snag — refresh to retry.</p>}
      {!data && !error && <p className="mt-8 text-sm text-slate-500">Loading jobs…</p>}

      {data && data.cards.length === 0 && (
        <div className="mt-8 rounded-xl border border-slate-200 border-dashed p-6 bg-white">
          <p className="font-medium">No live postings found for this view.</p>
          <p className="mt-1 text-sm text-slate-500">
            {domain ? `There are no live ${domain} listings in the current feed.` : 'Try again later or update your target.'}
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
                {postedAgeLabel(c.postedAt) && <span className="shrink-0 text-xs text-slate-500">{postedAgeLabel(c.postedAt)}</span>}
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
                ) : null}
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
