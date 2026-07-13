import { fetchJSONWithRetry } from '@shared/fetchJSONWithRetry'
import { classifyApplyUrl } from '../services/qualityGate'
import type { FetchResult, FetchTarget, JobSourceAdapter, NormalizedJob } from './types'

/**
 * Unified ATS-board adapter (INGESTION §1 build-now): Greenhouse, Lever,
 * SmartRecruiters, Ashby — official unauthenticated board APIs, direct-apply
 * URLs, stable posting ids (real externalIds, unlike JSearch's rotating
 * aliases). One adapter, per-company JobSourceConfig rows {atsKind, slug}.
 *
 * India scoping: SmartRecruiters filters server-side (?country=in); the
 * other boards list globally, so non-India rows are EXCLUDED at fetch
 * (policy filtering, deliberately NOT normalize-null — drift semantics are
 * reserved for schema breakage, which degrades health). The gate is
 * word-bounded and requires explicit India context: unanchored 'india'
 * matched Indianapolis/Indiana, and bare 'remote' admitted 'Remote - US'
 * rows into the India corpus (Codex on #513 round-4) — a remote row now
 * passes only when its location text is itself India-scoped.
 *
 * SmartRecruiters v1 is list-only: the list payload carries metadata but
 * the full jobAd lives behind one detail call per posting — deferred
 * (bounded-cost decision); SR rows may land short-jd flagged until the
 * detail enrichment follow-up.
 */

const INDIA_SCOPE_RE = /\b(india|bengaluru|bangalore|mumbai|delhi|gurgaon|gurugram|noida|hyderabad|pune|chennai|kolkata|ahmedabad)\b/i

function stripHtml(html: string): string {
  return html.replace(/<[^>]+>/g, ' ')
}

type BoardKind = 'greenhouse' | 'lever' | 'smartrecruiters' | 'ashby'

interface BoardRow {
  kind: BoardKind
  raw: Record<string, unknown>
}

function listUrl(atsKind: string, slug: string): { url: string; init?: RequestInit } | null {
  switch (atsKind) {
    case 'greenhouse':
      return { url: `https://boards-api.greenhouse.io/v1/boards/${slug}/jobs?content=true` }
    case 'lever':
      return { url: `https://api.lever.co/v0/postings/${slug}?mode=json` }
    case 'smartrecruiters':
      return { url: `https://api.smartrecruiters.com/v1/companies/${slug}/postings?country=in&limit=100&offset=0` }
    case 'ashby':
      return {
        url: `https://api.ashbyhq.com/posting-api/job-board/${slug}`,
        init: { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ includeCompensation: false }) },
      }
    default:
      return null
  }
}

function extractRows(atsKind: BoardKind, data: unknown): Record<string, unknown>[] | null {
  const d = data as Record<string, unknown>
  if (atsKind === 'greenhouse') return Array.isArray(d?.jobs) ? (d.jobs as Record<string, unknown>[]) : null
  if (atsKind === 'lever') return Array.isArray(data) ? (data as Record<string, unknown>[]) : null
  if (atsKind === 'smartrecruiters') return Array.isArray(d?.content) ? (d.content as Record<string, unknown>[]) : null
  if (atsKind === 'ashby') return Array.isArray(d?.jobs) ? (d.jobs as Record<string, unknown>[]) : null
  return null
}

/**
 * Company identity ladder: provider payload name (GH `company_name`, SR
 * `company.name` — live-verified 2026-07-13: 'PhonePe', 'Bosch Group') →
 * config displayName (Lever/Ashby rows carry none) → source-id suffix as
 * last resort. The suffix ('boschgroup') must never be first choice: it
 * breaks companyKey word boundaries so ATS rows would neither fingerprint
 * nor fuzzy-merge with the same employer from JSearch, and it leaks a slug
 * into user-visible company names (Codex on #513 round-5).
 */
function boardCompany(kind: BoardKind, j: Record<string, unknown>, target: FetchTarget): string {
  if (kind === 'greenhouse' && typeof j.company_name === 'string' && j.company_name) return j.company_name
  if (kind === 'smartrecruiters') {
    const name = (j.company as Record<string, unknown> | undefined)?.name
    if (typeof name === 'string' && name) return name
  }
  if (target.kind === 'board' && target.displayName) return target.displayName
  const boardId = target.kind === 'board' ? target.boardId : 'ats-board'
  return boardId.split(':')[1] ?? boardId
}

function locationText(atsKind: BoardKind, j: Record<string, unknown>): string {
  if (atsKind === 'greenhouse') return String((j.location as Record<string, unknown>)?.name ?? '')
  if (atsKind === 'lever') return String((j.categories as Record<string, unknown>)?.location ?? '')
  if (atsKind === 'smartrecruiters') {
    const loc = j.location as Record<string, unknown> | undefined
    return [loc?.city, loc?.country].filter(Boolean).join(', ')
  }
  if (atsKind === 'ashby') return String(j.location ?? '')
  return ''
}

export const atsBoardAdapter: JobSourceAdapter = {
  sourceId: 'ats-board',
  kind: 'ats-board',

  buildTargets(config) {
    if (!config.enabled || !config.slug || !config.atsKind) return []
    return [{
      kind: 'board' as const,
      boardId: config.sourceId,
      slug: config.slug,
      atsKind: config.atsKind as BoardKind,
      displayName: config.displayName,
    }]
  },

  async fetch(target: FetchTarget): Promise<FetchResult> {
    if (target.kind !== 'board') return { ok: false, status: 0, raw: [], attempts: 0 }
    const req = listUrl(target.atsKind, target.slug)
    if (!req) return { ok: false, status: 0, raw: [], attempts: 0 }
    let attempts = 0
    let rows: Record<string, unknown>[] = []
    // SmartRecruiters caps list responses at 100 — Bosch alone is ~546 India
    // rows, so we page by offset until a short page (Codex on #513, P1).
    // Safety cap 10 pages; each request is ~1s so a full board fits the
    // 60s step comfortably. Other boards return complete lists in one call.
    const SR_PAGE = 100
    const SR_MAX_PAGES = 10
    let offset = 0
    for (;;) {
      const url = target.atsKind === 'smartrecruiters'
        ? `https://api.smartrecruiters.com/v1/companies/${target.slug}/postings?country=in&limit=${SR_PAGE}&offset=${offset}`
        : req.url
      const res = await fetchJSONWithRetry<unknown>(url, req.init ?? {}, { maxRetries: 2, timeoutMs: 15000 })
      attempts++
      if (!res.ok) return { ok: false, status: res.status, raw: [], attempts }
      const pageRows = extractRows(target.atsKind as BoardKind, res.data)
      if (pageRows === null) return { ok: false, status: res.status, raw: [], bodyError: true, attempts }
      rows = rows.concat(pageRows)
      if (target.atsKind !== 'smartrecruiters' || pageRows.length < SR_PAGE || attempts >= SR_MAX_PAGES) break
      offset += SR_PAGE
    }
    const status = 200
    // India scoping (policy, not drift): SR is server-filtered; others list
    // globally. Tag each row with its board kind so normalize is exact.
    const scoped = rows
      .filter((r) => target.atsKind === 'smartrecruiters' || INDIA_SCOPE_RE.test(locationText(target.atsKind as BoardKind, r)))
      .map((raw): BoardRow => ({ kind: target.atsKind as BoardKind, raw }))
    return { ok: true, status, raw: scoped, attempts }
  },

  normalize(rawTagged: unknown, target: FetchTarget): NormalizedJob | null {
    const { kind, raw: j } = (rawTagged ?? {}) as BoardRow
    if (!j || typeof j !== 'object' || !kind) return null
    const company = boardCompany(kind, j, target)

    if (kind === 'greenhouse') {
      if (typeof j.title !== 'string' || j.id == null) return null
      return {
        title: j.title,
        company,
        city: locationText(kind, j),
        isRemote: /remote/i.test(locationText(kind, j)),
        description: typeof j.content === 'string' ? stripHtml(j.content) : '',
        postedAt: typeof j.updated_at === 'string' ? j.updated_at : null,
        validThrough: null, // boards expire by delisting (board-poll-miss), not dates
        externalId: String(j.id),
        viaSite: 'greenhouse',
        applyOptions: typeof j.absolute_url === 'string' ? [{ url: j.absolute_url, isDirect: true }] : [],
      }
    }
    if (kind === 'lever') {
      if (typeof j.text !== 'string' || typeof j.id !== 'string') return null
      return {
        title: j.text,
        company,
        city: locationText(kind, j),
        isRemote: /remote/i.test(locationText(kind, j)),
        description: typeof j.descriptionPlain === 'string' ? j.descriptionPlain : typeof j.description === 'string' ? stripHtml(j.description) : '',
        postedAt: typeof j.createdAt === 'number' ? new Date(j.createdAt).toISOString() : null,
        validThrough: null,
        externalId: j.id,
        viaSite: 'lever',
        applyOptions: typeof j.hostedUrl === 'string' ? [{ url: j.hostedUrl, isDirect: true }] : [],
      }
    }
    if (kind === 'smartrecruiters') {
      if (typeof j.name !== 'string' || j.id == null) return null
      // Bare city ONLY — the combined 'Pune, IN' locationText is for the
      // India filter, but locationKey()'s alias table needs the naked metro
      // or SR rows mint keys like 'pune,-in' and never merge with the rest
      // of the metro corpus (Codex on #513 round-3). Ditto location.remote.
      const srLoc = j.location as Record<string, unknown> | undefined
      const srCity = typeof srLoc?.city === 'string' ? srLoc.city : ''
      const srRemote = srLoc?.remote === true || srLoc?.remote === 'true'
      // NEVER the API `ref` (api.smartrecruiters.com detail endpoint — not a
      // candidate-facing page; Codex on #513, P1). Prefer a provider-sent
      // public applyUrl; else construct the public posting URL.
      const sentApply = typeof j.applyUrl === 'string' && !/api\.smartrecruiters\.com/i.test(j.applyUrl) ? j.applyUrl : null
      // Canonical public form is `{id}-{title-slug}` (matches SR's own
      // postingUrl). Live-verified 2026-07-13: the id prefix alone resolves
      // (200 + full SSR content, slug tail cosmetic), but we mint the
      // canonical form since the list row hands us the title for free
      // (Codex on #513 round-5).
      const titleSlug = j.name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '')
      const applyUrl = sentApply ?? `https://jobs.smartrecruiters.com/${target.kind === 'board' ? target.slug : ''}/${String(j.id)}${titleSlug ? `-${titleSlug}` : ''}`
      const jobAd = (j.jobAd as Record<string, unknown>)?.sections as Record<string, { text?: string }> | undefined
      const description = jobAd
        ? Object.values(jobAd).map((s) => (typeof s?.text === 'string' ? stripHtml(s.text) : '')).join(' ')
        : ''
      return {
        title: j.name,
        company,
        city: srCity,
        isRemote: srRemote,
        description,
        postedAt: typeof j.releasedDate === 'string' ? j.releasedDate : null,
        validThrough: null,
        externalId: String(j.id),
        viaSite: 'smartrecruiters',
        applyOptions: [{ url: applyUrl, isDirect: true }],
      }
    }
    if (kind === 'ashby') {
      if (typeof j.title !== 'string' || typeof j.id !== 'string') return null
      return {
        title: j.title,
        company,
        city: locationText(kind, j),
        isRemote: !!j.isRemote,
        description: typeof j.descriptionHtml === 'string' ? stripHtml(j.descriptionHtml) : '',
        postedAt: typeof j.publishedAt === 'string' ? j.publishedAt : null,
        validThrough: null,
        externalId: j.id,
        viaSite: 'ashby',
        applyOptions: typeof j.jobUrl === 'string' ? [{ url: j.jobUrl, isDirect: true }] : [],
      }
    }
    return null
  },

  classifyApplyUrl,
}
