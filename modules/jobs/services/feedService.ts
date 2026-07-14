import { gunzipSync } from 'zlib'
import { JobPosting, JobApplication, type IJobPosting } from '@shared/db/models'
import { TIER_RANK, type ApplyTier } from '../config/spamRules'
import { locationKey } from './identityResolver'

/**
 * Feed serving (PRODUCT_FLOW §1 Stage 0, Wave 3.1) — Tier-A DETERMINISTIC
 * ranking. Rules only:
 * - Serving NEVER consumes llmVerdict fields at launch (ruling #16 serving
 *   honesty: rank may read typed verdict fields only once enforcement is on
 *   AND the reason-chip vocabulary names that basis). Soft-closed rows are
 *   already `status:'closed'` and excluded by the status filter.
 * - Demotion flags DEMOTE, never hide (ruling #15) — a staffing/short-JD
 *   row sinks, it does not disappear.
 * - Copy vocabulary for this tier is "title & location match" ONLY — no
 *   resume/readiness claims exist at Tier-A (the UI owns the words; this
 *   module owns making them true: rank inputs are title/domain, location,
 *   recency, apply-path quality).
 *
 * P-2 (founder ruling 2026-07-14): public feed, auth-gated detail — the
 * DETAIL projection is split anon-shell vs authed-full SERVER-SIDE here, so
 * no route can accidentally ship the JD/apply URLs to an anonymous client.
 */

const PAGE_SIZE_DEFAULT = 20
const PAGE_SIZE_MAX = 50
/** Bounded candidate pull — scored in-app; index {domain, locationKeys, status, postedAt} serves the scan. */
const CANDIDATE_POOL = 400

export interface FeedQuery {
  domain?: string
  /** Free-text city — normalized through the same locationKey the pipeline uses. */
  city?: string
  includeRemote?: boolean
  page?: number
  pageSize?: number
}

export interface FeedCard {
  id: string
  title: string
  company: string
  locations: string[]
  isRemote: boolean
  domain?: string
  postedAt?: string
  salaryText?: string
  /** Best apply path across provenance — badge copy is tier-honest. */
  applyTier?: ApplyTier
  /** "Looks relevant · title & location match" is the ONLY claim Tier-A may make. */
  relevance: 'title-location'
}

// ── Tier-A scoring (deterministic; every weight visible in one place) ────────
const TIER_BONUS: Record<ApplyTier, number> = {
  'direct-ats': 30,
  employer: 25,
  'aggregator-deep': 15,
  'platform-funnel': 8,
  'aggregator-redirect': 3,
}
const DOMAIN_MATCH_BONUS = 25
const LOCATION_MATCH_BONUS = 20
const DEMOTION = { staffing: 10, shortJd: 8, repost: 6, confidential: 4 } as const
/** Linear recency decay to zero over 21 days — beyond that, freshness stops discriminating. */
const RECENCY_MAX = 25
const RECENCY_WINDOW_DAYS = 21

/** Only http(s) ever reaches a client — ingestion blocklists HOSTS, not
 *  schemes, so a provider payload carrying `javascript:`/`data:` could be
 *  stored with a tier; this projection is the last line before window.open
 *  (Codex on #517). */
export function isSafeHttpUrl(u: string): boolean {
  try {
    const proto = new URL(u).protocol
    return proto === 'http:' || proto === 'https:'
  } catch {
    return false
  }
}

export function bestApplyTierOf(doc: Pick<IJobPosting, 'provenance'>): ApplyTier | undefined {
  let best: ApplyTier | undefined
  for (const p of doc.provenance ?? []) {
    if (!p.applyUrl || !isSafeHttpUrl(p.applyUrl)) continue // badge honesty: never advertise a path we won't serve
    if (p.applyTier && (!best || TIER_RANK[p.applyTier as ApplyTier] < TIER_RANK[best])) {
      best = p.applyTier as ApplyTier
    }
  }
  return best
}

export function tierAScore(
  doc: Pick<IJobPosting, 'provenance' | 'flags' | 'confidentialCompany' | 'domain' | 'locationKeys' | 'isRemote' | 'postedAt'>,
  q: { domain?: string; locKey?: string; includeRemote?: boolean },
  now: Date
): number {
  let score = 0
  const tier = bestApplyTierOf(doc)
  if (tier) score += TIER_BONUS[tier]
  if (q.domain && doc.domain === q.domain) score += DOMAIN_MATCH_BONUS
  if (q.locKey && (doc.locationKeys ?? []).includes(q.locKey)) score += LOCATION_MATCH_BONUS
  else if (q.includeRemote && doc.isRemote) score += LOCATION_MATCH_BONUS / 2
  if (doc.postedAt) {
    const ageDays = (now.getTime() - doc.postedAt.getTime()) / 86_400_000
    if (ageDays >= 0 && ageDays < RECENCY_WINDOW_DAYS) {
      score += RECENCY_MAX * (1 - ageDays / RECENCY_WINDOW_DAYS)
    }
  }
  if (doc.flags?.staffing) score -= DEMOTION.staffing
  if (doc.flags?.shortJd) score -= DEMOTION.shortJd
  if (doc.flags?.repost) score -= DEMOTION.repost
  if (doc.confidentialCompany) score -= DEMOTION.confidential
  return score
}

export async function getFeed(query: FeedQuery, now = new Date()): Promise<{ cards: FeedCard[]; page: number; hasMore: boolean; total: number }> {
  const page = Math.max(1, Math.floor(query.page ?? 1))
  const pageSize = Math.min(PAGE_SIZE_MAX, Math.max(1, Math.floor(query.pageSize ?? PAGE_SIZE_DEFAULT)))
  const locKey = query.city ? locationKey(query.city) : undefined

  const filter: Record<string, unknown> = { status: 'open' }
  if (query.domain) filter.domain = query.domain
  // Location narrows the POOL only when given; remote rows always qualify
  // (country-level serving per ruling #17 — city is a ranking signal).
  if (locKey) filter.$or = [{ locationKeys: locKey }, { isRemote: true }]

  const docs = await JobPosting.find(filter)
    .select('title company locations isRemote domain postedAt salaryText provenance flags confidentialCompany locationKeys')
    .sort({ postedAt: -1, _id: -1 })
    .limit(CANDIDATE_POOL)
    .lean()

  const scored = docs
    .map((d) => ({ d, score: tierAScore(d as IJobPosting, { domain: query.domain, locKey, includeRemote: query.includeRemote ?? true }, now) }))
    .sort((a, b) => b.score - a.score || String(b.d._id).localeCompare(String(a.d._id)))

  const start = (page - 1) * pageSize
  const slice = scored.slice(start, start + pageSize)
  return {
    cards: slice.map(({ d }) => ({
      id: String(d._id),
      title: d.title,
      company: d.company,
      locations: d.locations ?? [],
      isRemote: !!d.isRemote,
      domain: d.domain,
      postedAt: d.postedAt ? new Date(d.postedAt).toISOString() : undefined,
      salaryText: d.salaryText,
      applyTier: bestApplyTierOf(d as IJobPosting),
      relevance: 'title-location' as const,
    })),
    page,
    hasMore: start + pageSize < scored.length,
    total: scored.length,
  }
}

// ── Detail projections (P-2: the anon/authed split lives HERE, server-side) ──

export interface JobDetailShell {
  id: string
  title: string
  company: string
  locations: string[]
  isRemote: boolean
  domain?: string
  postedAt?: string
  salaryText?: string
  applyTier?: ApplyTier
  /** Anon detail is a GATE surface: shell + this marker, never content. */
  gated: true
}

export interface JobDetailFull extends Omit<JobDetailShell, 'gated'> {
  gated: false
  jd: string
  /** Tier-honest apply ladder, best-first — subtitles are the UI's job. */
  applyOptions: Array<{ url: string; tier: ApplyTier; viaSite?: string }>
  flags: { staffing: boolean; shortJd: boolean; repost: boolean }
  /** The caller's own tracker row (chip + evidence ticker inputs). */
  application: { status: string; practiceCount: number } | null
}

function shellOf(doc: IJobPosting): Omit<JobDetailShell, 'gated'> {
  return {
    id: String(doc._id),
    title: doc.title,
    company: doc.company,
    locations: doc.locations ?? [],
    isRemote: !!doc.isRemote,
    domain: doc.domain,
    postedAt: doc.postedAt ? new Date(doc.postedAt).toISOString() : undefined,
    salaryText: doc.salaryText,
    applyTier: bestApplyTierOf(doc),
  }
}

export async function getJobDetail(id: string, userId?: string | null): Promise<JobDetailShell | JobDetailFull | null> {
  const doc = await JobPosting.findById(id).lean()
  if (!doc || doc.status !== 'open') return null
  if (!userId) return { ...shellOf(doc as IJobPosting), gated: true }
  const buf = doc.jdCompressed as Buffer | undefined
  let jd = ''
  try {
    jd = buf?.length ? gunzipSync(Buffer.isBuffer(buf) ? buf : Buffer.from((buf as { buffer: ArrayBufferLike }).buffer as ArrayBuffer)).toString('utf8') : ''
  } catch { /* corrupt gzip = empty body; the card still renders */ }
  const applyOptions = (doc.provenance ?? [])
    .filter((p) => p.applyUrl && p.applyTier && isSafeHttpUrl(p.applyUrl))
    .map((p) => ({ url: p.applyUrl as string, tier: p.applyTier as ApplyTier, viaSite: p.viaSite }))
    .sort((a, b) => TIER_RANK[a.tier] - TIER_RANK[b.tier])
  const app = await JobApplication.findOne({ userId, jobPostingId: id }).select('status practiceSessionIds').lean()
  return {
    ...shellOf(doc as IJobPosting),
    gated: false,
    jd,
    applyOptions,
    flags: { staffing: !!doc.flags?.staffing, shortJd: !!doc.flags?.shortJd, repost: !!doc.flags?.repost },
    application: app ? { status: app.status, practiceCount: Math.min(3, app.practiceSessionIds?.length ?? 0) } : null,
  }
}
