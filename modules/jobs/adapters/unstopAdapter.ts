import { fetchJSONWithRetry } from '@shared/fetchJSONWithRetry'
import { classifyApplyUrl } from '../services/qualityGate'
import type { FetchResult, FetchTarget, JobSourceAdapter, NormalizedJob } from './types'

/**
 * Unstop adapter (INGESTION §6 item 6 — public API, `regn_open` filter).
 * Access pattern validated by the probe: robots explicitly
 * `Allow: /api/public/*`, so the search endpoint is invited access by the
 * provider's own declaration. List-only v1 (SR precedent): item text may
 * be short → those rows land shortJd-flagged by the quality gate rather
 * than silently dropped; no per-item detail calls in v1.
 *
 * Policy filter at fetch: registration-closed items never enter (the
 * user-facing promise is an OPEN application path). Ships behind a
 * disabled JobSourceConfig row like every source.
 */

const API = 'https://unstop.com/api/public/opportunity/search-result'
const PAGES_PER_CYCLE = 3
const PER_PAGE = 15

interface UnstopItem {
  id?: number | string
  title?: string
  organisation?: { name?: string } | null
  public_url?: string
  regnRequirements?: { remain_days?: number } | null
  region?: string
  details?: string
  description?: string
  jobDetail?: { locations?: string[] } | null
  start_date?: string
  end_date?: string
  status?: string
  regn_open?: boolean | number
}

interface UnstopEnvelope {
  data?: { data?: UnstopItem[] } | UnstopItem[]
}

function itemsOf(body: UnstopEnvelope): UnstopItem[] | null {
  const d = body?.data
  if (Array.isArray(d)) return d
  if (d && Array.isArray((d as { data?: UnstopItem[] }).data)) return (d as { data: UnstopItem[] }).data!
  return null
}

function stripHtml(html: string): string {
  return html
    .replace(/<[^>]+>/g, ' ')
    .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&#?\w+;/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

export const unstopAdapter: JobSourceAdapter = {
  sourceId: 'unstop',
  kind: 'public-api',

  buildTargets() {
    // Newest-first list pages; merge-by-sourceKey makes re-reads idempotent
    // and the delisting/expiry lifecycle handles closures.
    return Array.from({ length: PAGES_PER_CYCLE }, (_, i) => ({
      kind: 'feed' as const,
      feedId: 'unstop:jobs',
      page: i + 1,
      perPage: PER_PAGE,
    }))
  },

  async fetch(target: FetchTarget): Promise<FetchResult> {
    if (target.kind !== 'feed') return { ok: false, status: 0, raw: [], attempts: 0 }
    const url = `${API}?opportunity=jobs&per_page=${target.perPage}&page=${target.page}`
    const res = await fetchJSONWithRetry<UnstopEnvelope>(
      url,
      { headers: { 'User-Agent': 'InterviewPrepGuruBot/1.0 (+https://www.interviewprep.guru/jobs-bot)' } },
      { maxRetries: 1, timeoutMs: 15000 }
    )
    if (!res.ok) return { ok: false, status: res.status, raw: [], attempts: 1 }
    const items = itemsOf(res.data as UnstopEnvelope)
    // Unexpected envelope = schema drift = FAILED fetch (Codex #536): the
    // health machine must degrade, never record a clean zero-row sync.
    if (!items) return { ok: false, status: res.status, raw: [], bodyError: true, attempts: 1 }
    // Policy: only OPEN registrations enter (never advertise a closed path).
    // regn_open is AUTHORITATIVE when present (probe mapping): an explicit
    // false/0 is a closed path no matter what remain_days says; the
    // remain_days fallback applies only when regn_open is absent.
    const open = items.filter((it) =>
      it.regn_open === true || it.regn_open === 1 ||
      (it.regn_open == null && (it.regnRequirements?.remain_days ?? 0) > 0)
    )
    return { ok: true, status: res.status, raw: open, attempts: 1 }
  },

  normalize(rawIn: unknown, _target: FetchTarget): NormalizedJob | null {
    const it = rawIn as UnstopItem
    const title = typeof it?.title === 'string' ? it.title.trim() : ''
    const company = typeof it?.organisation?.name === 'string' ? it.organisation.name.trim() : ''
    if (!title || !company) return null // drift: list item without its core fields
    const publicUrl = typeof it.public_url === 'string' && it.public_url.startsWith('http') ? it.public_url : null
    if (!publicUrl) return null // an apply path is the product's whole promise

    const locations = it.jobDetail?.locations
    const city = Array.isArray(locations) && typeof locations[0] === 'string' ? locations[0] : (typeof it.region === 'string' ? it.region : '')

    return {
      title,
      company,
      city,
      isRemote: /remote/i.test(city) || /remote/i.test(title),
      // details || description — the probe's canonical text mapping; an
      // empty body here would short-JD flag a posting that HAS a JD.
      description: stripHtml(typeof it.details === 'string' && it.details ? it.details : typeof it.description === 'string' ? it.description : ''),
      postedAt: typeof it.start_date === 'string' ? it.start_date : null,
      validThrough: typeof it.end_date === 'string' ? it.end_date : null,
      externalId: it.id != null ? String(it.id) : null,
      viaSite: 'unstop',
      applyOptions: [{ url: publicUrl, publisher: 'unstop', isDirect: false }],
    }
  },

  classifyApplyUrl,
}
