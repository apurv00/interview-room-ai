import { describe, it, expect, vi } from 'vitest'
import { jsearchAdapter, buildHarvestBuckets } from '@jobs'
import type { FetchTarget } from '@jobs'

const { mockFetchJSONWithRetry } = vi.hoisted(() => ({
  mockFetchJSONWithRetry: vi.fn(),
}))
vi.mock('@shared/fetchJSONWithRetry', () => ({
  fetchJSONWithRetry: mockFetchJSONWithRetry,
}))

const bucketTarget: FetchTarget = { kind: 'bucket', bucketId: 'backend:in', query: 'backend developer india', datePostedWindow: 'week', page: 1 }

// Fixture mirrors the probe-validated JSearch wire shape (PR #503).
const RAW = {
  job_id: 'abc123',
  job_title: 'Backend Developer',
  employer_name: 'Acme Pvt Ltd',
  job_city: 'Pune',
  job_is_remote: false,
  job_description: 'Build APIs. '.repeat(50),
  job_posted_at_datetime_utc: '2026-07-10T00:00:00Z',
  job_offer_expiration_datetime_utc: '2026-08-01T00:00:00Z',
  job_publisher: 'LinkedIn',
  job_apply_link: 'https://www.linkedin.com/jobs/view/1',
  apply_options: [
    { apply_link: 'https://boards.greenhouse.io/acme/jobs/1', publisher: 'Greenhouse', is_direct: true },
  ],
}

describe('jsearchAdapter.normalize', () => {
  it('maps the probe-validated wire shape, retaining validThrough and externalId', () => {
    const n = jsearchAdapter.normalize(RAW, bucketTarget)
    expect(n).not.toBeNull()
    expect(n!.title).toBe('Backend Developer')
    expect(n!.company).toBe('Acme Pvt Ltd')
    expect(n!.validThrough).toBe('2026-08-01T00:00:00Z')
    expect(n!.externalId).toBe('abc123')
    expect(n!.viaSite).toBe('linkedin')
    expect(n!.domainHint).toBe('backend')
    // job_apply_link joins apply_options without duplication
    expect(n!.applyOptions.map((o) => o.url)).toEqual([
      'https://boards.greenhouse.io/acme/jobs/1',
      'https://www.linkedin.com/jobs/view/1',
    ])
  })

  it('returns null (COUNTED drift) when load-bearing fields are missing', () => {
    expect(jsearchAdapter.normalize({ employer_name: 'X' }, bucketTarget)).toBeNull()
    expect(jsearchAdapter.normalize({ job_title: 'Dev' }, bucketTarget)).toBeNull()
    expect(jsearchAdapter.normalize(null, bucketTarget)).toBeNull()
  })

  it('falls back city -> state and tolerates absent optional fields', () => {
    const n = jsearchAdapter.normalize({ job_title: 'Dev', employer_name: 'X', job_state: 'Maharashtra' }, bucketTarget)
    expect(n!.city).toBe('Maharashtra')
    expect(n!.applyOptions).toEqual([])
    expect(n!.postedAt).toBeNull()
  })
})

describe('jsearchAdapter.buildTargets', () => {
  it('emits one page-1 target per harvest bucket with cursor-derived windows', () => {
    const buckets = buildHarvestBuckets()
    const targets = jsearchAdapter.buildTargets(
      { sourceId: 'jsearch', enabled: true },
      [{ bucket: 'backend:in', newestPostedAt: new Date(Date.now() - 2 * 3600_000) }]
    )
    expect(targets).toHaveLength(buckets.length)
    const backend = targets.find((t) => t.kind === 'bucket' && t.bucketId === 'backend:in')
    expect(backend && t(backend).datePostedWindow).toBe('day') // fresh cursor -> smallest window
    const other = targets.find((t) => t.kind === 'bucket' && t.bucketId === 'frontend:in')
    expect(other && t(other).datePostedWindow).toBe('week') // no cursor -> full window
    function t(x: FetchTarget) { return x as Extract<FetchTarget, { kind: 'bucket' }> }
  })

  it('disabled source emits nothing', () => {
    expect(jsearchAdapter.buildTargets({ sourceId: 'jsearch', enabled: false }, [])).toEqual([])
  })

  it('an authority revoke blocks the metered request and is not a provider-health error', async () => {
    const previousKey = process.env.RAPIDAPI_KEY
    process.env.RAPIDAPI_KEY = 'test-key'
    const beforePhysicalRequest = vi.fn().mockResolvedValue(false)
    mockFetchJSONWithRetry.mockImplementationOnce(async (_url, _init, options) => {
      const allowed = await options.beforePhysicalRequest()
      return allowed
        ? { ok: true, data: { data: [] }, status: 200, attempts: 1 }
        : { ok: false, status: 0, error: 'source-authority-changed', attempts: 0, authorityChanged: true }
    })
    try {
      const res = await jsearchAdapter.fetch(bucketTarget, { beforePhysicalRequest })
      expect(res).toEqual({ ok: false, status: 0, raw: [], attempts: 0, authorityChanged: true })
      expect(beforePhysicalRequest).toHaveBeenCalledOnce()
    } finally {
      if (previousKey === undefined) delete process.env.RAPIDAPI_KEY
      else process.env.RAPIDAPI_KEY = previousKey
    }
  })
})

describe('harvest matrix', () => {
  it('covers every taxonomy domain at country level, with remote variants except site-bound trades', () => {
    const buckets = buildHarvestBuckets()
    const ids = new Set(buckets.map((b) => b.id))
    expect(ids.has('mechanical:in')).toBe(true)     // the once-missing domains harvest too
    expect(ids.has('backend:in')).toBe(true)
    expect(ids.has('civil:remote')).toBe(false)     // site-bound: no remote cell
    expect(ids.has('backend:remote')).toBe(true)
  })

  it('is city-free (DECISIONS #21/#23): every cell is country or remote, none metro-sliced', () => {
    const buckets = buildHarvestBuckets()
    for (const b of buckets) {
      // Regression guard for the ruling: no bucket keys on, or queries for, a metro.
      expect(b.id.endsWith(':in') || b.id.endsWith(':remote')).toBe(true)
      expect(b.query.toLowerCase()).not.toMatch(
        /\b(bengaluru|bangalore|mumbai|delhi|ncr|hyderabad|pune|chennai|gurgaon|gurugram|noida)\b/,
      )
    }
    // One country cell per domain; a remote cell for every domain except the
    // three site-bound trades — so exactly two cells per remote-eligible domain.
    const country = buckets.filter((b) => b.id.endsWith(':in')).length
    const remote = buckets.filter((b) => b.id.endsWith(':remote')).length
    expect(remote).toBe(country - 3)
    expect(buckets.length).toBe(country + remote)
  })
})
