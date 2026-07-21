import { classifyApplyUrl } from '../services/qualityGate'
import { pinnedHttpRequest } from '@shared/pinnedHttpClient'
import type { AdapterFetchOptions, BeforePhysicalRequest, FetchResult, FetchTarget, JobSourceAdapter, NormalizedJob } from './types'

/**
 * apna adapter (INGESTION §6 item 5 — sitemapJsonLd base, ≥400-char JD
 * floor). Access pattern validated by the liquidity probe's `india`
 * command and the §"legal standard" four-layer analysis: permissive robots
 * that ADVERTISE the sitemap, JSON-LD JobPosting on detail pages, polite
 * cadence (daily), honest branded User-Agent with a contact URL. The
 * founder's pre-ENABLE checklist (ToS browser read + counsel skim) gates
 * the config flip, not this code — the row ships disabled.
 *
 * Shape: sitemap index → job-listing shard index → active-job-listings
 * shards (+ the ~900-URL external-job-listings shard FIRST — higher apply
 * fidelity). Each sync target detail-fetches a BOUNDED number of unseen
 * URLs (maxDetailFetches, politeness-delayed), so the corpus builds over
 * days at ~1 cycle/day — deliberate: politeness is a legal-layer
 * commitment, not a tunable.
 *
 * Policy filters at FETCH (drift semantics stay reserved for schema
 * breakage, board-adapter precedent): sub-400-char JDs are stubs (43%
 * measured) and never enter; rows without JSON-LD JobPosting count as
 * drift via normalize-null.
 */

const UA = { 'User-Agent': 'InterviewPrepGuruBot/1.0 (+https://www.interviewprep.guru/jobs-bot)' }
const SITEMAP_INDEX = 'https://apna.co/api/sitemap-index.xml'
const DETAIL_DELAY_MS = 400
const JD_FLOOR_CHARS = 400
/** Worst-case step budget (Codex #536): details×timeout + shards×timeout
 *  must clear the 300s Inngest route maxDuration with headroom —
 *  12×8s + 4×15s + index/shard-idx ≈ 192s. Throughput is deliberately
 *  slow; politeness and step-safety beat speed. */
const MAX_DETAILS_PER_TARGET = 12
const DETAIL_TIMEOUT_MS = 8000
const SHARDS_PER_TARGET = 4
const SITEMAP_BODY_CAP_BYTES = 16 * 1024 * 1024
const DETAIL_BODY_CAP_BYTES = 2 * 1024 * 1024

type ApnaUrlClass = 'job-index' | 'shard' | 'detail'

/**
 * Sitemap locations are provider data, not trusted request targets. Binding
 * every discovered location back to the compiled-in Apna origin prevents an
 * attacker-controlled hostname (and therefore attacker-controlled DNS) from
 * reaching fetch. Redirects are disabled separately in getText, so the host
 * cannot change after this check.
 */
function canonicalApnaUrl(raw: string, urlClass: ApnaUrlClass): string | null {
  let parsed: URL
  try {
    parsed = new URL(raw)
  } catch {
    return null
  }

  if (
    parsed.protocol !== 'https:'
    || parsed.hostname.toLowerCase() !== 'apna.co'
    || parsed.port !== ''
    || parsed.username !== ''
    || parsed.password !== ''
    || parsed.search !== ''
    || parsed.hash !== ''
  ) return null

  const validPath = urlClass === 'job-index'
    ? parsed.pathname === '/job-listing-sitemap.xml'
    : urlClass === 'shard'
      ? /^\/(?:active|external)-job-listings-[A-Za-z0-9_-]+\.xml$/.test(parsed.pathname)
      : /^\/job\/[A-Za-z0-9][A-Za-z0-9_-]*(?:\/[A-Za-z0-9][A-Za-z0-9_-]*)*\/?$/.test(parsed.pathname)

  return validPath ? parsed.href : null
}

async function getText(
  url: string,
  timeoutMs = 15000,
  maxResponseBytes = SITEMAP_BODY_CAP_BYTES,
  beforePhysicalRequest?: BeforePhysicalRequest,
): Promise<{ ok: boolean; status: number; text: string; attempts: number; authorityChanged?: true; requestRejected?: string }> {
  const result = await pinnedHttpRequest({
    url,
    method: 'GET',
    headers: UA,
    signal: AbortSignal.timeout(timeoutMs),
    maxResponseBytes,
    beforePhysicalRequest,
  })
  if (result.kind === 'authority-changed') {
    return { ok: false, status: 0, text: '', attempts: result.socketAttempts, authorityChanged: true }
  }
  if (result.kind === 'request-rejected') {
    return {
      ok: false,
      status: 0,
      text: '',
      attempts: result.socketAttempts,
      requestRejected: result.reason,
    }
  }
  if (result.kind === 'network-error') {
    return { ok: false, status: 0, text: '', attempts: result.socketAttempts }
  }
  return {
    ok: result.status >= 200 && result.status < 300,
    status: result.status,
    text: result.status >= 200 && result.status < 300 ? result.body.toString('utf8') : '',
    attempts: result.socketAttempts,
  }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

/** exec-loop matcher (tsconfig target predates matchAll iteration). */
function allMatches(re: RegExp, text: string): RegExpExecArray[] {
  const out: RegExpExecArray[] = []
  const r = new RegExp(re.source, re.flags)
  let m: RegExpExecArray | null
  while ((m = r.exec(text)) !== null) {
    out.push(m)
    if (m.index === r.lastIndex) r.lastIndex++
  }
  return out
}

/** <loc> values from a sitemap document. */
export function extractLocs(xml: string): string[] {
  return allMatches(/<loc>\s*([^<\s]+)\s*<\/loc>/g, xml).map((m) => m[1])
}

/** {loc, lastmod} pairs — lastmod gates re-fetch against the cursor. */
export function extractUrlEntries(xml: string): Array<{ loc: string; lastmod: string | null }> {
  return allMatches(/<url>([\s\S]*?)<\/url>/g, xml).map((m) => {
    const block = m[1]
    const loc = block.match(/<loc>\s*([^<\s]+)\s*<\/loc>/)?.[1] ?? ''
    const lastmod = block.match(/<lastmod>\s*([^<\s]+)\s*<\/lastmod>/)?.[1] ?? null
    return { loc, lastmod }
  }).filter((e) => e.loc)
}

/** First JSON-LD JobPosting object on a detail page, or null. */
export function extractJobPostingJsonLd(html: string): Record<string, unknown> | null {
  for (const m of allMatches(/<script[^>]*type="application\/ld\+json"[^>]*>([\s\S]*?)<\/script>/g, html)) {
    try {
      const parsed = JSON.parse(m[1])
      const candidates = Array.isArray(parsed) ? parsed : [parsed]
      for (const c of candidates) {
        if (c && typeof c === 'object' && (c['@type'] === 'JobPosting' || (Array.isArray(c['@type']) && c['@type'].includes('JobPosting')))) {
          return c as Record<string, unknown>
        }
      }
    } catch { /* malformed block — keep scanning */ }
  }
  return null
}

function stripHtml(html: string): string {
  return html
    .replace(/<[^>]+>/g, ' ')
    .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&#?\w+;/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

interface ApnaRaw {
  url: string
  jsonld: Record<string, unknown> | null
}

export const apnaAdapter: JobSourceAdapter = {
  sourceId: 'apna',
  kind: 'sitemap-jsonld',

  buildTargets(_config, cursors) {
    const byBucket = new Map(cursors.map((c) => [c.bucket, c]))
    const newestIso = (bucket: string) => {
      const d = byBucket.get(bucket)?.newestPostedAt
      return d ? new Date(d).toISOString() : null
    }
    // Two bounded targets per cycle: the high-fidelity external shard, then
    // the main active-listings shards (interleaved sampling inside fetch).
    return [
      {
        kind: 'sitemap' as const,
        shardUrl: `${SITEMAP_INDEX}#external`,
        slugFilter: { metros: [newestIso('apna:external') ?? ''], domainPatterns: [], maxDetailFetches: MAX_DETAILS_PER_TARGET },
        cursorBucket: 'apna:external',
      },
      {
        kind: 'sitemap' as const,
        shardUrl: `${SITEMAP_INDEX}#active`,
        slugFilter: { metros: [newestIso('apna:active') ?? ''], maxDetailFetches: MAX_DETAILS_PER_TARGET, domainPatterns: [] },
        cursorBucket: 'apna:active',
      },
    ]
  },

  async fetch(target: FetchTarget, options?: AdapterFetchOptions): Promise<FetchResult> {
    if (target.kind !== 'sitemap') return { ok: false, status: 0, raw: [], attempts: 0 }
    const wantExternal = target.shardUrl.endsWith('#external')
    const sinceIso = target.slugFilter.metros[0] || null
    const cap = target.slugFilter.maxDetailFetches
    let attempts = 0

    const idx = await getText(SITEMAP_INDEX, 15000, SITEMAP_BODY_CAP_BYTES, options?.beforePhysicalRequest)
    attempts += idx.attempts
    if (idx.authorityChanged) return { ok: false, status: 0, raw: [], attempts, authorityChanged: true }
    if (idx.requestRejected) return { ok: false, status: 0, raw: [], attempts, requestRejected: idx.requestRejected }
    if (!idx.ok) return { ok: false, status: idx.status, raw: [], attempts }
    const jobIndex = extractLocs(idx.text)
      .map((url) => canonicalApnaUrl(url, 'job-index'))
      .find((url): url is string => url !== null)
    // Schema drift (index no longer names the job sitemap) = FAILED fetch —
    // health must degrade, never a clean zero-row sync (Codex #536).
    if (!jobIndex) return { ok: false, status: 200, raw: [], bodyError: true, attempts }

    const shardIdx = await getText(jobIndex, 15000, SITEMAP_BODY_CAP_BYTES, options?.beforePhysicalRequest)
    attempts += shardIdx.attempts
    if (shardIdx.authorityChanged) return { ok: false, status: 0, raw: [], attempts, authorityChanged: true }
    if (shardIdx.requestRejected) return { ok: false, status: 0, raw: [], attempts, requestRejected: shardIdx.requestRejected }
    if (!shardIdx.ok) return { ok: false, status: shardIdx.status, raw: [], attempts }
    const allShards = extractLocs(shardIdx.text)
      .map((url) => canonicalApnaUrl(url, 'shard'))
      .filter((url): url is string => url !== null)
    const shards = allShards.filter((url) => {
      const pathname = new URL(url).pathname
      return wantExternal
        ? pathname.startsWith('/external-job-listings-')
        : pathname.startsWith('/active-job-listings-')
    })
    if (!shards.length) return { ok: false, status: 200, raw: [], bodyError: true, attempts }

    // Collect candidate URLs newer than the cursor and drain them
    // OLDEST-FIRST (Codex #536): the pipeline's watermark advances to the
    // newest ingested postedAt, so fetching the newest candidates first
    // would strand every older un-fetched URL behind the cursor forever.
    // Oldest-first means the watermark only ever passes exhaustively
    // covered ground; the un-fetched (newer) remainder stays > cursor and
    // drains on later runs. lastmod ≥ datePosted, so any skew re-includes
    // already-fetched rows (merge-idempotent) — the safe direction.
    // Entries WITHOUT lastmod sort last: they cannot be watermarked, so
    // they only consume cap after the dated backlog drains.
    const all: Array<{ loc: string; lastmod: string | null }> = []
    for (const shard of shards.slice(0, SHARDS_PER_TARGET)) {
      const res = await getText(shard, 15000, SITEMAP_BODY_CAP_BYTES, options?.beforePhysicalRequest)
      attempts += res.attempts
      if (res.authorityChanged) return { ok: false, status: 0, raw: [], attempts, authorityChanged: true }
      if (res.requestRejected) return { ok: false, status: 0, raw: [], attempts, requestRejected: res.requestRejected }
      // A failed shard would silently drop EVERY URL it holds while the
      // successful shards advance the cursor past them (Codex #536 — the
      // same never-retried class as detail failures, one level up). Fail
      // the whole target: no cursor advance, health sees the failure.
      if (!res.ok) return { ok: false, status: res.status, raw: [], attempts }
      for (const e of extractUrlEntries(res.text)) {
        const loc = canonicalApnaUrl(e.loc, 'detail')
        if (loc && (!sinceIso || !e.lastmod || e.lastmod > sinceIso)) {
          all.push({ ...e, loc })
        }
      }
      await sleep(150)
    }
    all.sort((x, y) => {
      if (x.lastmod === null) return y.lastmod === null ? 0 : 1
      if (y.lastmod === null) return -1
      return x.lastmod < y.lastmod ? -1 : x.lastmod > y.lastmod ? 1 : 0
    })
    const candidates = all.slice(0, cap)

    const raw: ApnaRaw[] = []
    let transientFailures = 0
    let failStatus = 0
    let watermark: string | null = null
    for (const c of candidates) {
      const page = await getText(c.loc, DETAIL_TIMEOUT_MS, DETAIL_BODY_CAP_BYTES, options?.beforePhysicalRequest)
      attempts += page.attempts
      if (page.authorityChanged) return { ok: false, status: 0, raw, attempts, authorityChanged: true }
      if (page.requestRejected) return { ok: false, status: 0, raw, attempts, requestRejected: page.requestRejected }
      if (page.ok) {
        const jsonld = extractJobPostingJsonLd(page.text)
        // Policy floor (fetch-level, like the board adapter's India scope):
        // sub-400-char stubs never enter; missing JSON-LD flows to
        // normalize-null = counted drift.
        const desc = jsonld && typeof jsonld.description === 'string' ? stripHtml(jsonld.description) : ''
        if (!jsonld || desc.length >= JD_FLOOR_CHARS) {
          raw.push({ url: c.loc, jsonld })
        }
      } else if (page.status === 404 || page.status === 410) {
        // Permanently gone: nothing to ingest — safe for the cursor to
        // pass (the sitemap sheds dead URLs on its own).
      } else {
        // Timeout/5xx = TRANSIENT (Codex #536): if we advanced the cursor
        // past this URL it would never be retried. Count it and fail the
        // fetch below so processTarget skips the cursor commit — the whole
        // batch re-fetches next run (merge-idempotent), completeness
        // beats quota (the #528 rule). 429 wins the reported status so the
        // health machine sees the rate limit (saw429 → degraded).
        transientFailures++
        if (page.status === 429 || failStatus === 0) failStatus = page.status
      }
      if (page.ok || page.status === 404 || page.status === 410) {
        // Watermark in FILTER units (Codex #536): max lastmod among COVERED
        // candidates — fetched or permanently gone both count (a dead
        // oldest URL must not pin the watermark forever). postedAt lags
        // lastmod on updated postings and would livelock the drain.
        if (c.lastmod && (!watermark || c.lastmod > watermark)) watermark = c.lastmod
      }
      await sleep(DETAIL_DELAY_MS)
    }
    if (transientFailures > 0) return { ok: false, status: failStatus, raw, attempts }
    return { ok: true, status: 200, raw, watermark: watermark ?? undefined, attempts }
  },

  normalize(rawIn: unknown, _target: FetchTarget): NormalizedJob | null {
    const r = rawIn as ApnaRaw
    const j = r?.jsonld
    if (!j || typeof j !== 'object') return null // drift: page without JobPosting JSON-LD
    const title = typeof j.title === 'string' ? j.title.trim() : ''
    const org = (j.hiringOrganization as Record<string, unknown> | undefined)
    const company = org && typeof org.name === 'string' ? org.name.trim() : ''
    const description = typeof j.description === 'string' ? stripHtml(j.description) : ''
    if (!title || !company || !description) return null

    const locBlock = Array.isArray(j.jobLocation) ? j.jobLocation[0] : j.jobLocation
    const address = (locBlock as Record<string, unknown> | undefined)?.address as Record<string, unknown> | undefined
    const city = address && typeof address.addressLocality === 'string' ? address.addressLocality : ''
    const jobLocationType = typeof j.jobLocationType === 'string' ? j.jobLocationType : ''

    // The slug is the stable external id (URL tail without query).
    const slug = r.url.split('?')[0].split('/').filter(Boolean).pop() ?? null

    return {
      title,
      company,
      city,
      isRemote: /TELECOMMUTE/i.test(jobLocationType),
      description,
      postedAt: typeof j.datePosted === 'string' ? j.datePosted : null,
      validThrough: typeof j.validThrough === 'string' ? j.validThrough : null,
      externalId: slug,
      viaSite: 'apna',
      applyOptions: [{ url: r.url, publisher: 'apna', isDirect: false }],
    }
  },

  classifyApplyUrl,
}
