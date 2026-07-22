import { beforeEach, describe, it, expect, vi } from 'vitest'
import { gzipSync } from 'zlib'

const {
  mockFind,
  mockFindById,
  mockPostingExists,
  mockAppFindOne,
  mockAppExists,
  mockGetBase,
  mockGetResume,
  mockGetActiveCatalog,
} = vi.hoisted(() => ({
  mockFind: vi.fn(),
  mockFindById: vi.fn(),
  mockPostingExists: vi.fn().mockResolvedValue({ _id: 'posting-authoritative' }),
  mockAppFindOne: vi.fn(),
  mockAppExists: vi.fn().mockResolvedValue({ _id: 'application-authoritative' }),
  mockGetBase: vi.fn(),
  mockGetResume: vi.fn(),
  mockGetActiveCatalog: vi.fn(),
}))
vi.mock('@shared/db/models', () => ({
  JobPosting: { find: mockFind, findById: mockFindById, exists: mockPostingExists },
  JobApplication: { findOne: mockAppFindOne, exists: mockAppExists },
}))
vi.mock('../services/baseResumeService', () => ({ getBaseResume: mockGetBase }))
vi.mock('@resume', async (importOriginal) => {
  const real = await importOriginal<typeof import('@resume')>()
  return { ...real, getResume: mockGetResume }
})
vi.mock('@interview/services/persona/domainCatalogService', () => ({
  getActiveInterviewDomainCatalog: mockGetActiveCatalog,
}))

import { tierAScore, tierBScore, matchedSkillsOf, bestApplyTierOf, getFeed, getJobDetail } from '../services/feedService'
import { practiceHandoffHashOf } from '../services/practiceHandoff'
import { xrayHashOf } from '../services/xrayService'
import { INTERVIEW_JOB_DESCRIPTION_MAX_CHARS } from '@shared/interviewContract'
import { applyOptionIdOf, canonicalApplyOptionsOf } from '../services/applyOptionIdentity'

const NOW = new Date('2026-07-14T12:00:00Z')
const ACTIVE_CATALOG = {
  slugs: ['backend', 'frontend', 'general', 'mobile'],
  slugSet: new Set(['backend', 'frontend', 'general', 'mobile']),
  inferenceSlugSet: new Set(['backend', 'frontend', 'general', 'mobile']),
  revision: 'jd-role-v2:test',
  authoritative: true,
  source: 'cms' as const,
}

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

function crowdDemoted<T extends { sourceKey: string; applyUrl: string; applyTier: string }>(source: T): T & { linkGovernance: Record<string, unknown> } {
  const option = canonicalApplyOptionsOf([source])[0]
  return {
    ...source,
    linkGovernance: {
      subject: option.subject,
      generation: option.generation,
      incidentVersion: 1,
      reportWindowStartedAt: NOW,
      reportCount: 3,
      lastReportedAt: NOW,
      crowdDemotedAt: NOW,
    },
  }
}

function machineDemoted<T extends { sourceKey: string; applyUrl: string; applyTier: string }>(source: T): T & { linkGovernance: Record<string, unknown> } {
  const option = canonicalApplyOptionsOf([source])[0]
  return {
    ...source,
    linkGovernance: {
      subject: option.subject,
      generation: option.generation,
      incidentVersion: 1,
      reportCount: 0,
      machineOutcome: 'dead',
      machineCheckedAt: NOW,
      machineDemotedAt: NOW,
    },
  }
}

function requireFullDetail(detail: Awaited<ReturnType<typeof getJobDetail>>) {
  expect(detail).toMatchObject({ gated: false })
  if (!detail || detail.gated) throw new Error('expected authenticated full detail')
  return detail
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

  it('domain match boosts; location/city is NOT a rank input (founder directive 2026-07-16, ruling #21)', () => {
    const base = tierAScore(doc() as never, {}, NOW)
    expect(tierAScore(doc() as never, { domain: 'backend' }, NOW)).toBeGreaterThan(base)
    // Same doc, wildly different locations → identical score. City must
    // never re-enter rank math (the typed-city filter collapsed the feed).
    expect(tierAScore(doc({ locations: ['Pune'], locationKeys: ['pune'] }) as never, {}, NOW)).toBe(base)
    expect(tierAScore(doc({ isRemote: true, locationKeys: ['remote-in'] }) as never, {}, NOW)).toBe(base)
  })

  it('recency decays linearly to zero at 21 days — stale postings stop earning freshness', () => {
    const fresh = tierAScore(doc({ postedAt: NOW }) as never, {}, NOW)
    const old = tierAScore(doc({ postedAt: new Date('2026-06-01') }) as never, {}, NOW)
    const undated = tierAScore(doc({ postedAt: undefined }) as never, {}, NOW)
    expect(fresh).toBeGreaterThan(old)
    expect(old).toBe(undated)
  })

  it('bestApplyTierOf skips quorum-demoted rungs, falls back when all are demoted, and ignores legacy counts', () => {
    const direct = { applyTier: 'direct-ats' as const, applyUrl: 'https://d.example/1', sourceId: 'a', externalId: '1', sourceKey: 'a:1' }
    const mixed = doc({ provenance: [
      crowdDemoted(direct),
      { applyTier: 'aggregator-deep', applyUrl: 'https://b.example/2', sourceId: 'b', externalId: '2', sourceKey: 'b:2' },
    ] })
    expect(bestApplyTierOf(mixed as never)).toBe('aggregator-deep') // healing reaches the badge
    const allBroken = doc({ provenance: [crowdDemoted(direct)] })
    expect(bestApplyTierOf(allBroken as never)).toBe('direct-ats') // demote, never hide
    expect(bestApplyTierOf(doc({ provenance: [{ ...direct, brokenReportCount: 500 }] }) as never))
      .toBe('direct-ats')
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

  it('only open postings are queried; NO location filter exists in any pull (ruling #21 regression pin)', async () => {
    feedChain([])
    await getFeed({}, NOW)
    const filter = mockFind.mock.calls[0][0]
    expect(filter.status).toBe('open')
    expect(JSON.stringify(filter)).not.toContain('locationKeys')
    expect(JSON.stringify(filter)).not.toContain('$or')
  })

  it('explicit ?domain= (press links) stays a HARD filter — one pull, domain in the query', async () => {
    feedChain([doc()])
    await getFeed({ domain: 'backend' }, NOW)
    expect(mockFind).toHaveBeenCalledTimes(1)
    expect(mockFind.mock.calls[0][0]).toEqual({ status: 'open', domain: 'backend' })
  })

  it('derived roleDomain pulls DOMAIN-FIRST plus a mixed tail — the pm rows all reach scoring (founder RCA 2026-07-16)', async () => {
    feedChain([])
    await getFeed({ roleDomain: 'pm', targetRole: 'Product Management' }, NOW)
    expect(mockFind).toHaveBeenCalledTimes(2)
    expect(mockFind.mock.calls[0][0]).toEqual({ status: 'open', domain: 'pm' })
    expect(mockFind.mock.calls[1][0]).toEqual({ status: 'open', domain: { $ne: 'pm' } })
  })

  it('domain CLASS outranks recency: a week-old pm row beats a fresh direct-ats fullstack row for a pm target', async () => {
    // The two pulls are disjoint in prod ($ne) — mock each separately.
    const chain = (docs: unknown[]) => ({
      select: vi.fn().mockReturnValue({
        sort: vi.fn().mockReturnValue({ limit: vi.fn().mockReturnValue({ lean: () => Promise.resolve(docs) }) }),
      }),
    })
    mockFind.mockClear()
    mockFind
      .mockReturnValueOnce(chain([doc({ _id: 'old-pm', domain: 'pm', postedAt: new Date('2026-07-07T12:00:00Z') })]))
      .mockReturnValueOnce(chain([doc({ _id: 'fresh-fullstack', domain: 'fullstack', postedAt: NOW })]))
    const feed = await getFeed({ roleDomain: 'pm' }, NOW)
    expect(feed.cards.map((c) => c.id)).toEqual(['old-pm', 'fresh-fullstack'])
    expect(feed.total).toBe(2)
    expect(feed.pageSize).toBe(20)
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
  beforeEach(() => {
    vi.stubEnv('NEXTAUTH_SECRET', 'test-secret-longer-than-sixteen-characters')
    mockGetActiveCatalog.mockReset()
    mockGetActiveCatalog.mockResolvedValue(ACTIVE_CATALOG)
    mockAppFindOne.mockReturnValue({ select: () => ({ lean: () => Promise.resolve(null) }) })
  })

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

  it('anon serves no stale shell when source authority changes after the initial read', async () => {
    mockFindById.mockReturnValue({ lean: () => Promise.resolve(doc()) })
    mockPostingExists.mockResolvedValueOnce(null)

    expect(await getJobDetail('j1', null)).toBeNull()
    expect(mockPostingExists.mock.calls.at(-1)?.[0]).toEqual({
      _id: 'j1',
      status: 'open',
      closedReason: { $exists: false },
    })
  })

  it('keeps serving after a benign refresh changes updatedAt without changing lifecycle authority', async () => {
    mockFindById.mockReturnValue({
      lean: () => Promise.resolve(doc({ updatedAt: new Date('2026-07-14T12:00:00Z') })),
    })
    mockPostingExists.mockImplementationOnce((filter: Record<string, unknown>) => (
      Promise.resolve('updatedAt' in filter ? null : { _id: 'posting-authoritative' })
    ))

    const detail = await getJobDetail('j1', null)

    expect(detail).toMatchObject({ id: 'j1', gated: true })
    expect(mockPostingExists.mock.calls.at(-1)?.[0]).toEqual({
      _id: 'j1',
      status: 'open',
      closedReason: { $exists: false },
    })
  })

  it('authed detail PREFERS the display twin; legacy rows fall back to the collapsed body (PR-C)', async () => {
    mockFindById.mockReturnValue({ lean: () => Promise.resolve(doc({
      jdCompressed: gzipSync(Buffer.from('para one para two')),
      jdDisplayCompressed: gzipSync(Buffer.from('para one\npara two')),
    })) })
    const withTwin = await getJobDetail('j1', 'u1')
    if (!withTwin!.gated) expect(withTwin!.jd).toBe('para one\npara two')
    mockFindById.mockReturnValue({ lean: () => Promise.resolve(doc({
      jdCompressed: gzipSync(Buffer.from('para one para two')),
    })) })
    const legacy = await getJobDetail('j1', 'u1')
    if (!legacy!.gated) expect(legacy!.jd).toBe('para one para two')
  })

  it('publishes role + canonical token together for a domain-less job with a current mapped parse', async () => {
    const canonical = 'Build accessible React interfaces at production scale.'
    const display = 'Build accessible React interfaces\n\nat production scale.'
    mockFindById.mockReturnValue({ lean: () => Promise.resolve(doc({
      domain: undefined,
      jdCompressed: gzipSync(Buffer.from(canonical)),
      jdDisplayCompressed: gzipSync(Buffer.from(display)),
      parsedJD: { inferredDomain: 'frontend' },
      parsedJDHash: xrayHashOf(canonical),
      parsedJDRoleVersion: ACTIVE_CATALOG.revision,
    })) })

    const detail = requireFullDetail(await getJobDetail('j1', 'u1'))

    expect(detail.jd).toBe(display)
    expect(detail.practiceRole).toBe('frontend')
    expect(detail.practiceHandoffToken).toEqual(expect.any(String))
    expect(detail.tailorInputHash).toBe(practiceHandoffHashOf(canonical))
    const payload = JSON.parse(
      Buffer.from(detail.practiceHandoffToken!.split('.')[0], 'base64url').toString('utf8')
    ) as { jdh: string }
    expect(payload.jdh).toBe(practiceHandoffHashOf(canonical))
  })

  it('falls back to canonical text and hashes canonical when the display twin is stale', async () => {
    const canonical = 'Canonical backend role with Node.js and MongoDB.'
    mockFindById.mockReturnValue({ lean: () => Promise.resolve(doc({
      jdCompressed: gzipSync(Buffer.from(canonical)),
      jdDisplayCompressed: gzipSync(Buffer.from('A stale display from another posting.')),
    })) })

    const detail = requireFullDetail(await getJobDetail('j1', 'u1'))

    expect(detail.jd).toBe(canonical)
    expect(detail.practiceRole).toBe('backend')
    const payload = JSON.parse(
      Buffer.from(detail.practiceHandoffToken!.split('.')[0], 'base64url').toString('utf8')
    ) as { jdh: string }
    expect(payload.jdh).toBe(practiceHandoffHashOf(canonical))
  })

  it('does not publish Practice readiness for an unknown or stale inferred role', async () => {
    const canonical = 'A role whose source omitted the product domain.'
    mockFindById
      .mockReturnValueOnce({ lean: () => Promise.resolve(doc({
        domain: undefined,
        jdCompressed: gzipSync(Buffer.from(canonical)),
        parsedJD: { inferredDomain: 'Product Manager' },
        parsedJDHash: xrayHashOf(canonical),
        parsedJDRoleVersion: ACTIVE_CATALOG.revision,
      })) })
      .mockReturnValueOnce({ lean: () => Promise.resolve(doc({
        domain: undefined,
        jdCompressed: gzipSync(Buffer.from(canonical)),
        parsedJD: { inferredDomain: 'frontend' },
        parsedJDHash: 'stale-hash',
        parsedJDRoleVersion: ACTIVE_CATALOG.revision,
      })) })

    for (const result of [await getJobDetail('j1', 'u1'), await getJobDetail('j1', 'u1')]) {
      const detail = requireFullDetail(result)
      expect(detail.practiceRole).toBeUndefined()
      expect(detail.practiceHandoffToken).toBeUndefined()
    }
  })

  it('admits CMS-active custom roles and withholds CMS-inactive built-ins', async () => {
    const canonical = 'A specialized role from the live interview catalog.'
    const customCatalog = {
      slugs: ['custom-quant-role', 'general'],
      slugSet: new Set(['custom-quant-role', 'general']),
      inferenceSlugSet: new Set(['custom-quant-role', 'general']),
      revision: 'jd-role-v2:custom',
      authoritative: true,
      source: 'cms' as const,
    }
    const withoutBackend = {
      slugs: ['general'],
      slugSet: new Set(['general']),
      inferenceSlugSet: new Set(['general']),
      revision: 'jd-role-v2:no-backend',
      authoritative: true,
      source: 'cms' as const,
    }
    mockGetActiveCatalog
      .mockResolvedValueOnce(customCatalog)
      .mockResolvedValueOnce(withoutBackend)
    mockFindById
      .mockReturnValueOnce({ lean: () => Promise.resolve(doc({
        domain: undefined,
        jdCompressed: gzipSync(Buffer.from(canonical)),
        parsedJD: { inferredDomain: 'custom-quant-role' },
        parsedJDHash: xrayHashOf(canonical),
        parsedJDRoleVersion: customCatalog.revision,
      })) })
      .mockReturnValueOnce({ lean: () => Promise.resolve(doc({
        domain: 'backend',
        jdCompressed: gzipSync(Buffer.from(canonical)),
      })) })

    const custom = requireFullDetail(await getJobDetail('j1', 'u1'))
    const inactive = requireFullDetail(await getJobDetail('j1', 'u1'))

    expect(custom.practiceRole).toBe('custom-quant-role')
    expect(custom.practiceHandoffToken).toEqual(expect.any(String))
    expect(inactive.practiceRole).toBeUndefined()
    expect(inactive.practiceHandoffToken).toBeUndefined()
  })

  it('can display a readable twin but refuses Practice when canonical gzip is corrupt', async () => {
    mockFindById.mockReturnValue({ lean: () => Promise.resolve(doc({
      jdCompressed: Buffer.from('not-gzip'),
      jdDisplayCompressed: gzipSync(Buffer.from('Readable display-only job description.')),
    })) })

    const detail = requireFullDetail(await getJobDetail('j1', 'u1'))

    expect(detail.jd).toBe('Readable display-only job description.')
    expect(detail.practiceRole).toBeUndefined()
    expect(detail.practiceHandoffToken).toBeUndefined()
  })

  it('shows an oversized JD but does not advertise an API-invalid Practice flow', async () => {
    const oversized = 'j'.repeat(INTERVIEW_JOB_DESCRIPTION_MAX_CHARS + 1)
    mockFindById.mockReturnValue({ lean: () => Promise.resolve(doc({
      jdCompressed: gzipSync(Buffer.from(oversized)),
    })) })

    const detail = requireFullDetail(await getJobDetail('j1', 'u1'))

    expect(detail.jd).toBe(oversized)
    expect(detail.practiceRole).toBeUndefined()
    expect(detail.practiceHandoffToken).toBeUndefined()
    expect(detail.capabilities.practice).toBe(false)
    expect(detail.capabilities.tailor).toBe(true)
    expect(detail.tailorInputHash).toBe(practiceHandoffHashOf(oversized))
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
      expect(d!.postingState).toBe('live')
      expect(d!.capabilities.apply).toBe(true)
      expect(d!.jd).toBe('build distributed things')
      expect(d!.applyOptions.map((o) => o.tier)).toEqual(['direct-ats', 'aggregator-redirect'])
      expect(d!.applyOptions.map((o) => o.optionId)).toEqual([
        applyOptionIdOf({
          sourceKey: 'b:2',
          url: 'https://boards.greenhouse.io/x/1',
          tier: 'direct-ats',
        }),
        applyOptionIdOf({
          sourceKey: 'a:1',
          url: 'https://agg.example/redir',
          tier: 'aggregator-redirect',
        }),
      ])
      expect(d!.applyOptions[0].optionId).not.toContain('greenhouse')
      expect(d!.flags).toEqual({ staffing: false, shortJd: false, repost: false })
    }
  })

  it('returns no stale JD/apply projection when source revocation commits during preparation', async () => {
    mockFindById.mockReturnValue({ lean: () => Promise.resolve(doc({
      jdCompressed: gzipSync(Buffer.from('source-controlled secret JD')),
    })) })
    mockPostingExists.mockResolvedValueOnce(null)

    expect(await getJobDetail('j1', 'u1')).toBeNull()
    expect(mockPostingExists.mock.calls.at(-1)?.[0]).toEqual({
      _id: 'j1',
      status: 'open',
      closedReason: { $exists: false },
    })
  })

  it('unsafe navigation URLs never reach a client — ladder AND badge exclude them', async () => {
    const evil = doc({
      provenance: [
        { sourceId: 'a', externalId: '1', sourceKey: 'a:1', applyUrl: 'javascript:alert(document.cookie)', applyTier: 'direct-ats' },
        { sourceId: 'b', externalId: '2', sourceKey: 'b:2', applyUrl: 'data:text/html,<script>1</script>', applyTier: 'employer' },
        { sourceId: 'd', externalId: '4', sourceKey: 'd:4', applyUrl: 'http://127.0.0.1:3000/admin', applyTier: 'direct-ats' },
        { sourceId: 'e', externalId: '5', sourceKey: 'e:5', applyUrl: 'http://169.254.169.254/latest', applyTier: 'employer' },
        { sourceId: 'f', externalId: '6', sourceKey: 'f:6', applyUrl: 'https://user:secret@safe.example.com/apply', applyTier: 'direct-ats' },
        { sourceId: 'g', externalId: '7', sourceKey: 'g:7', applyUrl: 'https://safe.example.com:8443/apply', applyTier: 'employer' },
        { sourceId: 'h', externalId: '8', sourceKey: 'h:8', applyUrl: 'https://wa.me/919876543210', applyTier: 'direct-ats' },
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
    mockAppFindOne.mockReturnValueOnce({ select: () => ({ lean: () => Promise.resolve({
      _id: 'app-1',
      status: 'apply_clicked',
      verifiedPracticeSessionIds: ['a', 'b', 'c', 'd', 'e'],
      interviewDateConfidence: 'week',
      interviewDatePreference: 'this-week',
    }) }) })
    const d = await getJobDetail('j1', 'u1')
    if (!d!.gated) expect(d!.application).toMatchObject({
      applicationId: 'app-1',
      status: 'apply_clicked',
      practiceCount: 3,
      interviewDate: undefined,
      interviewDateConfidence: 'week',
      interviewDatePreference: 'this-week',
      ats: { state: 'none' },
    }) // practiceCount capped at 3
  })

  it('does not return a stale live application summary deleted during preparation', async () => {
    mockFindById.mockReturnValue({ lean: () => Promise.resolve(doc()) })
    mockAppFindOne.mockReturnValueOnce({ select: () => ({ lean: () => Promise.resolve({
      _id: 'app-deleted', status: 'saved', verifiedPracticeSessionIds: [],
    }) }) })
    mockAppExists.mockResolvedValueOnce(null)

    const detail = requireFullDetail(await getJobDetail('j1', 'u1'))

    expect(detail.postingState).toBe('live')
    expect(detail.application).toBeNull()
    expect(detail.capabilities.atsCheck).toBe(false)
  })

  it('quarantines legacy attendance from the candidate-facing practice count', async () => {
    mockFindById.mockReturnValue({ lean: () => Promise.resolve(doc()) })
    mockAppFindOne.mockReturnValueOnce({
      select: () => ({
        lean: () => Promise.resolve({
          _id: 'legacy-app',
          status: 'saved',
          practiceSessionIds: ['legacy-a', 'legacy-b', 'legacy-c'],
        }),
      }),
    })

    const detail = await getJobDetail('j1', 'u1')

    if (!detail!.gated) expect(detail!.application?.practiceCount).toBe(0)
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

  it('a LEGACY raw resumeHash (pre-whitespace-collapse) still counts as current — no re-run on unchanged content (Codex #541)', async () => {
    const { gzipSync } = await import('zlib')
    const { legacyXrayHashOf } = await import('../services/xrayService')
    const JD = 'Build services with Node.js at scale, and then some more content here.'
    const RESUME = 'APURV BHISHEK\nProduct Manager\n\n• Shipped payments\n• Led roadmap'
    const base = doc({ jdCompressed: gzipSync(Buffer.from(JD)) })
    mockGetBase.mockResolvedValue({ id: 'base-1', name: 'Base', targetRole: 'PM', skills: [] })
    mockGetResume.mockResolvedValue({ fullText: RESUME })
    mockFindById.mockReturnValue({ lean: () => Promise.resolve(base) })
    // Stored BEFORE the collapse: raw-bytes hash of newline-bearing text.
    mockAppFindOne.mockReturnValueOnce({ select: () => ({ lean: () => Promise.resolve({ status: 'saved', practiceSessionIds: [], atsResult: { score: 81, missingKeywords: [], jdHash: xrayHashOf(JD), resumeHash: legacyXrayHashOf(RESUME), checkedAt: new Date() } }) }) })
    const d = await getJobDetail('j1', 'u1')
    if (!d!.gated) expect(d!.application!.ats).toMatchObject({ state: 'done', score: 81 })
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
        crowdDemoted({ sourceId: 'a', externalId: '1', sourceKey: 'a:1', applyUrl: 'https://direct.example/1', applyTier: 'direct-ats' }),
        { sourceId: 'b', externalId: '2', sourceKey: 'b:2', applyUrl: 'https://board.example/2', applyTier: 'aggregator-deep' },
      ],
    })) })
    const d = await getJobDetail('j1', 'u1')
    if (!d!.gated) {
      expect(d!.applyOptions.map((o) => o.url)).toEqual(['https://board.example/2', 'https://direct.example/1'])
      expect(d!.applyOptions).toHaveLength(2) // demoted, still present
      expect(d!.allApplyOptionsDemoted).toBe(false)
    }
  })

  it('projects only a coarse signal when every usable apply option is demoted', async () => {
    mockFindById.mockReturnValue({ lean: () => Promise.resolve(doc({
      jdCompressed: gzipSync(Buffer.from('body')),
      provenance: [
        crowdDemoted({ sourceId: 'a', externalId: '1', sourceKey: 'a:1', applyUrl: 'https://direct.example/1', applyTier: 'direct-ats' }),
        machineDemoted({ sourceId: 'b', externalId: '2', sourceKey: 'b:2', applyUrl: 'https://board.example/2', applyTier: 'aggregator-deep' }),
      ],
    })) })

    const detail = requireFullDetail(await getJobDetail('j1', 'u1'))

    expect(detail.allApplyOptionsDemoted).toBe(true)
    expect(detail.applyOptions).toHaveLength(2)
    for (const option of detail.applyOptions) {
      expect(option).toEqual(expect.objectContaining({ optionId: expect.any(String), url: expect.any(String), tier: expect.any(String) }))
      expect(option).not.toHaveProperty('broken')
      expect(option).not.toHaveProperty('governance')
      expect(option).not.toHaveProperty('reportCount')
      expect(option).not.toHaveProperty('machineCheckedAt')
    }
  })

  it('closed anonymous and non-owner requests remain indistinguishable from missing', async () => {
    mockAppFindOne.mockClear()
    mockFindById.mockReturnValue({ lean: () => Promise.resolve(doc({ status: 'closed', closedReason: 'aged-out' })) })
    expect(await getJobDetail('j1', null)).toBeNull()
    expect(mockAppFindOne).not.toHaveBeenCalled()

    mockFindById.mockReturnValue({ lean: () => Promise.resolve(doc({ status: 'closed', closedReason: 'aged-out' })) })
    mockAppFindOne.mockReturnValueOnce({ select: () => ({ lean: () => Promise.resolve(null) }) })
    expect(await getJobDetail('j1', 'other-user')).toBeNull()

    mockFindById.mockReturnValue({ lean: () => Promise.resolve(null) })
    mockAppFindOne.mockReturnValueOnce({ select: () => ({ lean: () => Promise.resolve(null) }) })
    expect(await getJobDetail('nope', 'u1')).toBeNull()
  })

  it('normal closed owner receives an archived JD projection with preparation but no apply authority', async () => {
    const canonical = 'Build accessible React interfaces and production design systems.'
    mockFindById.mockReturnValue({ lean: () => Promise.resolve(doc({
      status: 'closed',
      closedReason: 'aged-out',
      domain: undefined,
      jdCompressed: gzipSync(Buffer.from(canonical)),
      parsedJD: { inferredDomain: 'frontend', keyThemes: ['accessibility'], requirements: [] },
      parsedJDHash: xrayHashOf(canonical),
      // Archives cannot mutate their saved X-ray to chase every CMS
      // revision; the exact-JD role remains valid while the current closed
      // catalog still contains it.
      parsedJDRoleVersion: 'jd-role-v2:previous-catalog',
    })) })
    mockAppFindOne.mockReturnValueOnce({ select: () => ({ lean: () => Promise.resolve({
      _id: 'app-archived', status: 'applied', verifiedPracticeSessionIds: ['s1'],
    }) }) })

    const detail = requireFullDetail(await getJobDetail('j1', 'u1'))

    expect(detail).toMatchObject({
      postingState: 'archived',
      jd: canonical,
      applyOptions: [],
      application: { applicationId: 'app-archived', status: 'applied', practiceCount: 1 },
      capabilities: { apply: false, viewSource: false, xray: true, tailor: true, practice: true, atsCheck: true },
    })
    expect(detail.practiceHandoffToken).toEqual(expect.any(String))
    expect(detail.practiceRole).toBe('frontend')
    expect(detail).not.toHaveProperty('applyTier')
    expect(JSON.stringify(detail)).not.toContain('boards.greenhouse.io')
  })

  it('does not serve archived JD context when ownership disappears during preparation', async () => {
    mockFindById.mockReturnValue({ lean: () => Promise.resolve(doc({
      status: 'closed',
      closedReason: 'aged-out',
      jdCompressed: gzipSync(Buffer.from('owner-only archived JD')),
    })) })
    mockAppFindOne.mockReturnValueOnce({ select: () => ({ lean: () => Promise.resolve({
      _id: 'app-archived', status: 'saved', verifiedPracticeSessionIds: [],
    }) }) })
    mockAppExists.mockResolvedValueOnce(null)

    expect(await getJobDetail('j1', 'u1')).toBeNull()
    expect(mockAppExists).toHaveBeenCalledWith({
      _id: 'app-archived',
      userId: 'u1',
      jobPostingId: 'j1',
    })
  })

  it.each(['source-revoked', 'llm-verdict', undefined])('restricted closure %s retains history but withholds JD-derived content', async (closedReason) => {
    mockFindById.mockReturnValue({ lean: () => Promise.resolve(doc({
      status: 'closed', closedReason, title: 'Mutable unsafe title', company: 'Mutable unsafe company',
      salaryText: 'untrusted salary', domain: 'backend', jdCompressed: gzipSync(Buffer.from('sensitive removed body')),
    })) })
    mockAppFindOne.mockReturnValueOnce({ select: () => ({ lean: () => Promise.resolve({
      _id: 'app-restricted', status: 'applied', verifiedPracticeSessionIds: ['s1', 's2'],
      jobSnapshot: { title: 'Saved safe title', company: 'Saved safe company', location: 'Remote' },
      atsResult: {
        score: 91,
        missingKeywords: ['sensitive-JD-keyword'],
        checkedAt: new Date('2026-07-19T00:00:00Z'),
      },
    }) }) })

    const detail = requireFullDetail(await getJobDetail('j1', 'u1'))

    expect(detail.postingState).toBe('restricted')
    expect(detail).toMatchObject({ title: 'Saved safe title', company: 'Saved safe company', locations: ['Remote'], isRemote: true })
    expect(detail.application).toMatchObject({ applicationId: 'app-restricted', practiceCount: 2 })
    expect(detail.application?.ats).toMatchObject({ state: 'done' })
    expect(detail.application?.ats).not.toHaveProperty('score')
    expect(detail.application?.ats).not.toHaveProperty('missingKeywords')
    expect(detail.capabilities).toEqual({ apply: false, viewSource: false, xray: false, tailor: false, practice: false, atsCheck: false })
    expect(detail).not.toHaveProperty('jd')
    expect(detail).not.toHaveProperty('applyTier')
    expect(detail).not.toHaveProperty('practiceHandoffToken')
    expect(detail).not.toHaveProperty('tailorInputHash')
    expect(detail).not.toHaveProperty('salaryText')
    expect(detail).not.toHaveProperty('domain')
    expect(JSON.stringify(detail)).not.toContain('sensitive removed body')
    expect(JSON.stringify(detail)).not.toContain('sensitive-JD-keyword')
  })

  it('does not return stale restricted tracker history after its ownership row is deleted', async () => {
    mockFindById.mockReturnValue({ lean: () => Promise.resolve(doc({
      status: 'closed',
      closedReason: 'source-revoked',
      jdCompressed: gzipSync(Buffer.from('restricted source body')),
    })) })
    mockAppFindOne.mockReturnValueOnce({ select: () => ({ lean: () => Promise.resolve({
      _id: 'app-restricted',
      status: 'saved',
      jobSnapshot: { title: 'Saved role', company: 'Saved company' },
      verifiedPracticeSessionIds: [],
    }) }) })
    mockAppExists.mockResolvedValueOnce(null)

    expect(await getJobDetail('j1', 'u1')).toBeNull()
  })

  it('missing retained posting falls back to the owner-only tracker snapshot', async () => {
    mockFindById.mockReturnValue({ lean: () => Promise.resolve(null) })
    mockAppFindOne.mockReturnValueOnce({ select: () => ({ lean: () => Promise.resolve({
      _id: 'app-snapshot',
      status: 'offer',
      jobSnapshot: { title: 'Saved role', company: 'Saved Co', location: 'Pune', applyUrlAtClick: 'https://secret.example/apply' },
      verifiedPracticeSessionIds: ['s1'],
      atsResult: {
        score: 87,
        missingKeywords: ['deleted-JD-keyword'],
        checkedAt: new Date('2026-07-18T00:00:00Z'),
      },
    }) }) })

    const detail = requireFullDetail(await getJobDetail('missing-job', 'u1'))

    expect(detail).toMatchObject({
      postingState: 'snapshot-only',
      title: 'Saved role',
      company: 'Saved Co',
      locations: ['Pune'],
      isRemote: false,
      application: { applicationId: 'app-snapshot', status: 'offer', practiceCount: 1 },
    })
    expect(detail.capabilities).toEqual({ apply: false, viewSource: false, xray: false, tailor: false, practice: false, atsCheck: false })
    expect(JSON.stringify(detail)).not.toContain('secret.example')
    expect(detail.application?.ats).toMatchObject({ state: 'done' })
    expect(detail.application?.ats).not.toHaveProperty('score')
    expect(detail.application?.ats).not.toHaveProperty('missingKeywords')
    expect(JSON.stringify(detail)).not.toContain('deleted-JD-keyword')
  })
})
