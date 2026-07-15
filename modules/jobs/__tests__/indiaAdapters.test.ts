import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

/**
 * apna + Unstop adapters (INGESTION §6 items 5/6). Fixtures mirror the
 * shapes the liquidity probe measured. Invariants: apna's ≥400-char JD
 * floor is a FETCH policy (never drift); missing JSON-LD = normalize-null
 * drift; lastmod gates re-fetch against the cursor; Unstop admits only
 * open registrations and rows with a real public_url; both send the
 * branded contact UA.
 */

const { mockFetchJSON } = vi.hoisted(() => ({ mockFetchJSON: vi.fn() }))
vi.mock('@shared/fetchJSONWithRetry', () => ({ fetchJSONWithRetry: mockFetchJSON }))

import { apnaAdapter, extractLocs, extractUrlEntries, extractJobPostingJsonLd } from '../adapters/apnaAdapter'
import { unstopAdapter } from '../adapters/unstopAdapter'

// ── apna pure extractors ─────────────────────────────────────────────────────

describe('apna sitemap extractors', () => {
  it('extracts locs and lastmod-gated url entries', () => {
    const xml = `<urlset>
      <url><loc>https://apna.co/job/backend-dev-1</loc><lastmod>2026-07-14T00:00:00Z</lastmod></url>
      <url><loc>https://apna.co/job/sales-exec-2</loc></url>
    </urlset>`
    expect(extractLocs(xml)).toEqual(['https://apna.co/job/backend-dev-1', 'https://apna.co/job/sales-exec-2'])
    expect(extractUrlEntries(xml)).toEqual([
      { loc: 'https://apna.co/job/backend-dev-1', lastmod: '2026-07-14T00:00:00Z' },
      { loc: 'https://apna.co/job/sales-exec-2', lastmod: null },
    ])
  })

  it('finds the JobPosting JSON-LD among other blocks, arrays included', () => {
    const html = `<script type="application/ld+json">{"@type":"Organization","name":"x"}</script>
      <script type="application/ld+json">[{"@type":"BreadcrumbList"},{"@type":"JobPosting","title":"Backend Developer"}]</script>`
    expect(extractJobPostingJsonLd(html)).toMatchObject({ title: 'Backend Developer' })
    expect(extractJobPostingJsonLd('<html>no ld</html>')).toBeNull()
    expect(extractJobPostingJsonLd('<script type="application/ld+json">{broken</script>')).toBeNull()
  })
})

// ── apna normalize ───────────────────────────────────────────────────────────

describe('apna normalize', () => {
  const target = { kind: 'sitemap' as const, shardUrl: 'x#active', slugFilter: { metros: [''], domainPatterns: [], maxDetailFetches: 1 } }
  const jsonld = (over: Record<string, unknown> = {}) => ({
    '@type': 'JobPosting',
    title: 'Field Sales Executive',
    hiringOrganization: { name: 'Acme Retail' },
    description: '<p>' + 'Sell things well. '.repeat(30) + '</p>',
    jobLocation: [{ address: { addressLocality: 'Pune' } }],
    datePosted: '2026-07-14',
    validThrough: '2026-08-14',
    ...over,
  })

  it('maps JSON-LD to NormalizedJob with the slug as the stable externalId', () => {
    const n = apnaAdapter.normalize({ url: 'https://apna.co/job/field-sales-executive-77?utm=x', jsonld: jsonld() }, target)!
    expect(n).toMatchObject({
      title: 'Field Sales Executive',
      company: 'Acme Retail',
      city: 'Pune',
      isRemote: false,
      externalId: 'field-sales-executive-77',
      viaSite: 'apna',
      postedAt: '2026-07-14',
      validThrough: '2026-08-14',
    })
    expect(n.applyOptions[0].url).toContain('apna.co/job/')
    expect(n.description).not.toContain('<p>')
  })

  it('TELECOMMUTE marks remote; missing JSON-LD or core fields = drift null', () => {
    expect(apnaAdapter.normalize({ url: 'https://apna.co/job/x', jsonld: jsonld({ jobLocationType: 'TELECOMMUTE' }) }, target)!.isRemote).toBe(true)
    expect(apnaAdapter.normalize({ url: 'https://apna.co/job/x', jsonld: null }, target)).toBeNull()
    expect(apnaAdapter.normalize({ url: 'https://apna.co/job/x', jsonld: jsonld({ title: '' }) }, target)).toBeNull()
    expect(apnaAdapter.normalize({ url: 'https://apna.co/job/x', jsonld: jsonld({ hiringOrganization: {} }) }, target)).toBeNull()
  })
})

// ── apna fetch policy (mocked global fetch) ──────────────────────────────────

describe('apna fetch', () => {
  const INDEX = 'https://apna.co/api/sitemap-index.xml'
  const pageFor = (desc: string) =>
    `<html><script type="application/ld+json">{"@type":"JobPosting","title":"T","hiringOrganization":{"name":"C"},"description":"${desc}"}</script></html>`
  let urls: string[]

  beforeEach(() => {
    urls = []
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      urls.push(url)
      const body =
        url === INDEX
          ? '<sitemapindex><loc>https://apna.co/job-listing-sitemap.xml</loc></sitemapindex>'
          : /job-listing-sitemap\.xml$/.test(url)
            ? '<sitemapindex><loc>https://apna.co/active-job-listings-1.xml</loc><loc>https://apna.co/external-job-listings-1.xml</loc></sitemapindex>'
            : /active-job-listings-1\.xml$/.test(url)
              ? `<urlset>
                  <url><loc>https://apna.co/job/fresh-new</loc><lastmod>2026-07-15T00:00:00Z</lastmod></url>
                  <url><loc>https://apna.co/job/old-seen</loc><lastmod>2026-07-01T00:00:00Z</lastmod></url>
                 </urlset>`
              : /external-job-listings-1\.xml$/.test(url)
                ? '<urlset></urlset>'
                : /job\/fresh-new/.test(url)
                  ? pageFor('Long enough description. '.repeat(30))
                  : pageFor('stub')
      return { ok: true, status: 200, text: async () => body } as Response
    }))
  })
  afterEach(() => vi.unstubAllGlobals())

  it('lastmod-gates against the cursor, fetches only fresh details, sends the branded UA', async () => {
    const [, activeTarget] = apnaAdapter.buildTargets(
      { sourceId: 'apna', enabled: true },
      [{ bucket: 'apna:active', newestPostedAt: new Date('2026-07-10T00:00:00Z') }]
    )
    const res = await apnaAdapter.fetch(activeTarget)
    expect(res.ok).toBe(true)
    // Only the fresh URL got a detail fetch; the pre-cursor one was skipped.
    expect(urls.some((u) => u.includes('job/fresh-new'))).toBe(true)
    expect(urls.some((u) => u.includes('job/old-seen'))).toBe(false)
    expect(res.raw).toHaveLength(1)
    const ua = (vi.mocked(fetch).mock.calls[0][1] as RequestInit).headers as Record<string, string>
    expect(ua['User-Agent']).toContain('interviewprep.guru/jobs-bot')
  })

  it('sub-400-char stubs are dropped at fetch as POLICY (never reach normalize/drift)', async () => {
    vi.mocked(fetch).mockImplementation(async (url: unknown) => {
      const u = String(url)
      const body =
        u === INDEX
          ? '<sitemapindex><loc>https://apna.co/job-listing-sitemap.xml</loc></sitemapindex>'
          : /job-listing-sitemap\.xml$/.test(u)
            ? '<sitemapindex><loc>https://apna.co/active-job-listings-1.xml</loc></sitemapindex>'
            : /active-job-listings-1\.xml$/.test(u)
              ? '<urlset><url><loc>https://apna.co/job/stub-listing</loc><lastmod>2026-07-15T00:00:00Z</lastmod></url></urlset>'
              : pageFor('too short')
      return { ok: true, status: 200, text: async () => body } as Response
    })
    const [, activeTarget] = apnaAdapter.buildTargets({ sourceId: 'apna', enabled: true }, [])
    const res = await apnaAdapter.fetch(activeTarget)
    expect(res.ok).toBe(true)
    expect(res.raw).toHaveLength(0) // stub excluded, not drifted
  })
})

// ── Unstop ───────────────────────────────────────────────────────────────────

describe('unstop adapter', () => {
  const target = { kind: 'feed' as const, feedId: 'unstop:jobs', page: 1, perPage: 15 }
  const item = (over: Record<string, unknown> = {}) => ({
    id: 991,
    title: 'Graduate Engineer Trainee',
    organisation: { name: 'Tata Elxsi' },
    public_url: 'https://unstop.com/jobs/get-991',
    regn_open: true,
    details: '<div>Campus hiring for engineering graduates.</div>',
    jobDetail: { locations: ['Bengaluru'] },
    start_date: '2026-07-10',
    end_date: '2026-08-01',
    ...over,
  })

  beforeEach(() => {
    mockFetchJSON.mockReset()
  })

  it('fetch filters to OPEN registrations only (policy, not drift)', async () => {
    mockFetchJSON.mockResolvedValue({
      ok: true, status: 200,
      data: { data: { data: [item(), item({ id: 992, regn_open: false, regnRequirements: { remain_days: 0 } })] } },
    })
    const res = await unstopAdapter.fetch(target)
    expect(res.ok).toBe(true)
    expect(res.raw).toHaveLength(1)
    expect((res.raw[0] as { id: number }).id).toBe(991)
    // Branded UA on the API call too.
    expect(mockFetchJSON.mock.calls[0][1].headers['User-Agent']).toContain('jobs-bot')
  })

  it('normalize maps items; missing public_url or core fields = null', () => {
    const n = unstopAdapter.normalize(item(), target)!
    expect(n).toMatchObject({
      title: 'Graduate Engineer Trainee',
      company: 'Tata Elxsi',
      city: 'Bengaluru',
      externalId: '991',
      viaSite: 'unstop',
      validThrough: '2026-08-01',
    })
    expect(n.description).not.toContain('<div>')
    expect(unstopAdapter.normalize(item({ public_url: undefined }), target)).toBeNull()
    expect(unstopAdapter.normalize(item({ title: '' }), target)).toBeNull()
    expect(unstopAdapter.normalize(item({ organisation: null }), target)).toBeNull()
  })

  it('error-shaped envelope = bodyError, not a crash', async () => {
    mockFetchJSON.mockResolvedValue({ ok: true, status: 200, data: { nope: true } })
    const res = await unstopAdapter.fetch(target)
    expect(res).toMatchObject({ ok: true, bodyError: true, raw: [] })
  })
})
