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

describe('Codex #510 regressions', () => {
  it('a row with NO apply link stores with url-less provenance (no batch abort)', async () => {
    reset()
    const c = await ingestBatch([job({ applyOptions: [] })], 'jsearch')
    expect(c.newCount).toBe(1)
    const doc = mockCreate.mock.calls[0][0]
    expect(doc.provenance[0].applyUrl).toBeUndefined()
    expect(doc.provenance[0].applyTier).toBeUndefined()
    expect(doc.provenance[0].sourceKey).toBe('jsearch:ext-1')
  })

  it('a malformed validThrough stores FLAGGED with no date — never Invalid Date', async () => {
    reset()
    const c = await ingestBatch([job({ validThrough: 'not-a-date' })], 'jsearch')
    expect(c.newCount).toBe(1)
    expect(c.flagged['bad-valid-through']).toBe(1)
    expect(mockCreate.mock.calls[0][0].validThrough).toBeUndefined()
  })

  it('[guard #1 fuzzy tier] a candidate carrying the same source under a different externalId is never fuzzy-merged', async () => {
    reset()
    const sibling = docStub({
      titleKey: 'backend developer senior',
      locationKeys: ['pune'],
      provenance: [{ sourceId: 'jsearch', externalId: 'ext-OTHER', sourceKey: 'jsearch:ext-OTHER', lastSeenAt: new Date() }],
    })
    mockFind.mockReturnValueOnce({ limit: () => Promise.resolve([sibling]) })
    mockFindOne.mockResolvedValue(null)
    const c = await ingestBatch([job({ title: 'Senior Backend Developer (Urgent)' })], 'jsearch')
    expect(c.fuzzyMerged).toBe(0)
    expect(sibling.save).not.toHaveBeenCalled()
    expect(c.newCount).toBe(1) // inserted as its own posting
  })

  it('a re-fetched aged-out posting REOPENS (status + close metadata cleared)', async () => {
    reset()
    const closed = docStub({
      status: 'closed',
      closedReason: 'aged-out',
      closedAt: new Date('2026-07-01'),
      purgeAt: new Date('2026-07-08'),
      provenance: [{ sourceId: 'jsearch', externalId: 'ext-1', sourceKey: 'jsearch:ext-1', lastSeenAt: new Date('2026-06-25') }],
    })
    mockFindOne.mockResolvedValueOnce(closed)
    const c = await ingestBatch([job()], 'jsearch')
    expect(c.refreshed).toBe(1)
    expect(closed.status).toBe('open')
    expect(closed.closedReason).toBeUndefined()
    expect(closed.purgeAt).toBeUndefined()
    expect(closed.save).toHaveBeenCalled()
  })

  it('a sourceKey hit refreshes the apply path when the source now supplies one', async () => {
    reset()
    const existing = docStub({
      provenance: [{
        sourceId: 'jsearch', externalId: 'ext-1', sourceKey: 'jsearch:ext-1',
        applyUrl: undefined, applyTier: undefined, lastSeenAt: new Date('2026-07-01'),
      }],
      jdLength: 999,
    })
    mockFindOne.mockResolvedValueOnce(existing)
    await ingestBatch([job({ applyOptions: [{ url: 'https://boards.greenhouse.io/acme/jobs/9' }] })], 'jsearch')
    const entry = existing.provenance[0] as Record<string, unknown>
    expect(entry.applyUrl).toBe('https://boards.greenhouse.io/acme/jobs/9')
    expect(entry.applyTier).toBe('direct-ats')
  })

  it('an incoming payload WITHOUT urls never erases a stored apply link', async () => {
    reset()
    const existing = docStub({
      provenance: [{
        sourceId: 'jsearch', externalId: 'ext-1', sourceKey: 'jsearch:ext-1',
        applyUrl: 'https://careers.acme.com/1', applyTier: 'employer', lastSeenAt: new Date('2026-07-01'),
      }],
      jdLength: 999,
    })
    mockFindOne.mockResolvedValueOnce(existing)
    await ingestBatch([job({ applyOptions: [] })], 'jsearch')
    const entry = existing.provenance[0] as Record<string, unknown>
    expect(entry.applyUrl).toBe('https://careers.acme.com/1')
    expect(entry.applyTier).toBe('employer')
  })

  it('an llm-verdict tombstone STAYS closed on re-fetch (anti-resurrection, ruling #16)', async () => {
    reset()
    const tombstone = docStub({
      status: 'closed',
      closedReason: 'llm-verdict',
      provenance: [{ sourceId: 'jsearch', externalId: 'ext-1', sourceKey: 'jsearch:ext-1', lastSeenAt: new Date('2026-06-25') }],
    })
    mockFindOne.mockResolvedValueOnce(tombstone)
    const c = await ingestBatch([job()], 'jsearch')
    expect(c.refreshed).toBe(1) // lastSeenAt still refreshes
    expect(tombstone.status).toBe('closed')
    expect(tombstone.closedReason).toBe('llm-verdict')
  })

  it('one store failure is isolated — the rest of the batch proceeds', async () => {
    reset()
    mockCreate.mockRejectedValueOnce(new Error('validation failed')).mockResolvedValueOnce({})
    const c = await ingestBatch([job(), job({ externalId: 'ext-2', title: 'Data Analyst' })], 'jsearch')
    expect(c.storeErrors).toBe(1)
    expect(c.newCount).toBe(1)
    expect(c.processed).toBe(2)
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

describe('scored-verdict invalidation on merge (§4.5 input change re-enqueues)', () => {
  it('a longer merged JD resets a scored verdict to pending (fresh attempts)', async () => {
    reset()
    const existing = docStub({
      provenance: [{ sourceId: 'jsearch', externalId: 'ext-1', sourceKey: 'jsearch:ext-1', lastSeenAt: new Date('2026-07-01') }],
      jdLength: 10, // incoming body is longer → JD replace
      llmVerdict: { status: 'scored', verdict: 'genuine', attempts: 3, verdictInputHash: 'stale' },
    })
    mockFindOne.mockResolvedValueOnce(existing)
    await ingestBatch([job()], 'jsearch')
    expect(existing.llmVerdict.status).toBe('pending')
    expect(existing.llmVerdict.attempts).toBe(0)
  })

  it('an unchanged refresh (same JD length, same apply URL) leaves scored verdicts alone', async () => {
    reset()
    const j = job()
    const existing = docStub({
      provenance: [{ sourceId: 'jsearch', externalId: 'ext-1', sourceKey: 'jsearch:ext-1', applyUrl: j.applyOptions[0].url, applyTier: 'direct-ats', lastSeenAt: new Date('2026-07-01') }],
      jdLength: 99999, // incoming shorter → no JD replace
      llmVerdict: { status: 'scored', verdict: 'genuine', attempts: 3, verdictInputHash: 'h' },
    })
    mockFindOne.mockResolvedValueOnce(existing)
    await ingestBatch([j], 'jsearch')
    expect(existing.llmVerdict.status).toBe('scored')
    expect(existing.llmVerdict.attempts).toBe(3)
  })

  it('an attempts-exhausted PENDING row also resets on input change — never skipped forever (Codex #515)', async () => {
    reset()
    const existing = docStub({
      provenance: [{ sourceId: 'jsearch', externalId: 'ext-1', sourceKey: 'jsearch:ext-1', lastSeenAt: new Date('2026-07-01') }],
      jdLength: 10, // incoming longer → input change
      llmVerdict: { status: 'pending', attempts: 5 },
    })
    mockFindOne.mockResolvedValueOnce(existing)
    await ingestBatch([job()], 'jsearch')
    expect(existing.llmVerdict.attempts).toBe(0)
    expect(existing.llmVerdict.status).toBe('pending')
  })

  it('an apply-URL change resets a scored verdict (hosts are hash inputs) AND clears dead-click reports', async () => {
    reset()
    const existing = docStub({
      provenance: [{ sourceId: 'jsearch', externalId: 'ext-1', sourceKey: 'jsearch:ext-1', applyUrl: 'https://old.example.com/x', applyTier: 'employer', brokenReportCount: 3, lastSeenAt: new Date('2026-07-01') }],
      jdLength: 99999,
      llmVerdict: { status: 'scored', verdict: 'genuine', attempts: 2, verdictInputHash: 'h' },
    })
    mockFindOne.mockResolvedValueOnce(existing)
    await ingestBatch([job()], 'jsearch')
    expect(existing.llmVerdict.status).toBe('pending')
    // reports indict a URL, not a rung — the fresh URL starts clean
    expect(existing.provenance[0].brokenReportCount).toBeUndefined()
  })
})

describe('llmVerdict pending-init (§4.5 — data switch, byte-identical when off)', () => {
  it('off (default): the insert doc has NO llmVerdict key materialized', async () => {
    reset()
    await ingestBatch([job()], 'jsearch')
    expect(mockCreate.mock.calls[0][0].llmVerdict).toBeUndefined()
  })

  it('on: new survivors are stored pending/attempts:0 for the sweeper partial index', async () => {
    reset()
    await ingestBatch([job()], 'jsearch', { initVerdictPending: true })
    expect(mockCreate.mock.calls[0][0].llmVerdict).toEqual({ status: 'pending', attempts: 0 })
  })
})

describe('jdDisplayCompressed — the display twin (PR-C, founder item 7)', () => {
  it('a new insert writes BOTH the canonical collapsed body and the display twin', async () => {
    reset()
    await ingestBatch([job({ description: '<p>Intro para.</p><ul><li>Do X</li><li>Do Y</li></ul>' })], 'jsearch')
    const doc = mockCreate.mock.calls[0][0] as Record<string, unknown>
    const { gunzipSync } = await import('zlib')
    const canonical = gunzipSync(doc.jdCompressed as Buffer).toString('utf8')
    const display = gunzipSync(doc.jdDisplayCompressed as Buffer).toString('utf8')
    expect(canonical).toBe('Intro para. Do X Do Y') // byte-identical pre-PR-C semantics
    expect(display).toContain('\n') // structure preserved
    // Same CONTENT: display collapses back to the canonical body exactly.
    expect(display.replace(/\s+/g, ' ').trim()).toBe(canonical)
  })

  it('a longer merged JD replaces BOTH bodies (verdict reset already pinned above)', async () => {
    reset()
    const existing = docStub({
      provenance: [{ sourceId: 'jsearch', externalId: 'ext-1', sourceKey: 'jsearch:ext-1', lastSeenAt: new Date('2026-07-01') }],
      jdLength: 10,
    })
    mockFindOne.mockResolvedValueOnce(existing)
    await ingestBatch([job()], 'jsearch')
    expect((existing as Record<string, unknown>).jdCompressed).toBeDefined()
    expect((existing as Record<string, unknown>).jdDisplayCompressed).toBeDefined()
  })

  it('LEGACY HEAL: same body re-ingested on a row without the twin writes ONLY the display artifact — verdict state untouched', async () => {
    reset()
    const { gzipSync, gunzipSync } = await import('zlib')
    const j = job({ description: '<p>Same body.</p><p>Second para.</p>' })
    // Simulate the pre-PR-C stored state: collapsed body, no display twin.
    const canonical = 'Same body. Second para.'
    const priorCompressed = gzipSync(Buffer.from(canonical))
    const existing = docStub({
      provenance: [{ sourceId: 'jsearch', externalId: 'ext-1', sourceKey: 'jsearch:ext-1', applyUrl: j.applyOptions[0].url, applyTier: 'direct-ats', lastSeenAt: new Date('2026-07-01') }],
      jdLength: canonical.length,
      jdCompressed: priorCompressed,
      llmVerdict: { status: 'scored', verdict: 'genuine', attempts: 3, verdictInputHash: 'h' },
    })
    mockFindOne.mockResolvedValueOnce(existing)
    await ingestBatch([j], 'jsearch')
    const rec = existing as Record<string, unknown>
    // jdCompressed untouched (same object), display twin written, verdict intact.
    expect(rec.jdCompressed).toBe(priorCompressed)
    expect(rec.jdDisplayCompressed).toBeDefined()
    expect(gunzipSync(rec.jdDisplayCompressed as Buffer).toString('utf8')).toBe('Same body.\nSecond para.')
    expect((rec.llmVerdict as Record<string, unknown>).status).toBe('scored')
    expect((rec.llmVerdict as Record<string, unknown>).attempts).toBe(3)
  })

  it('a DIFFERENT same-length body does NOT heal (exact-match guard — the twin must correspond to the stored body)', async () => {
    reset()
    const { gzipSync } = await import('zlib')
    const j = job({ description: '<p>Body version B here</p>' })
    const priorCompressed = gzipSync(Buffer.from('Body version A here!'))
    const existing = docStub({
      provenance: [{ sourceId: 'jsearch', externalId: 'ext-1', sourceKey: 'jsearch:ext-1', applyUrl: j.applyOptions[0].url, applyTier: 'direct-ats', lastSeenAt: new Date('2026-07-01') }],
      jdLength: 99999, // incoming shorter → no replace branch
      jdCompressed: priorCompressed,
    })
    mockFindOne.mockResolvedValueOnce(existing)
    await ingestBatch([j], 'jsearch')
    expect((existing as Record<string, unknown>).jdDisplayCompressed).toBeUndefined()
  })
})
