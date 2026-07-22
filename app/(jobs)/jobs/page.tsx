'use client'

import { Suspense, useEffect, useMemo, useRef, useState } from 'react'
import Link from 'next/link'
import { usePathname, useRouter, useSearchParams } from 'next/navigation'
import { useSession } from 'next-auth/react'
import { JobsDiscoveryControls } from '@jobs/components/JobsDiscoveryControls'
import {
  FEED_EXPERIENCE_VALUES,
  FEED_FRESHNESS_VALUES,
  FEED_REMOTE_VALUES,
  FEED_SORT_VALUES,
  type PublicFeedQuery,
} from '@jobs/config/feedDiscovery'
import { JOB_DOMAIN_IDS } from '@jobs/config/domains'
import { JOB_TARGET_QUESTION_CTA, postedAgeLabel } from '@jobs/config/truthfulLabels'
import { clearAllInterviewStorage } from '@shared/storageKeys'

/**
 * /jobs — public, URL-addressable discovery over card-safe posting fields.
 * Public search/filter/sort/cursor state belongs in the URL. Resume-derived
 * target and skill signals remain owner-scoped in sessionStorage and travel
 * only in the private POST body.
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
  locationPreferenceMatched?: boolean
}

interface FeedPayload {
  cards: FeedCard[]
  pageSize: number
  hasMore: boolean
  hasPrevious: boolean
  nextCursor?: string
  previousCursor?: string
  total: number
  accessibleTotal: number
  resultCap: number
  capped: boolean
  sharpened?: number
  sort: 'best' | 'newest'
}

interface JobsTarget {
  method: 'paste' | 'upload' | 'questions' | 'import'
  role: string
  skills: string[]
  /** null = anonymous tab; undefined = legacy unscoped blob. */
  ownerId?: string | null
}

interface FeedRequestError extends Error {
  code?: string
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

function cleanParam(params: URLSearchParams, name: string, max: number): string | undefined {
  const value = params.get(name)?.trim().replace(/\s+/g, ' ').slice(0, max)
  return value || undefined
}

function enumParam<T extends string>(
  params: URLSearchParams,
  name: string,
  values: readonly T[],
): T | undefined {
  const value = params.get(name)
  return value && values.includes(value as T) ? value as T : undefined
}

function publicQueryFromParams(params: URLSearchParams): PublicFeedQuery {
  const domainParam = cleanParam(params, 'domain', 50)
  const domain = domainParam && (JOB_DOMAIN_IDS as readonly string[]).includes(domainParam)
    ? domainParam
    : undefined
  const cursor = cleanParam(params, 'cursor', 512)
  const direction = cursor && (params.get('direction') === 'before' || params.get('direction') === 'after')
    ? params.get('direction') as 'before' | 'after'
    : undefined
  return {
    domain,
    search: cleanParam(params, 'q', 80),
    location: cleanParam(params, 'location', 80),
    remote: enumParam(params, 'remote', FEED_REMOTE_VALUES),
    experience: enumParam(params, 'experience', FEED_EXPERIENCE_VALUES),
    company: cleanParam(params, 'company', 100),
    freshness: enumParam(params, 'freshness', FEED_FRESHNESS_VALUES),
    sort: enumParam(params, 'sort', FEED_SORT_VALUES),
    cursor,
    direction,
  }
}

function paramsForPublicQuery(query: PublicFeedQuery): URLSearchParams {
  const params = new URLSearchParams()
  if (query.domain) params.set('domain', query.domain)
  if (query.search) params.set('q', query.search)
  if (query.location) params.set('location', query.location)
  if (query.remote) params.set('remote', query.remote)
  if (query.experience) params.set('experience', query.experience)
  if (query.company) params.set('company', query.company)
  if (query.freshness) params.set('freshness', query.freshness)
  if (query.sort && query.sort !== 'best') params.set('sort', query.sort)
  if (query.cursor) {
    params.set('cursor', query.cursor)
    if (query.direction) params.set('direction', query.direction)
  }
  return params
}

function hrefForPublicQuery(pathname: string, query: PublicFeedQuery): string {
  const params = paramsForPublicQuery(query).toString()
  return params ? `${pathname}?${params}` : pathname
}

const TIER_BADGE: Record<string, string> = {
  'direct-ats': 'Direct application',
  employer: "Employer's site",
  'aggregator-deep': 'Via job board',
  'platform-funnel': 'Via platform',
  'aggregator-redirect': 'Redirect link',
}

function JobsFeedSkeleton() {
  return (
    <div className="mt-8 space-y-3" aria-label="Loading jobs">
      {Array.from({ length: 5 }, (_, index) => (
        <div key={index} className="h-28 animate-pulse rounded-2xl border border-slate-200 bg-slate-100" />
      ))}
    </div>
  )
}

function JobsFeed() {
  const searchParams = useSearchParams()
  const router = useRouter()
  const pathname = usePathname() || '/jobs'
  const { data: session, status: authStatus } = useSession()
  const currentUserId = session?.user?.id ?? null
  const searchParamsKey = searchParams.toString()
  const publicQuery = useMemo(
    () => publicQueryFromParams(new URLSearchParams(searchParamsKey)),
    [searchParamsKey],
  )
  const publicQueryKey = useMemo(() => paramsForPublicQuery(publicQuery).toString(), [publicQuery])

  const [data, setData] = useState<FeedPayload | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [isUpdating, setIsUpdating] = useState(false)
  const [target, setTarget] = useState<JobsTarget | null>(null)
  const [targetLoaded, setTargetLoaded] = useState(false)
  const [loadedTargetIdentityKey, setLoadedTargetIdentityKey] = useState<string | null>(null)
  const [quickWins, setQuickWins] = useState<{ count: number; resumeId?: string } | null>(null)
  const [winsDismissed, setWinsDismissed] = useState(false)
  const [accountUnavailable, setAccountUnavailable] = useState(false)
  const [feedRevision, setFeedRevision] = useState(0)
  const feedRequestRef = useRef(0)
  const hasFeedDataRef = useRef(false)
  const targetIdentityKey = `${authStatus}:${currentUserId ?? 'anonymous'}`
  const targetIdentityReady = (
    authStatus !== 'loading' &&
    targetLoaded &&
    loadedTargetIdentityKey === targetIdentityKey
  )
  const effectiveTarget = targetIdentityReady && target?.ownerId !== undefined && target.ownerId === currentUserId
    ? target
    : null

  // The confirm bar's output is tab-scoped and owner-scoped. A target from a
  // prior account is deleted before any personalized request can use it.
  useEffect(() => {
    feedRequestRef.current += 1
    setTargetLoaded(false)
    setLoadedTargetIdentityKey(null)
    setTarget(null)
    setQuickWins(null)
    setData(null)
    hasFeedDataRef.current = false
    setError(null)
    setAccountUnavailable(false)
    if (authStatus === 'loading') return
    try {
      const raw = sessionStorage.getItem('JOBS_TARGET')
      if (raw) {
        const parsed = parseJobsTarget(raw)
        const ownerMatches = parsed?.ownerId !== undefined && parsed.ownerId === currentUserId
        if (ownerMatches) setTarget(parsed)
        else sessionStorage.removeItem('JOBS_TARGET')
      }
    } catch { /* private mode / corrupt entry — public feed remains available */ }
    try { sessionStorage.removeItem('JOBS_CAP_NOTICE') } catch { /* noop */ }
    try { setWinsDismissed(sessionStorage.getItem('JOBS_WINS_DISMISSED') === '1') } catch { /* noop */ }
    setLoadedTargetIdentityKey(targetIdentityKey)
    setTargetLoaded(true)

    let cancelled = false
    fetch('/api/jobs/quick-wins')
      .then(async (response) => {
        if (response.status === 401) {
          const body = await response.json().catch(() => null) as { code?: unknown } | null
          if (body?.code === 'ACCOUNT_UNAVAILABLE') return { kind: 'account-unavailable' as const }
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
          hasFeedDataRef.current = false
          setError(null)
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

  function navigateToQuery(next: PublicFeedQuery, replace = false) {
    const href = hrefForPublicQuery(pathname, {
      ...next,
      cursor: undefined,
      direction: undefined,
    })
    if (replace) router.replace(href, { scroll: false })
    else router.push(href, { scroll: false })
  }

  useEffect(() => {
    if (!targetIdentityReady) return
    const requestId = ++feedRequestRef.current
    const controller = new AbortController()
    const personalized = !!effectiveTarget && (!!effectiveTarget.role || effectiveTarget.skills.length > 0)
    setIsUpdating(true)
    setError(null)

    const feedRequest = personalized
      ? fetch('/api/jobs/feed', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          cache: 'no-store',
          signal: controller.signal,
          body: JSON.stringify({
            ...publicQuery,
            ...(effectiveTarget.role ? { targetRole: effectiveTarget.role } : {}),
            ...(effectiveTarget.skills.length ? { skills: effectiveTarget.skills } : {}),
          }),
        })
      : fetch(`/api/jobs/feed${publicQueryKey ? `?${publicQueryKey}` : ''}`, {
          cache: 'no-store',
          signal: controller.signal,
        })

    feedRequest
      .then(async (response) => {
        const body = await response.json().catch(() => null) as (FeedPayload & { code?: string }) | null
        if (!response.ok || !body) {
          const requestError = new Error(`Jobs feed request failed (${response.status})`) as FeedRequestError
          requestError.code = body?.code
          throw requestError
        }
        return body
      })
      .then((nextData) => {
        if (requestId !== feedRequestRef.current) return
        setData(nextData)
        hasFeedDataRef.current = true
        setError(null)
        setIsUpdating(false)
      })
      .catch((requestError: FeedRequestError) => {
        if (requestError.name === 'AbortError' || requestId !== feedRequestRef.current) return
        if (requestError.code === 'INVALID_FEED_CURSOR' && publicQuery.cursor) {
          setIsUpdating(false)
          router.replace(hrefForPublicQuery(pathname, {
            ...publicQuery,
            cursor: undefined,
            direction: undefined,
          }), { scroll: false })
          return
        }
        setError(hasFeedDataRef.current ? 'Could not update jobs. Showing the previous results.' : 'Could not load jobs.')
        setIsUpdating(false)
      })

    fetch('/api/events', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'jobs.feed_viewed', props: { page: publicQuery.cursor ? 2 : 1 } }),
      keepalive: true,
    }).catch(() => {})

    return () => controller.abort()
  }, [effectiveTarget, feedRevision, pathname, publicQuery, publicQueryKey, router, targetIdentityReady])

  const revealSkills = Array.from(new Set((data?.cards ?? []).flatMap((card) => card.matchedSkills ?? []))).slice(0, 3)
  const revealLine = !effectiveTarget
    ? null
    : (publicQuery.sort ?? 'best') === 'newest'
      ? 'Newest first. Resume matches are highlighted when present; they do not change this order.'
      : effectiveTarget.method === 'questions'
        ? `Best match includes your private target role — ${effectiveTarget.role}. Sharing keeps only public filters.`
        : (data?.sharpened ?? 0) > 0 && revealSkills.length
          ? `Best match uses private resume signals on this page: ${revealSkills.join(', ')}. Sharing keeps only public filters.`
          : effectiveTarget.role
            ? `Best match includes your private target role — ${effectiveTarget.role}. Sharing keeps only public filters.`
            : 'Best match checked your private resume signals on this page.'

  if (!targetIdentityReady) {
    return (
      <main className="mx-auto max-w-4xl px-4 py-10" aria-label="Job feed">
        <JobsFeedSkeleton />
      </main>
    )
  }

  const hasHardFilters = Boolean(
    publicQuery.domain || publicQuery.search || publicQuery.remote || publicQuery.company || publicQuery.freshness,
  )
  const hasAnyDiscoveryPreference = Boolean(
    hasHardFilters || publicQuery.location || publicQuery.experience || publicQuery.sort,
  )
  const previousHref = data?.previousCursor
    ? hrefForPublicQuery(pathname, { ...publicQuery, cursor: data.previousCursor, direction: 'before' })
    : undefined
  const nextHref = data?.nextCursor
    ? hrefForPublicQuery(pathname, { ...publicQuery, cursor: data.nextCursor, direction: 'after' })
    : undefined

  return (
    <main className="mx-auto max-w-4xl px-4 py-10" aria-label="Job feed">
      <div className="flex items-baseline justify-between">
        <h1 className="text-2xl font-semibold">Jobs</h1>
        <Link href="/jobs/tracker" className="text-sm text-blue-600 hover:underline">My tracker</Link>
      </div>

      <JobsDiscoveryControls value={publicQuery} onApply={(next) => navigateToQuery(next)} />

      {accountUnavailable && (
        <div role="status" className="mt-4 rounded-xl border border-slate-200 bg-slate-50 p-3 text-sm text-slate-600">
          Account deletion has started or completed, so your saved target and personalized match signals were cleared. Public jobs remain available.
        </div>
      )}

      {effectiveTarget ? (
        <div className="mt-4 flex items-center justify-between gap-3 rounded-xl border border-slate-200 bg-white p-3">
          <p className="text-sm">{revealLine}</p>
          <Link href="/jobs/start" className="shrink-0 text-xs text-blue-600 hover:underline">Edit target</Link>
        </div>
      ) : (
        <div className="mt-4 rounded-xl border border-dashed border-slate-200 bg-white p-4">
          <p className="text-sm font-medium">Attach your resume to refine Best match using private signals.</p>
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
        <div className="mt-4 flex items-start justify-between rounded-xl border border-slate-200 bg-white p-3 text-sm">
          <p>
            Resume: <span className="font-medium">{quickWins.count} quick wins</span> — small fixes identified from your resume.{' '}
            <Link href={`/resume/builder${quickWins.resumeId ? `?id=${quickWins.resumeId}` : ''}`} className="text-blue-600 underline">Fix in builder</Link>
          </p>
          <button onClick={dismissWins} aria-label="Dismiss" className="ml-3 text-slate-500 hover:text-slate-600">✕</button>
        </div>
      )}

      <div className="sr-only" role="status" aria-live="polite">
        {isUpdating ? 'Updating jobs.' : data ? `${data.total} jobs found.` : ''}
      </div>

      {error && (
        <div role="alert" className="mt-6 flex items-center justify-between gap-4 rounded-xl border border-red-200 bg-red-50 p-3 text-sm text-red-700">
          <span>{error}</span>
          <button type="button" onClick={() => setFeedRevision((revision) => revision + 1)} className="font-medium underline">
            Retry
          </button>
        </div>
      )}

      <section aria-label="Job results" aria-busy={isUpdating} className={isUpdating && data ? 'opacity-70 transition-opacity' : undefined}>
        {!data && isUpdating && <JobsFeedSkeleton />}

        {data && (
          <div className="mt-7">
            <h2 className="text-sm font-semibold text-slate-800">
              {data.total.toLocaleString()} {data.total === 1 ? 'job' : 'jobs'}
            </h2>
            {data.capped && (
              <p className="mt-1 text-xs text-slate-500">
                Showing the top {data.resultCap.toLocaleString()} results. Narrow your filters to reach more relevant jobs.
              </p>
            )}
          </div>
        )}

        {data && data.cards.length === 0 && (
          <div className="mt-6 rounded-xl border border-dashed border-slate-200 bg-white p-6">
            <p className="font-medium">
              {hasHardFilters ? 'No jobs match these filters.' : 'No live postings are available right now.'}
            </p>
            <p className="mt-1 text-sm text-slate-500">
              {hasHardFilters
                ? 'Remove a filter or broaden your search.'
                : 'New live postings will appear here when they are available.'}
            </p>
            {hasAnyDiscoveryPreference && (
              <button type="button" onClick={() => navigateToQuery({})} className="mt-3 text-sm font-medium text-blue-700 hover:underline">
                Clear filters
              </button>
            )}
          </div>
        )}

        <ul className="mt-6 space-y-3">
          {data?.cards.map((card) => (
            <li key={card.id}>
              <Link
                href={`/jobs/${card.id}`}
                className="block rounded-2xl border border-slate-200 bg-white p-4 shadow-sm transition hover:border-blue-400 hover:shadow-md"
              >
                <div className="flex items-baseline justify-between gap-3">
                  <span className="font-medium">{card.title}</span>
                  {postedAgeLabel(card.postedAt) && <span className="shrink-0 text-xs text-slate-500">{postedAgeLabel(card.postedAt)}</span>}
                </div>
                <div className="mt-1 text-sm text-slate-500">
                  {card.company}
                  {card.locations[0] ? ` · ${card.locations[0]}` : ''}
                  {card.isRemote ? ' · Remote' : ''}
                  {card.salaryText ? ` · ${card.salaryText}` : ''}
                </div>
                <div className="mt-2 flex flex-wrap gap-2 text-xs">
                  {card.applyTier && TIER_BADGE[card.applyTier] && (
                    <span className="rounded-full border border-slate-200 bg-white px-2 py-0.5 text-slate-500">{TIER_BADGE[card.applyTier]}</span>
                  )}
                  {card.locationPreferenceMatched && publicQuery.location && (
                    <span className="rounded-full border border-emerald-200 bg-emerald-50 px-2 py-0.5 text-emerald-700">
                      Matches location preference
                    </span>
                  )}
                  {card.matchedSkills?.length ? (
                    <span className="rounded-full border border-blue-300 bg-white px-2 py-0.5 text-blue-700">
                      Matches your resume: {card.matchedSkills.slice(0, 2).join(', ')}
                    </span>
                  ) : null}
                </div>
              </Link>
            </li>
          ))}
        </ul>

        {data && (data.hasPrevious || data.hasMore) && (
          <nav aria-label="Job result pages" className="mt-6 flex items-center justify-between gap-3">
            {data.hasPrevious && previousHref ? (
              <Link scroll={false} href={previousHref} className="rounded-lg border border-slate-200 bg-white px-3 py-1.5 text-sm hover:border-blue-400">
                ← Previous
              </Link>
            ) : <span />}
            <span className="text-center text-xs text-slate-500">
              {data.cards.length} shown · {data.accessibleTotal.toLocaleString()} accessible
            </span>
            {data.hasMore && nextHref ? (
              <Link scroll={false} href={nextHref} className="rounded-lg border border-slate-200 bg-white px-3 py-1.5 text-sm hover:border-blue-400">
                Next →
              </Link>
            ) : <span />}
          </nav>
        )}
      </section>
    </main>
  )
}

export default function JobsPage() {
  return (
    <Suspense fallback={<main className="mx-auto max-w-4xl px-4 py-10"><JobsFeedSkeleton /></main>}>
      <JobsFeed />
    </Suspense>
  )
}
