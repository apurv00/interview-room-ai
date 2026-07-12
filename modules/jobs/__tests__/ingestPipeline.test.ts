import { describe, it, expect, vi } from 'vitest'

const { mockFindOne, mockFind, mockCreate } = vi.hoisted(() => ({
  mockFindOne: vi.fn(),
  mockFind: vi.fn(),
  mockCreate: vi.fn(),
}))
vi.mock('@shared/db/models', () => ({
  JobPosting: { findOne: mockFindOne, find: mockFind, create: mockCreate },
}))

import { ingestBatch, evictProvenance, makeRedisRepostCounter } from '../services/ingestPipeline'
import type { NormalizedJob } from '../adapters/types'

const LONG_JD = 'A genuine role with real responsibilities and requirements. '.repeat(10)

function job(overrides: Partial<NormalizedJob> = {}): NormalizedJob {
  return {
    title: 'Backend Developer',
    company: 'Acme Pvt Ltd',
    city: 'Pune',
    isRemote: false,
    description: LONG_JD,
    postedAt: '2026-07-10T00:00:00Z',
    validThrough: null,
    externalId: 'ext-1',
    viaSite: 'linkedin',
    applyOptions: [{ url: 'https://careers.acme.com/1' }],
    domainHint: 'backend',
    ...overrides,
  }
}

function reset(): void {
  mockFindOne.mockReset().mockResolvedValue(null)
  mockFind.mockReset().mockReturnValue({ limit: () => Promise.resolve([]) })
  mockCreate.mockReset().mockResolvedValue({})
}

function docStub(overrides: Record<string, unknown> = {}) {
  return {
    status: 'open',
    provenance: [] as Array<Record<string, unknown>>,
    locationKeys: [] as string[],
    locations: [] as string[],
    jdLength: 0,
    postedAt: undefined as Date | undefined,
    save: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  }
}

describe('ingestBatch — identity ladder', () => {
  it('inserts a clean new posting with fingerprint + provenance', async () => {
    reset()
    const c = await ingestBatch([job()], 'jsearch')
    expect(c.newCount).toBe(1)
    expect(mockCreate).toHaveBeenCalledTimes(1)
    const doc = mockCreate.mock.calls[0][0]
    expect(doc.fingerprint).toMatch(/^[0-9a-f]{24}$/)
    expect(doc.provenance[0].sourceKey).toBe('jsearch:ext-1')
    expect(doc.provenance[0].applyTier).toBe('employer')
    expect(doc.domain).toBe('backend')
  })

  it('hard drops are never stored and are counted per rule', async () => {
    reset()
    const c = await ingestBatch([job({ description: `${LONG_JD} Pay Rs 500 before joining` })], 'jsearch')
    expect(c.drops['fee-fraud']).toBe(1)
    expect(mockCreate).not.toHaveBeenCalled()
  })

  it('tier 1: sourceKey match refreshes lastSeenAt (no new doc)', async () => {
    reset()
    const existing = docStub({
      provenance: [{ sourceId: 'jsearch', externalId: 'ext-1', sourceKey: 'jsearch:ext-1', lastSeenAt: new Date('2026-07-01') }],
      jdLength: 999,
    })
    mockFindOne.mockResolvedValueOnce(existing)
    const c = await ingestBatch([job()], 'jsearch')
    expect(c.refreshed).toBe(1)
    expect(existing.save).toHaveBeenCalled()
    expect(mockCreate).not.toHaveBeenCalled()
  })

  it('tier 2: fingerprint merge takes longest JD, earliest postedAt, unions locations', async () => {
    reset()
    const existing = docStub({ jdLength: 10, postedAt: new Date('2026-07-11T00:00:00Z'), locationKeys: ['delhi-ncr'] })
    mockFindOne
      .mockResolvedValueOnce(null) // sourceKey miss
      .mockResolvedValueOnce(existing) // fp hit
    const c = await ingestBatch([job()], 'jsearch')
    expect(c.merged).toBe(1)
    expect(existing.jdLength).toBeGreaterThan(10)
    expect(existing.postedAt).toEqual(new Date('2026-07-10T00:00:00Z')) // earliest wins
    expect(existing.locationKeys).toContain('pune')
  })

  it('[guard #1] same source + different externalId + both open ⇒ salted insert, never merge', async () => {
    reset()
    const existing = docStub({
      provenance: [{ sourceId: 'jsearch', externalId: 'ext-OTHER', sourceKey: 'jsearch:ext-OTHER', lastSeenAt: new Date() }],
    })
    mockFindOne
      .mockResolvedValueOnce(null) // sourceKey miss
      .mockResolvedValueOnce(existing) // fp hit
    const c = await ingestBatch([job()], 'jsearch')
    expect(c.saltedInserts).toBe(1)
    expect(c.newCount).toBe(1)
    expect(existing.save).not.toHaveBeenCalled()
    const doc = mockCreate.mock.calls[0][0]
    expect(doc.fingerprint).toMatch(/^[0-9a-f]{24}$/) // salted, still a valid fp shape
  })

  it('[guard #2] confidential companies mint no fingerprint and skip fp/fuzzy tiers', async () => {
    reset()
    const c = await ingestBatch([job({ company: 'Confidential' })], 'jsearch')
    expect(c.newCount).toBe(1)
    const doc = mockCreate.mock.calls[0][0]
    expect(doc.fingerprint).toBeUndefined()
    expect(doc.confidentialCompany).toBe(true)
    // findOne called only for sourceKey tier, never for a fingerprint
    expect(mockFindOne).toHaveBeenCalledTimes(1)
  })

  it('tier 3: company-scoped fuzzy merge at Jaccard ≥ 0.85 with location overlap', async () => {
    reset()
    const candidate = docStub({ titleKey: 'backend developer senior', locationKeys: ['pune'], jdLength: 5 })
    mockFind.mockReturnValueOnce({ limit: () => Promise.resolve([candidate]) })
    // sourceKey miss + fp miss
    mockFindOne.mockResolvedValue(null)
    const c = await ingestBatch([job({ title: 'Senior Backend Developer (Urgent)' })], 'jsearch')
    expect(c.fuzzyMerged).toBe(1)
    expect(candidate.save).toHaveBeenCalled()
  })

  it('mass-repost: >3 distinct companies drops; Redis failure is fail-open (stored)', async () => {
    reset()
    const c1 = await ingestBatch([job()], 'jsearch', { registerRepost: async () => 4 })
    expect(c1.drops['mass-repost']).toBe(1)
    reset()
    const c2 = await ingestBatch([job()], 'jsearch', { registerRepost: async () => { throw new Error('redis down') } })
    expect(c2.newCount).toBe(1) // fail-open
    reset()
    const c3 = await ingestBatch([job()], 'jsearch', { registerRepost: async () => 2 })
    expect(c3.flagged['repost']).toBe(1)
    expect(c3.newCount).toBe(1) // 2-3 companies = flag, still stored
  })
})

describe('evictProvenance [guard #3]', () => {
  it('evicts stale duplicates before ever touching another source’s only entry', () => {
    const entries = [
      { sourceId: 'apna', lastSeenAt: new Date('2026-01-01') }, // oldest, but sole apna entry
      ...Array.from({ length: 8 }, (_, i) => ({ sourceId: 'jsearch', lastSeenAt: new Date(`2026-02-0${i + 1}`) })),
    ]
    const kept = evictProvenance(entries, 8)
    expect(kept).toHaveLength(8)
    expect(kept.some((e) => e.sourceId === 'apna')).toBe(true) // diversity preserved
  })
})

describe('makeRedisRepostCounter', () => {
  it('registers and returns distinct-company cardinality; sets TTL on first add', async () => {
    const sadd = vi.fn().mockResolvedValue(1)
    const expire = vi.fn().mockResolvedValue(1)
    const scard = vi.fn().mockResolvedValue(1)
    const counter = makeRedisRepostCounter({ sadd, expire, scard })
    await expect(counter('hash1', 'acme')).resolves.toBe(1)
    expect(expire).toHaveBeenCalledWith('jobs:repost:7d:hash1', 7 * 24 * 3600)
  })

  it('fail-open on redis errors', async () => {
    const counter = makeRedisRepostCounter({
      sadd: vi.fn().mockRejectedValue(new Error('down')),
      expire: vi.fn(),
      scard: vi.fn(),
    })
    await expect(counter('hash1', 'acme')).resolves.toBeNull()
  })
})
