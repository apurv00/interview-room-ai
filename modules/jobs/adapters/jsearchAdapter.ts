import { fetchJSONWithRetry } from '@shared/fetchJSONWithRetry'
import { classifyApplyUrl } from '../services/qualityGate'
import { buildHarvestBuckets } from '../config/bucketMatrix'
import type { AdapterFetchOptions, FetchResult, FetchTarget, JobSourceAdapter, NormalizedJob } from './types'

/**
 * JSearch adapter (INGESTION §1 backbone; shapes probe-validated on PR #503).
 *
 * Billing reality drives every knob: RapidAPI bills ERROR responses too, so
 * maxRetries stays 1 (a retry storm burns quota before the health machine
 * reacts) and attempts are metered physically. A 200 carrying an
 * error-shaped envelope is an ERROR, not zero supply.
 *
 * Freshness cursors (§4.4): page-1 targets use the smallest date_posted
 * window covering the bucket's newestPostedAt — pagination beyond page 1 is
 * the sync job's call (it knows the already-known rate).
 */

const JSEARCH_HOST = 'jsearch.p.rapidapi.com'

interface JSearchEnvelope {
  status?: string
  data?: unknown[]
}

function windowFor(newestPostedAt?: Date | null): 'day' | '3days' | 'week' {
  if (!newestPostedAt) return 'week'
  const ageH = (Date.now() - new Date(newestPostedAt).getTime()) / 3_600_000
  if (ageH <= 20) return 'day'
  if (ageH <= 68) return '3days'
  return 'week'
}

export const jsearchAdapter: JobSourceAdapter = {
  sourceId: 'jsearch',
  kind: 'aggregator-api',

  buildTargets(config, cursors) {
    if (!config.enabled) return []
    const byBucket = new Map(cursors.map((c) => [c.bucket, c]))
    return buildHarvestBuckets().map((b) => ({
      kind: 'bucket' as const,
      bucketId: b.id,
      query: b.query,
      datePostedWindow: windowFor(byBucket.get(b.id)?.newestPostedAt ?? null),
      page: 1,
    }))
  },

  async fetch(target: FetchTarget, options?: AdapterFetchOptions): Promise<FetchResult> {
    if (target.kind !== 'bucket') return { ok: false, status: 0, raw: [], attempts: 0 }
    const key = process.env.RAPIDAPI_KEY
    if (!key) return { ok: false, status: 0, raw: [], attempts: 0 }
    const u = new URL(`https://${JSEARCH_HOST}/search`)
    u.searchParams.set('query', target.query)
    u.searchParams.set('page', String(target.page))
    u.searchParams.set('num_pages', '1')
    u.searchParams.set('date_posted', target.datePostedWindow)
    u.searchParams.set('country', 'in')

    const res = await fetchJSONWithRetry<JSearchEnvelope>(
      u.toString(),
      { headers: { 'x-rapidapi-key': key, 'x-rapidapi-host': JSEARCH_HOST } },
      // 15s: JSearch typically answers in 1-3s; the ceiling exists so a
      // worst-case bucket (3 pages x timeout) still fits one 60s step
      // (Codex on #511).
      { maxRetries: 1, timeoutMs: 15000, beforePhysicalRequest: options?.beforePhysicalRequest }
    )
    if (!res.ok) {
      if (res.authorityChanged) return { ok: false, status: 0, raw: [], attempts: res.attempts ?? 0, authorityChanged: true }
      return { ok: false, status: res.status, raw: [], attempts: 1 }
    }
    const body = res.data
    if (!body || (body.status && body.status !== 'OK') || !Array.isArray(body.data)) {
      return { ok: false, status: res.status, raw: [], bodyError: true, attempts: 1 }
    }
    return { ok: true, status: res.status, raw: body.data, attempts: 1 }
  },

  normalize(raw: unknown, target: FetchTarget): NormalizedJob | null {
    const j = raw as Record<string, unknown>
    if (!j || typeof j !== 'object') return null
    // Drift definition: the fields the pipeline cannot proceed without.
    if (typeof j.job_title !== 'string' || typeof j.employer_name !== 'string') return null

    const applyOptions = (Array.isArray(j.apply_options) ? j.apply_options : [])
      .map((o) => {
        const opt = o as Record<string, unknown>
        return {
          url: typeof opt.apply_link === 'string' ? opt.apply_link : '',
          publisher: typeof opt.publisher === 'string' ? opt.publisher : undefined,
          isDirect: !!opt.is_direct,
        }
      })
      .filter((o) => o.url)
    if (typeof j.job_apply_link === 'string' && j.job_apply_link && !applyOptions.some((o) => o.url === j.job_apply_link)) {
      applyOptions.push({
        url: j.job_apply_link,
        publisher: typeof j.job_publisher === 'string' ? j.job_publisher : undefined,
        isDirect: !!j.job_apply_is_direct,
      })
    }

    return {
      title: j.job_title,
      company: j.employer_name,
      city: (typeof j.job_city === 'string' && j.job_city) || (typeof j.job_state === 'string' && j.job_state) || '',
      isRemote: !!j.job_is_remote,
      description: typeof j.job_description === 'string' ? j.job_description : '',
      postedAt: typeof j.job_posted_at_datetime_utc === 'string' ? j.job_posted_at_datetime_utc : null,
      // Expiration must reach the quality gate — dropping it let expired
      // postings count as usable supply (Codex on #503).
      validThrough: typeof j.job_offer_expiration_datetime_utc === 'string' ? j.job_offer_expiration_datetime_utc : null,
      // JSearch job_ids ROTATE between fetches — identity must not lean on
      // them for merging (§4.2 amendment 1); they exist for sourceKey
      // refresh short-circuits only.
      externalId: typeof j.job_id === 'string' ? j.job_id : null,
      viaSite: typeof j.job_publisher === 'string' ? j.job_publisher.toLowerCase() : '',
      applyOptions,
      domainHint: target.kind === 'bucket' ? target.bucketId.split(':')[0] : undefined,
    }
  },

  classifyApplyUrl,
}
