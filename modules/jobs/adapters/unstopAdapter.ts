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
const PER_PAGE = 15

interface UnstopItem {
  id?: number | string
  title?: string
  organisation?: { name?: string } | null
  public_url?: string
  /** Absolute canonical URL — public_url went relative on the live API. */
  seo_url?: string
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

  buildTargets(_config, cursors) {
    // ONE continuing target (Codex #536): the pipeline pages it like a
    // bucket — full-page + known-rate cutoff + per-run page cap — so the
    // backlog beyond the newest pages drains across runs instead of
    // re-reading the same head forever. Merge-by-sourceKey keeps re-read
    // pages idempotent; the incomplete/distrust machinery applies via
    // cursorBucket.
    // Continuation (Codex #536): a cap-exit persists lastPage on the
    // cursor; the next run resumes at lastPage+1 until an exhaustion exit
    // (non-full page / cutoff) resets it to 0 — deep backlogs drain across
    // runs instead of re-sweeping the same head.
    const cont = cursors.find((c) => c.bucket === 'unstop:feed')?.lastPage ?? 0
    return [{
      kind: 'feed' as const,
      feedId: 'unstop:jobs',
      page: cont + 1,
      perPage: PER_PAGE,
      cursorBucket: 'unstop:feed',
    }]
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
    // regn_open is AUTHORITATIVE when present; when ABSENT the probe's
    // exact fallback is status === 'LIVE' (Codex #536 — remain_days can be
    // stale in both directions: live rows without it were dropped, dead
    // rows with leftovers entered).
    const open = items.filter((it) =>
      it.regn_open === true || it.regn_open === 1 ||
      (it.regn_open == null && it.status === 'LIVE')
    )
    // rawPageSize = the UNFILTERED count (Codex #536): a physically-full
    // page of mostly-closed rows must still page onward.
    return { ok: true, status: res.status, raw: open, rawPageSize: items.length, attempts: 1 }
  },

  normalize(rawIn: unknown, _target: FetchTarget): NormalizedJob | null {
    const it = rawIn as UnstopItem
    const title = typeof it?.title === 'string' ? it.title.trim() : ''
    const company = typeof it?.organisation?.name === 'string' ? it.organisation.name.trim() : ''
    if (!title || !company) return null // drift: list item without its core fields
    // Apply URL (first-live-contact drift, 2026-07-19): public_url arrives
    // RELATIVE ('jobs/slug-123') on the live API — the startsWith('http')
    // gate nulled EVERY row (driftNulls:180 → auto-quarantine). Absolute
    // form lives in seo_url; else prefix the site origin onto a clean
    // relative path. The gate itself stays: an apply path is the
    // product's whole promise.
    const publicUrl =
      typeof it.seo_url === 'string' && it.seo_url.startsWith('https://unstop.com/')
        ? it.seo_url
        : typeof it.public_url === 'string' && it.public_url.startsWith('http')
          ? it.public_url
          : typeof it.public_url === 'string' && /^\/?[a-z0-9][\w/-]*$/i.test(it.public_url)
            // One optional leading slash (root-relative '/jobs/foo' —
            // Codex #558); '//host' stays blocked: the char after the
            // optional slash must be alphanumeric.
            ? `https://unstop.com/${it.public_url.replace(/^\//, '')}`
            : null
    if (!publicUrl) return null

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
