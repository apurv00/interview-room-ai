import { describe, it, expect, vi } from 'vitest'
import { gzipSync } from 'zlib'

const { mockFind, mockFindById } = vi.hoisted(() => ({ mockFind: vi.fn(), mockFindById: vi.fn() }))
vi.mock('@shared/db/models', () => ({ JobPosting: { find: mockFind, findById: mockFindById } }))

import { tierAScore, bestApplyTierOf, getFeed, getJobDetail } from '../services/feedService'

const NOW = new Date('2026-07-14T12:00:00Z')

function doc(over: Record<string, unknown> = {}) {
  return {
    _id: 'j1',
    title: 'Backend Engineer',
    company: 'PhonePe',
    locations: ['Bengaluru'],
    locationKeys: ['bengaluru'],
    isRemote: false,
    domain: 'backend',
    postedAt: new Date('2026-07-13T12:00:00Z'),
    salaryText: undefined,
    status: 'open',
    confidentialCompany: false,
    flags: { staffing: false, salaryConflict: false, shortJd: false, repost: false, repostCount: 0 },
    provenance: [{ sourceId: 'gh:phonepe', externalId: '1', sourceKey: 'gh:phonepe:1', applyUrl: 'https://boards.greenhouse.io/x/1', applyTier: 'direct-ats' }],
    ...over,
  }
}

describe('tierAScore (deterministic rank — rules only, §serving honesty)', () => {
  it('apply-path quality orders the tiers; demotions SINK flagged rows but never hide them', () => {
    const direct = tierAScore(doc() as never, {}, NOW)
    const redirect = tierAScore(doc({ provenance: [{ applyTier: 'aggregator-redirect', applyUrl: 'x', sourceId: 's', externalId: 'e', sourceKey: 's:e' }] }) as never, {}, NOW)
    expect(direct).toBeGreaterThan(redirect)
    const flagged = tierAScore(doc({ flags: { staffing: true, shortJd: true, repost: true, repostCount: 4, salaryConflict: false } }) as never, {}, NOW)
    expect(flagged).toBeLessThan(direct)
    expect(Number.isFinite(flagged)).toBe(true) // a score, not an exclusion
  })

  it('domain + location matches boost; remote earns the half-bonus only when the city missed', () => {
    const base = tierAScore(doc() as never, {}, NOW)
    expect(tierAScore(doc() as never, { domain: 'backend' }, NOW)).toBeGreaterThan(base)
    expect(tierAScore(doc() as never, { locKey: 'bengaluru' }, NOW)).toBeGreaterThan(base)
    const remoteMiss = tierAScore(doc({ isRemote: true, locationKeys: ['remote-in'] }) as never, { locKey: 'pune', includeRemote: true }, NOW)
    const cityHit = tierAScore(doc({ locationKeys: ['pune'] }) as never, { locKey: 'pune' }, NOW)
    expect(cityHit).toBeGreaterThan(remoteMiss)
  })

  it('recency decays linearly to zero at 21 days — stale postings stop earning freshness', () => {
    const fresh = tierAScore(doc({ postedAt: NOW }) as never, {}, NOW)
    const old = tierAScore(doc({ postedAt: new Date('2026-06-01') }) as never, {}, NOW)
    const undated = tierAScore(doc({ postedAt: undefined }) as never, {}, NOW)
    expect(fresh).toBeGreaterThan(old)
    expect(old).toBe(undated)
  })

  it('bestApplyTierOf picks the best rung across provenance', () => {
    const d = doc({ provenance: [
      { applyTier: 'aggregator-redirect', applyUrl: 'https://agg.example/r', sourceId: 'a', externalId: '1', sourceKey: 'a:1' },
      { applyTier: 'employer', applyUrl: 'https://careers.example/j', sourceId: 'b', externalId: '2', sourceKey: 'b:2' },
    ] })
    expect(bestApplyTierOf(d as never)).toBe('employer')
  })
})

describe('getFeed (public cards — never JD, never apply URLs)', () => {
  function feedChain(docs: unknown[]) {
    mockFind.mockClear()
    mockFind.mockReturnValue({
      select: vi.fn().mockReturnValue({
        sort: vi.fn().mockReturnValue({ limit: vi.fn().mockReturnValue({ lean: () => Promise.resolve(docs) }) }),
      }),
    })
  }

  it('cards carry display fields + tier badge + the ONLY permitted relevance claim — no JD, no URLs', async () => {
    feedChain([doc()])
    const feed = await getFeed({}, NOW)
    expect(feed.cards).toHaveLength(1)
    const card = feed.cards[0] as Record<string, unknown>
    expect(card.relevance).toBe('title-location')
    expect(card.applyTier).toBe('direct-ats')
    expect(JSON.stringify(card)).not.toContain('applyUrl')
    expect(card.jd).toBeUndefined()
    expect(card.jdCompressed).toBeUndefined()
  })

  it('only open postings are queried; a city filter unions with remote (country-level serving, ruling #17)', async () => {
    feedChain([])
    await getFeed({ city: 'Pune' }, NOW)
    const filter = mockFind.mock.calls[0][0]
    expect(filter.status).toBe('open')
    expect(filter.$or).toEqual([{ locationKeys: 'pune' }, { isRemote: true }])
  })

  it('paginates deterministically over the scored pool', async () => {
    feedChain(Array.from({ length: 45 }, (_, i) => doc({ _id: `j${i}` })))
    const p1 = await getFeed({ pageSize: 20 }, NOW)
    const p3 = await getFeed({ page: 3, pageSize: 20 }, NOW)
    expect(p1.cards).toHaveLength(20)
    expect(p1.hasMore).toBe(true)
    expect(p3.cards).toHaveLength(5)
    expect(p3.hasMore).toBe(false)
  })
})

describe('getJobDetail (P-2: the anon/authed split is structural)', () => {
  it('anon = gated shell — JD and apply URLs are ABSENT from the object, not just hidden', async () => {
    mockFindById.mockReturnValue({ lean: () => Promise.resolve(doc({ jdCompressed: gzipSync(Buffer.from('secret JD body')) })) })
    const d = await getJobDetail('j1', false)
    expect(d).not.toBeNull()
    expect(d!.gated).toBe(true)
    const json = JSON.stringify(d)
    expect(json).not.toContain('secret JD body')
    expect(json).not.toContain('applyUrl')
    expect(json).not.toContain('greenhouse')
    expect((d as Record<string, unknown>).jd).toBeUndefined()
    expect((d as Record<string, unknown>).applyOptions).toBeUndefined()
  })

  it('authed = full body: gunzipped JD + tier-sorted apply ladder + demotion flags', async () => {
    mockFindById.mockReturnValue({ lean: () => Promise.resolve(doc({
      jdCompressed: gzipSync(Buffer.from('build distributed things')),
      provenance: [
        { sourceId: 'a', externalId: '1', sourceKey: 'a:1', applyUrl: 'https://agg.example/redir', applyTier: 'aggregator-redirect', viaSite: 'agg' },
        { sourceId: 'b', externalId: '2', sourceKey: 'b:2', applyUrl: 'https://boards.greenhouse.io/x/1', applyTier: 'direct-ats' },
      ],
    })) })
    const d = await getJobDetail('j1', true)
    expect(d!.gated).toBe(false)
    if (!d!.gated) {
      expect(d!.jd).toBe('build distributed things')
      expect(d!.applyOptions.map((o) => o.tier)).toEqual(['direct-ats', 'aggregator-redirect'])
      expect(d!.flags).toEqual({ staffing: false, shortJd: false, repost: false })
    }
  })

  it('non-http(s) apply URLs never reach a client — ladder AND badge exclude them (Codex #517)', async () => {
    const evil = doc({
      provenance: [
        { sourceId: 'a', externalId: '1', sourceKey: 'a:1', applyUrl: 'javascript:alert(document.cookie)', applyTier: 'direct-ats' },
        { sourceId: 'b', externalId: '2', sourceKey: 'b:2', applyUrl: 'data:text/html,<script>1</script>', applyTier: 'employer' },
        { sourceId: 'c', externalId: '3', sourceKey: 'c:3', applyUrl: 'https://safe.example.com/apply', applyTier: 'aggregator-deep' },
      ],
    })
    mockFindById.mockReturnValue({ lean: () => Promise.resolve(evil) })
    const d = await getJobDetail('j1', true)
    if (!d!.gated) {
      expect(d!.applyOptions).toHaveLength(1)
      expect(d!.applyOptions[0].url).toBe('https://safe.example.com/apply')
    }
    // the badge never advertises a path the ladder won't serve
    expect(bestApplyTierOf(evil as never)).toBe('aggregator-deep')
  })

  it('closed or missing postings 404 regardless of auth', async () => {
    mockFindById.mockReturnValue({ lean: () => Promise.resolve(doc({ status: 'closed' })) })
    expect(await getJobDetail('j1', true)).toBeNull()
    mockFindById.mockReturnValue({ lean: () => Promise.resolve(null) })
    expect(await getJobDetail('nope', true)).toBeNull()
  })
})
