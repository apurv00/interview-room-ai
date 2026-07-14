import { describe, it, expect, vi } from 'vitest'
import { gzipSync } from 'zlib'

const { mockFind, mockFindById, mockAppFindOne, mockGetBase, mockGetResume } = vi.hoisted(() => ({ mockFind: vi.fn(), mockFindById: vi.fn(), mockAppFindOne: vi.fn(), mockGetBase: vi.fn(), mockGetResume: vi.fn() }))
vi.mock('@shared/db/models', () => ({
  JobPosting: { find: mockFind, findById: mockFindById },
  JobApplication: { findOne: mockAppFindOne },
}))
vi.mock('../services/baseResumeService', () => ({ getBaseResume: mockGetBase }))
vi.mock('@resume', async (importOriginal) => {
  const real = await importOriginal<typeof import('@resume')>()
  return { ...real, getResume: mockGetResume }
})

import { tierAScore, tierBScore, matchedSkillsOf, bestApplyTierOf, getFeed, getJobDetail } from '../services/feedService'
import { xrayHashOf } from '../services/xrayService'

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

  it('bestApplyTierOf skips reported rungs when a clean one exists; falls back when all are reported', () => {
    const mixed = doc({ provenance: [
      { applyTier: 'direct-ats', applyUrl: 'https://d.example/1', brokenReportCount: 1, sourceId: 'a', externalId: '1', sourceKey: 'a:1' },
      { applyTier: 'aggregator-deep', applyUrl: 'https://b.example/2', sourceId: 'b', externalId: '2', sourceKey: 'b:2' },
    ] })
    expect(bestApplyTierOf(mixed as never)).toBe('aggregator-deep') // healing reaches the badge
    const allBroken = doc({ provenance: [
      { applyTier: 'direct-ats', applyUrl: 'https://d.example/1', brokenReportCount: 2, sourceId: 'a', externalId: '1', sourceKey: 'a:1' },
    ] })
    expect(bestApplyTierOf(allBroken as never)).toBe('direct-ats') // demote, never hide
  })

  it('bestApplyTierOf picks the best rung across provenance', () => {
    const d = doc({ provenance: [
      { applyTier: 'aggregator-redirect', applyUrl: 'https://agg.example/r', sourceId: 'a', externalId: '1', sourceKey: 'a:1' },
      { applyTier: 'employer', applyUrl: 'https://careers.example/j', sourceId: 'b', externalId: '2', sourceKey: 'b:2' },
    ] })
    expect(bestApplyTierOf(d as never)).toBe('employer')
  })
})

describe('tierBScore (stateless resume rank — Tier-A + evidence)', () => {
  const D = doc({ title: 'Senior Node.js Backend Engineer', titleTokens: ['senior', 'node.js', 'backend', 'engineer'] })

  it('with no skills/targetRole it IS tierAScore — the 3-questions path never gets resume math', () => {
    expect(tierBScore(D as never, {}, NOW)).toBe(tierAScore(D as never, {}, NOW))
  })

  it('matched skills boost (capped at 3) and matchedSkillsOf names ONLY real matches', () => {
    const skills = ['Node.js', 'Kafka', 'SQL']
    expect(matchedSkillsOf(D as never, skills)).toEqual(['Node.js'])
    expect(tierBScore(D as never, { skills }, NOW)).toBeGreaterThan(tierAScore(D as never, {}, NOW))
    const many = matchedSkillsOf(D as never, ['node.js', 'backend', 'engineer', 'senior'])
    expect(many.length).toBe(4) // all matched...
    const capped = tierBScore(D as never, { skills: ['node.js', 'backend', 'engineer', 'senior'] }, NOW)
    const three = tierBScore(D as never, { skills: ['node.js', 'backend', 'engineer'] }, NOW)
    expect(capped).toBe(three) // ...but the bonus caps at 3
  })

  it('target-role affinity boosts on high title overlap only', () => {
    const hit = tierBScore(D as never, { targetRole: 'Backend Engineer Node.js Senior' }, NOW)
    const miss = tierBScore(D as never, { targetRole: 'Product Designer' }, NOW)
    expect(hit).toBeGreaterThan(miss)
    expect(miss).toBe(tierAScore(D as never, {}, NOW))
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

  it('reveal honesty: sharpened counts ONLY cards with real matched skills; cards carry them', async () => {
    feedChain([
      doc({ _id: 'hit', title: 'SQL Analyst', titleTokens: ['sql', 'analyst'] }),
      doc({ _id: 'miss', title: 'Sales Executive', titleTokens: ['sales', 'executive'] }),
    ])
    const feed = await getFeed({ skills: ['SQL', 'Tableau'] }, NOW)
    expect(feed.sharpened).toBe(1)
    const hit = feed.cards.find((c) => c.id === 'hit')!
    const miss = feed.cards.find((c) => c.id === 'miss')!
    expect(hit.matchedSkills).toEqual(['SQL'])
    expect(hit.relevance).toBe('resume')
    expect(miss.matchedSkills).toEqual([])
    expect(miss.relevance).toBe('title-location') // never claims resume evidence it lacks
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
  mockAppFindOne.mockReturnValue({ select: () => ({ lean: () => Promise.resolve(null) }) })

  it('anon = gated shell — JD and apply URLs are ABSENT from the object, not just hidden', async () => {
    mockFindById.mockReturnValue({ lean: () => Promise.resolve(doc({ jdCompressed: gzipSync(Buffer.from('secret JD body')) })) })
    const d = await getJobDetail('j1', null)
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
    const d = await getJobDetail('j1', 'u1')
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
    const d = await getJobDetail('j1', 'u1')
    if (!d!.gated) {
      expect(d!.applyOptions).toHaveLength(1)
      expect(d!.applyOptions[0].url).toBe('https://safe.example.com/apply')
    }
    // the badge never advertises a path the ladder won't serve
    expect(bestApplyTierOf(evil as never)).toBe('aggregator-deep')
  })

  it('authed detail carries the caller\'s own application summary (chip + ticker inputs)', async () => {
    mockFindById.mockReturnValue({ lean: () => Promise.resolve(doc()) })
    mockAppFindOne.mockReturnValueOnce({ select: () => ({ lean: () => Promise.resolve({ status: 'apply_clicked', practiceSessionIds: ['a', 'b', 'c', 'd', 'e'] }) }) })
    const d = await getJobDetail('j1', 'u1')
    if (!d!.gated) expect(d!.application).toEqual({ status: 'apply_clicked', practiceCount: 3, ats: { state: 'none' } }) // practiceCount capped at 3
  })

  it('a stale-RESUME atsResult re-opens the check even when the JD matches (Codex #521 round-5)', async () => {
    const { gzipSync } = await import('zlib')
    const JD = 'Build services with Node.js at scale, and then some more content here.'
    const base = doc({ jdCompressed: gzipSync(Buffer.from(JD)) })
    mockGetBase.mockResolvedValue({ id: 'base-1', name: 'Base', targetRole: 'QA', skills: [] })
    mockGetResume.mockResolvedValue({ fullText: 'EDITED RESUME TEXT' })
    mockFindById.mockReturnValue({ lean: () => Promise.resolve(base) })
    mockAppFindOne.mockReturnValueOnce({ select: () => ({ lean: () => Promise.resolve({ status: 'saved', practiceSessionIds: [], atsResult: { score: 70, missingKeywords: [], jdHash: xrayHashOf(JD), resumeHash: xrayHashOf('OLD RESUME TEXT'), checkedAt: new Date() } }) }) })
    const d1 = await getJobDetail('j1', 'u1')
    if (!d1!.gated) expect(d1!.application!.ats.state).toBe('none')
    // matching resume → done
    mockGetResume.mockResolvedValue({ fullText: 'OLD RESUME TEXT' })
    mockFindById.mockReturnValue({ lean: () => Promise.resolve(base) })
    mockAppFindOne.mockReturnValueOnce({ select: () => ({ lean: () => Promise.resolve({ status: 'saved', practiceSessionIds: [], atsResult: { score: 70, missingKeywords: [], jdHash: xrayHashOf(JD), resumeHash: xrayHashOf('OLD RESUME TEXT'), checkedAt: new Date() } }) }) })
    const d2 = await getJobDetail('j1', 'u1')
    if (!d2!.gated) expect(d2!.application!.ats).toMatchObject({ state: 'done', score: 70 })
  })

  it('a stale-JD atsResult re-opens the check; the current JD stays done (Codex #521)', async () => {
    const { gzipSync } = await import('zlib')
    const JD = 'Build services with Node.js at scale, and then some more content here.'
    const base = doc({ jdCompressed: gzipSync(Buffer.from(JD)) })
    // stored result for a DIFFERENT (pre-merge) JD → state none, button back
    mockFindById.mockReturnValue({ lean: () => Promise.resolve(base) })
    mockAppFindOne.mockReturnValueOnce({ select: () => ({ lean: () => Promise.resolve({ status: 'saved', practiceSessionIds: [], atsResult: { score: 70, missingKeywords: [], jdHash: 'stale-hash', checkedAt: new Date() } }) }) })
    const d1 = await getJobDetail('j1', 'u1')
    if (!d1!.gated) expect(d1!.application!.ats.state).toBe('none')
    // matching hash → done with the score
    mockFindById.mockReturnValue({ lean: () => Promise.resolve(base) })
    mockAppFindOne.mockReturnValueOnce({ select: () => ({ lean: () => Promise.resolve({ status: 'saved', practiceSessionIds: [], atsResult: { score: 70, missingKeywords: [], jdHash: xrayHashOf(JD), checkedAt: new Date() } }) }) })
    const d2 = await getJobDetail('j1', 'u1')
    if (!d2!.gated) expect(d2!.application!.ats).toMatchObject({ state: 'done', score: 70 })
  })

  it('reported rungs sink below clean ones — demoted, never hidden (§4b)', async () => {
    const { gzipSync } = await import('zlib')
    mockFindById.mockReturnValue({ lean: () => Promise.resolve(doc({
      jdCompressed: gzipSync(Buffer.from('body')),
      provenance: [
        { sourceId: 'a', externalId: '1', sourceKey: 'a:1', applyUrl: 'https://direct.example/1', applyTier: 'direct-ats', brokenReportCount: 2 },
        { sourceId: 'b', externalId: '2', sourceKey: 'b:2', applyUrl: 'https://board.example/2', applyTier: 'aggregator-deep' },
      ],
    })) })
    const d = await getJobDetail('j1', 'u1')
    if (!d!.gated) {
      expect(d!.applyOptions.map((o) => o.url)).toEqual(['https://board.example/2', 'https://direct.example/1'])
      expect(d!.applyOptions).toHaveLength(2) // demoted, still present
    }
  })

  it('closed or missing postings 404 regardless of auth', async () => {
    mockFindById.mockReturnValue({ lean: () => Promise.resolve(doc({ status: 'closed' })) })
    expect(await getJobDetail('j1', 'u1')).toBeNull()
    mockFindById.mockReturnValue({ lean: () => Promise.resolve(null) })
    expect(await getJobDetail('nope', 'u1')).toBeNull()
  })
})
