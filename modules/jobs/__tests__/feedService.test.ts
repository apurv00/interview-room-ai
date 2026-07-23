import { beforeEach, describe, it, expect, vi } from 'vitest'
import { gzipSync } from 'zlib'

const {
  mockFindById,
  mockPostingExists,
  mockAppFindOne,
  mockAppExists,
  mockUserFindById,
  mockGetBase,
  mockGetResume,
  mockGetActiveCatalog,
  mockDiscoverFeed,
} = vi.hoisted(() => ({
  mockFindById: vi.fn(),
  mockPostingExists: vi.fn().mockResolvedValue({ _id: 'posting-authoritative' }),
  mockAppFindOne: vi.fn(),
  mockAppExists: vi.fn().mockResolvedValue({ _id: 'application-authoritative' }),
  mockUserFindById: vi.fn(),
  mockGetBase: vi.fn(),
  mockGetResume: vi.fn(),
  mockGetActiveCatalog: vi.fn(),
  mockDiscoverFeed: vi.fn(),
}))
vi.mock('@shared/db/models', () => ({
  JobPosting: { findById: mockFindById, exists: mockPostingExists },
  JobApplication: { findOne: mockAppFindOne, exists: mockAppExists },
  User: { findById: mockUserFindById },
}))
vi.mock('../services/baseResumeService', () => ({ getBaseResume: mockGetBase }))
vi.mock('@resume', async (importOriginal) => {
  const real = await importOriginal<typeof import('@resume')>()
  return { ...real, getResume: mockGetResume }
})
vi.mock('@interview/services/persona/domainCatalogService', () => ({
  getActiveInterviewDomainCatalog: mockGetActiveCatalog,
}))
vi.mock('../services/feedDiscovery', () => ({
  discoverFeed: mockDiscoverFeed,
}))

import {
  JOB_DETAIL_GONE,
  matchedSkillsOf,
  bestApplyTierOf,
  getFeed,
  getJobDetail,
} from '../services/feedService'
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

describe('feed card evidence helpers', () => {
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
  it('matchedSkillsOf names only real title evidence', () => {
    const D = doc({ title: 'Senior Node.js Backend Engineer', titleTokens: ['senior', 'node.js', 'backend', 'engineer'] })
    const skills = ['Node.js', 'Kafka', 'SQL']
    expect(matchedSkillsOf(D as never, skills)).toEqual(['Node.js'])
    const many = matchedSkillsOf(D as never, ['node.js', 'backend', 'engineer', 'senior'])
    expect(many).toEqual(['node.js', 'backend', 'engineer', 'senior'])
  })
})

describe('getFeed (public cards — never JD, never apply URLs)', () => {
  function discoveryRow(over: Record<string, unknown> = {}) {
    const posting = doc(over)
    return {
      ...posting,
      personalizationScore: 0,
      discoveryScore: 0,
      sortPostedAt: posting.postedAt ?? new Date(0),
      locationPreferenceMatched: false,
    }
  }

  function feedRows(rows: unknown[], over: Record<string, unknown> = {}) {
    mockDiscoverFeed.mockResolvedValueOnce({
      rows,
      pageSize: 20,
      total: rows.length,
      accessibleTotal: rows.length,
      resultCap: 400,
      capped: false,
      hasNext: false,
      hasPrevious: false,
      sort: 'best',
      ...over,
    })
  }

  beforeEach(() => mockDiscoverFeed.mockReset())

  it('maps card-safe fields and the canonical tier badge without JD or URLs', async () => {
    feedRows([discoveryRow()])
    const feed = await getFeed({}, NOW)
    expect(feed.cards).toHaveLength(1)
    const card = feed.cards[0] as Record<string, unknown>
    expect(card.relevance).toBe('discovery')
    expect(card.applyTier).toBe('direct-ats')
    expect(JSON.stringify(card)).not.toContain('applyUrl')
    expect(card.jd).toBeUndefined()
    expect(card.jdCompressed).toBeUndefined()
  })

  it('passes public discovery intent and page size to the database query', async () => {
    feedRows([])
    const query = { domain: 'backend', location: 'Bangalore', pageSize: 1 } as const
    await getFeed(query, NOW)
    expect(mockDiscoverFeed).toHaveBeenCalledWith(query, NOW, 1)
  })

  it('forwards generic target/resume signals to discovery and refines its returned Best-match page', async () => {
    feedRows([
      discoveryRow({
        _id: 'fresh-fullstack',
        title: 'Kubernetes Developer',
        titleTokens: ['developer', 'kubernetes'],
        domain: 'fullstack',
        postedAt: NOW,
      }),
      discoveryRow({
        _id: 'older-backend',
        title: 'Platform Engineer',
        titleTokens: ['engineer', 'platform'],
        domain: 'backend',
        postedAt: new Date('2026-07-07T12:00:00Z'),
      }),
    ])
    const query = {
      roleDomain: 'backend',
      targetRole: 'Platform Engineer',
      skills: ['Kubernetes'],
    }
    const feed = await getFeed(query, NOW)
    expect(mockDiscoverFeed).toHaveBeenCalledWith(query, NOW, undefined)
    expect(feed.cards.map((c) => c.id)).toEqual(['fresh-fullstack', 'older-backend'])
    expect(feed.total).toBe(2)
    expect(feed.pageSize).toBe(20)
  })

  it('reveal honesty: sharpened counts ONLY cards with real matched skills; cards carry them', async () => {
    feedRows([
      discoveryRow({ _id: 'hit', title: 'SQL Analyst', titleTokens: ['sql', 'analyst'] }),
      discoveryRow({ _id: 'miss', title: 'Sales Executive', titleTokens: ['sales', 'executive'] }),
    ])
    const feed = await getFeed({ skills: ['SQL', 'Tableau'] }, NOW)
    expect(feed.sharpened).toBe(1)
    const hit = feed.cards.find((c) => c.id === 'hit')!
    const miss = feed.cards.find((c) => c.id === 'miss')!
    expect(hit.matchedSkills).toEqual(['SQL'])
    expect(hit.relevance).toBe('resume')
    expect(miss.matchedSkills).toEqual([])
    expect(miss.relevance).toBe('discovery')
  })

  it('keeps Newest chronological even when private matches exist', async () => {
    feedRows([
      discoveryRow({ _id: 'newest', title: 'Sales Executive', titleTokens: ['sales'], postedAt: NOW }),
      discoveryRow({ _id: 'older-hit', title: 'SQL Analyst', titleTokens: ['sql'], postedAt: new Date('2026-07-13') }),
    ], { sort: 'newest' })
    const feed = await getFeed({
      sort: 'newest',
      roleDomain: 'backend',
      targetRole: 'SQL Analyst',
      skills: ['SQL'],
    }, NOW)
    expect(feed.cards.map((card) => card.id)).toEqual(['newest', 'older-hit'])
    expect(feed.sharpened).toBe(1)
  })

  it('preserves exact/capped totals and opaque cursor navigation', async () => {
    feedRows([discoveryRow()], {
      total: 912,
      accessibleTotal: 400,
      capped: true,
      hasNext: true,
      hasPrevious: true,
      nextCursor: 'next-token',
      previousCursor: 'previous-token',
    })
    const feed = await getFeed({ cursor: 'current-token', direction: 'after' }, NOW)
    expect(feed).toMatchObject({
      total: 912,
      accessibleTotal: 400,
      resultCap: 400,
      capped: true,
      hasMore: true,
      hasPrevious: true,
      nextCursor: 'next-token',
      previousCursor: 'previous-token',
    })
  })
})

describe('getJobDetail (P-2: the anon/authed split is structural)', () => {
  beforeEach(() => {
    vi.stubEnv('NEXTAUTH_SECRET', 'test-secret-longer-than-sixteen-characters')
    mockGetActiveCatalog.mockReset()
    mockGetActiveCatalog.mockResolvedValue(ACTIVE_CATALOG)
    mockAppFindOne.mockReturnValue({ select: () => ({ lean: () => Promise.resolve(null) }) })
    mockUserFindById.mockReset()
    mockUserFindById.mockReturnValue({
      select: () => ({ lean: () => Promise.resolve({ experienceLevel: '3-6' }) }),
    })
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
    expect((d as Record<string, unknown>).practiceExperience).toBeUndefined()
    expect((d as Record<string, unknown>).practiceBlocker).toBeUndefined()
    expect(mockUserFindById).not.toHaveBeenCalled()
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

  it.each(['0-2', '7+'] as const)(
    'binds Practice readiness to the authenticated profile experience %s',
    async (experienceLevel) => {
      const canonical = 'Build secure backend services at production scale.'
      mockUserFindById.mockReturnValueOnce({
        select: () => ({ lean: () => Promise.resolve({ experienceLevel }) }),
      })
      mockFindById.mockReturnValue({ lean: () => Promise.resolve(doc({
        jdCompressed: gzipSync(Buffer.from(canonical)),
      })) })

      const detail = requireFullDetail(await getJobDetail('j1', 'u1'))

      expect(detail).toMatchObject({
        capabilities: { practice: true },
        practiceRole: 'backend',
        practiceExperience: experienceLevel,
        practiceHandoffToken: expect.any(String),
      })
      expect(detail).not.toHaveProperty('practiceBlocker')
    },
  )

  it('requires profile experience without leaking malformed profile data', async () => {
    mockUserFindById.mockReturnValueOnce({
      select: () => ({ lean: () => Promise.resolve({ experienceLevel: 'arbitrary-seniority' }) }),
    })
    mockFindById.mockReturnValue({ lean: () => Promise.resolve(doc({
      jdCompressed: gzipSync(Buffer.from('Build backend services with Node.js.')),
    })) })

    const detail = requireFullDetail(await getJobDetail('j1', 'u1'))

    expect(detail.capabilities.practice).toBe(false)
    expect(detail.practiceBlocker).toBe('experience-required')
    expect(detail).not.toHaveProperty('practiceExperience')
    expect(detail).not.toHaveProperty('practiceRole')
    expect(detail).not.toHaveProperty('practiceHandoffToken')
    expect(JSON.stringify(detail)).not.toContain('arbitrary-seniority')
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
    const canonical = 'Current job description for Tailor metadata.'
    const select = vi.fn().mockReturnValue({ lean: () => Promise.resolve({
      _id: 'app-1',
      status: 'apply_clicked',
      tailoredVersion: { createdAt: NOW, jdHash: xrayHashOf(canonical) },
      appliedWith: { wasTailored: true },
      verifiedPracticeSessionIds: ['a', 'b', 'c', 'd', 'e'],
      interviewDateConfidence: 'week',
      interviewDatePreference: 'this-week',
      outcome: { interviewRounds: 2, revision: 9 },
    }) })
    mockFindById.mockReturnValue({ lean: () => Promise.resolve(doc({
      jdCompressed: gzipSync(Buffer.from(canonical)),
    })) })
    mockAppFindOne.mockReturnValueOnce({ select })
    const d = await getJobDetail('j1', 'u1')
    if (!d!.gated) expect(d!.application).toMatchObject({
      applicationId: 'app-1',
      status: 'apply_clicked',
      practiceCount: 3,
      interviewDate: undefined,
      interviewDateConfidence: 'week',
      interviewDatePreference: 'this-week',
      outcomeRoundsCompleted: 2,
      outcomeRevision: 9,
      tailoredResume: { createdAt: NOW.toISOString(), current: true },
      appliedWith: { wasTailored: true },
      ats: { state: 'none' },
    }) // practiceCount capped at 3
    expect(select).toHaveBeenCalledWith(expect.stringContaining('outcome.interviewRounds outcome.revision'))
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

  it('normal archives return the typed gone outcome for anonymous and authenticated non-owners', async () => {
    mockAppFindOne.mockClear()
    mockFindById.mockReturnValue({ lean: () => Promise.resolve(doc({ status: 'closed', closedReason: 'aged-out' })) })
    expect(await getJobDetail('j1', null)).toBe(JOB_DETAIL_GONE)
    expect(mockAppFindOne).not.toHaveBeenCalled()
    expect(mockPostingExists.mock.calls.at(-1)?.[0]).toEqual({
      _id: 'j1',
      status: 'closed',
      closedReason: 'aged-out',
    })

    mockFindById.mockReturnValue({ lean: () => Promise.resolve(doc({ status: 'closed', closedReason: 'aged-out' })) })
    mockAppFindOne.mockReturnValueOnce({ select: () => ({ lean: () => Promise.resolve(null) }) })
    expect(await getJobDetail('j1', 'other-user')).toBe(JOB_DETAIL_GONE)
  })

  it('does not emit a stale gone outcome when archive authority changes after the read', async () => {
    mockFindById.mockReturnValue({
      lean: () => Promise.resolve(doc({ status: 'closed', closedReason: 'aged-out' })),
    })
    mockPostingExists.mockResolvedValueOnce(null)

    expect(await getJobDetail('j1', null)).toBeNull()
    expect(mockPostingExists.mock.calls.at(-1)?.[0]).toEqual({
      _id: 'j1',
      status: 'closed',
      closedReason: 'aged-out',
    })
  })

  it.each(['source-revoked', 'llm-verdict', undefined])(
    'restricted closure %s and unknown postings remain indistinguishable from missing',
    async (closedReason) => {
      mockFindById.mockReturnValueOnce({
        lean: () => Promise.resolve(doc({ status: 'closed', closedReason })),
      })
      if (closedReason !== undefined) {
        mockAppFindOne.mockReturnValueOnce({ select: () => ({ lean: () => Promise.resolve(null) }) })
      }
      expect(await getJobDetail('j1', closedReason === undefined ? null : 'other-user')).toBeNull()
    },
  )

  it('unknown posting remains not found for an authenticated caller without a tracker snapshot', async () => {
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

    expect(await getJobDetail('j1', 'u1')).toBe(JOB_DETAIL_GONE)
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
      tailoredVersion: { createdAt: NOW, jdHash: xrayHashOf('sensitive removed body') },
      appliedWith: { wasTailored: true },
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
    expect(detail.application).not.toHaveProperty('tailoredResume')
    expect(detail.application?.appliedWith).toEqual({ wasTailored: true })
    expect(detail.application?.ats).toMatchObject({ state: 'done' })
    expect(detail.application?.ats).not.toHaveProperty('score')
    expect(detail.application?.ats).not.toHaveProperty('missingKeywords')
    expect(detail.capabilities).toEqual({ apply: false, viewSource: false, xray: false, tailor: false, practice: false, atsCheck: false })
    expect(detail).not.toHaveProperty('jd')
    expect(detail).not.toHaveProperty('applyTier')
    expect(detail).not.toHaveProperty('practiceHandoffToken')
    expect(detail).not.toHaveProperty('practiceExperience')
    expect(detail).not.toHaveProperty('practiceBlocker')
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
      outcome: { interviewRounds: 4, revision: 12 },
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
      application: {
        applicationId: 'app-snapshot',
        status: 'offer',
        practiceCount: 1,
        outcomeRoundsCompleted: 4,
        outcomeRevision: 12,
      },
    })
    expect(detail.capabilities).toEqual({ apply: false, viewSource: false, xray: false, tailor: false, practice: false, atsCheck: false })
    expect(detail).not.toHaveProperty('practiceExperience')
    expect(detail).not.toHaveProperty('practiceBlocker')
    expect(JSON.stringify(detail)).not.toContain('secret.example')
    expect(detail.application?.ats).toMatchObject({ state: 'done' })
    expect(detail.application?.ats).not.toHaveProperty('score')
    expect(detail.application?.ats).not.toHaveProperty('missingKeywords')
    expect(JSON.stringify(detail)).not.toContain('deleted-JD-keyword')
  })
})
