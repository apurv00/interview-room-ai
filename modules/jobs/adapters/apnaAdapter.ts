import { classifyApplyUrl } from '../services/qualityGate'
import type { FetchResult, FetchTarget, JobSourceAdapter, NormalizedJob } from './types'

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

async function getText(url: string, timeoutMs = 15000): Promise<{ ok: boolean; status: number; text: string }> {
  try {
    const res = await fetch(url, { headers: UA, signal: AbortSignal.timeout(timeoutMs) })
    return { ok: res.ok, status: res.status, text: res.ok ? await res.text() : '' }
  } catch {
    return { ok: false, status: 0, text: '' }
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
        slugFilter: { metros: [newestIso('apna:external') ?? ''], domainPatterns: [], maxDetailFetches: 40 },
        cursorBucket: 'apna:external',
      },
      {
        kind: 'sitemap' as const,
        shardUrl: `${SITEMAP_INDEX}#active`,
        slugFilter: { metros: [newestIso('apna:active') ?? ''], maxDetailFetches: 40, domainPatterns: [] },
        cursorBucket: 'apna:active',
      },
    ]
  },

  async fetch(target: FetchTarget): Promise<FetchResult> {
    if (target.kind !== 'sitemap') return { ok: false, status: 0, raw: [], attempts: 0 }
    const wantExternal = target.shardUrl.endsWith('#external')
    const sinceIso = target.slugFilter.metros[0] || null
    const cap = target.slugFilter.maxDetailFetches
    let attempts = 0

    const idx = await getText(SITEMAP_INDEX); attempts++
    if (!idx.ok) return { ok: false, status: idx.status, raw: [], attempts }
    const jobIndex = extractLocs(idx.text).find((u) => /job-listing-sitemap\.xml/.test(u))
    if (!jobIndex) return { ok: true, status: 200, raw: [], bodyError: true, attempts }

    const shardIdx = await getText(jobIndex); attempts++
    if (!shardIdx.ok) return { ok: false, status: shardIdx.status, raw: [], attempts }
    const allShards = extractLocs(shardIdx.text)
    const shards = allShards.filter((u) =>
      wantExternal ? /external-job-listings/.test(u) : /active-job-listings/.test(u)
    )
    if (!shards.length) return { ok: true, status: 200, raw: [], attempts }

    // Collect candidate URLs newer than the cursor, interleaved across
    // shards so one shard never starves the rest, capped for the step
    // budget (~cap × (fetch + delay) must stay < 60s).
    const perShard: Array<Array<{ loc: string; lastmod: string | null }>> = []
    for (const shard of shards.slice(0, 6)) {
      const res = await getText(shard); attempts++
      if (!res.ok) continue
      perShard.push(
        extractUrlEntries(res.text).filter(
          (e) => /apna\.co\/job/.test(e.loc) && (!sinceIso || !e.lastmod || e.lastmod > sinceIso)
        )
      )
      await sleep(150)
    }
    const candidates: Array<{ loc: string; lastmod: string | null }> = []
    for (let i = 0; candidates.length < cap; i++) {
      let added = false
      for (const list of perShard) {
        if (i < list.length && candidates.length < cap) { candidates.push(list[i]); added = true }
      }
      if (!added) break
    }

    const raw: ApnaRaw[] = []
    for (const c of candidates) {
      const page = await getText(c.loc, 12000); attempts++
      if (page.ok) {
        const jsonld = extractJobPostingJsonLd(page.text)
        // Policy floor (fetch-level, like the board adapter's India scope):
        // sub-400-char stubs never enter; missing JSON-LD flows to
        // normalize-null = counted drift.
        const desc = jsonld && typeof jsonld.description === 'string' ? stripHtml(jsonld.description) : ''
        if (!jsonld || desc.length >= JD_FLOOR_CHARS) {
          raw.push({ url: c.loc, jsonld })
        }
      }
      await sleep(DETAIL_DELAY_MS)
    }
    return { ok: true, status: 200, raw, attempts }
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
