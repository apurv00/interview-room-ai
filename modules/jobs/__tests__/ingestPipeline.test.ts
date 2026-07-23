import { describe, it, expect, vi } from 'vitest'

const {
  mockFindOne,
  mockFindById,
  mockFind,
  mockCreate,
  mockHasRestoredQualityDecision,
  mockRecordAutomaticQualityDecision,
} = vi.hoisted(() => ({
  mockFindOne: vi.fn(),
  mockFindById: vi.fn(),
  mockFind: vi.fn(),
  mockCreate: vi.fn(),
  mockHasRestoredQualityDecision: vi.fn(),
  mockRecordAutomaticQualityDecision: vi.fn(),
}))
vi.mock('@shared/db/models', () => ({
  JOB_SOURCE_LINEAGE_UNKNOWN: '__legacy_unknown__',
  JobPosting: { findOne: mockFindOne, findById: mockFindById, find: mockFind, create: mockCreate },
}))
vi.mock('../services/qualityDecisionService', () => ({
  hasRestoredQualityDecision: mockHasRestoredQualityDecision,
  recordAutomaticQualityDecision: mockRecordAutomaticQualityDecision,
}))

import { ingestBatch, evictProvenance, makeRedisRepostCounter } from '../services/ingestPipeline'
import type { NormalizedJob } from '../adapters/types'
import { groupApplyLinkSubjects } from '../services/linkGovernance'
import { normalizeJdBody } from '../services/qualityGate'

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
  mockFindById.mockReset().mockResolvedValue(null)
  mockFind.mockReset().mockReturnValue({ limit: () => Promise.resolve([]) })
  mockCreate.mockReset().mockResolvedValue({})
  mockHasRestoredQualityDecision.mockReset().mockResolvedValue(false)
  mockRecordAutomaticQualityDecision.mockReset().mockResolvedValue({
    decisionKey: `quality:v1:${'a'.repeat(64)}`,
    inserted: true,
  })
}

function docStub(overrides: Record<string, unknown> = {}) {
  return {
    _id: 'p1',
    updatedAt: new Date('2026-07-20T00:00:00Z'),
    status: 'open',
    sourceIds: [] as string[],
    provenance: [] as Array<Record<string, unknown>>,
    locationKeys: [] as string[],
    locations: [] as string[],
    jdLength: 0,
    postedAt: undefined as Date | undefined,
    save: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  }
}

function governedEntry(
  entry: Record<string, unknown>,
  governance: Record<string, unknown> = {},
): Record<string, unknown> {
  const group = groupApplyLinkSubjects([entry])[0]
  return {
    ...entry,
    linkGovernance: { ...group.governance, ...governance },
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
    expect(doc.sourceIds).toEqual(['jsearch'])
    expect(doc.provenance[0].sourceKey).toBe('jsearch:ext-1')
    expect(doc.provenance[0].applyTier).toBe('employer')
    expect(doc.provenance[0].applyUrlFirstSeenAt).toBeInstanceOf(Date)
    expect(doc.provenance[0].linkGovernance).toMatchObject({
      subject: expect.stringMatching(/^ls1_/),
      generation: expect.stringMatching(/^lg1_/),
      incidentVersion: 1,
      reportCount: 0,
    })
    expect(doc.domain).toBe('backend')
    expect(doc.lastSeenAt).toBeInstanceOf(Date)
  })

  it('retains source lineage when the provider row has no external id', async () => {
    reset()

    const c = await ingestBatch([job({ externalId: null })], 'jsearch')

    expect(c.newCount).toBe(1)
    const inserted = mockCreate.mock.calls[0][0]
    expect(inserted.sourceIds).toEqual(['jsearch'])
    expect(inserted.provenance).toEqual([])
    expect(inserted.lastSeenAt).toBeInstanceOf(Date)
  })

  it('conservatively marks cap-reached legacy lineage while adding the current source', async () => {
    reset()
    const provenance = Array.from({ length: 8 }, (_, index) => ({
      sourceId: index === 0 ? 'jsearch' : `source-${index}`,
      externalId: index === 0 ? 'ext-1' : `ext-${index}`,
      sourceKey: index === 0 ? 'jsearch:ext-1' : `source-${index}:ext-${index}`,
      lastSeenAt: new Date('2026-07-01'),
    }))
    const existing = docStub({ provenance, jdLength: 999 })
    mockFindOne.mockResolvedValueOnce(existing)

    await ingestBatch([job()], 'jsearch')

    expect(existing.sourceIds).toEqual([
      'jsearch',
      'source-1',
      'source-2',
      'source-3',
      'source-4',
      'source-5',
      'source-6',
      'source-7',
      '__legacy_unknown__',
    ])
  })

  it('hard drops are never stored and are counted per rule', async () => {
    reset()
    const c = await ingestBatch([job({ description: `${LONG_JD} Pay Rs 500 before joining` })], 'jsearch')
    expect(c.drops['fee-fraud']).toBe(1)
    expect(mockCreate).not.toHaveBeenCalled()
  })

  it('records hard-drop evidence in the source transaction before discarding the row', async () => {
    reset()
    const session = { id: 'source-fence-session' }
    const rejected = job({ description: `${LONG_JD} Pay Rs 500 before joining` })

    const counters = await ingestBatch([rejected], 'jsearch', {
      session: session as never,
      sourceControlRevision: 4,
      sourceOperationalRevision: 9,
    })

    expect(counters.drops).toMatchObject({ 'fee-fraud': 1 })
    expect(mockCreate).not.toHaveBeenCalled()
    expect(mockHasRestoredQualityDecision).toHaveBeenCalledWith(expect.objectContaining({
      domain: 'hard-drop',
      action: 'drop',
      subjectKey: expect.stringMatching(/^jsearch:content:[a-f0-9]{64}$/),
      inputHash: expect.stringMatching(/^[a-f0-9]{64}$/),
      policyRevision: 'jobs-quality-gate:v1',
      sourceRevisions: [{ sourceId: 'jsearch', controlRevision: 4, operationalRevision: 9 }],
    }), session)
    expect(mockRecordAutomaticQualityDecision).toHaveBeenCalledWith(expect.objectContaining({
      domain: 'hard-drop',
      action: 'drop',
      evidence: {
        kind: 'hard-drop',
        reasonCodes: ['fee-fraud'],
        bodyLength: normalizeJdBody(rejected.description).length,
        applyHosts: ['careers.acme.com'],
      },
      reviewOverlay: rejected,
    }), session)
  })

  it('admits only the exact restored hard-drop input and re-audits changed content', async () => {
    reset()
    const session = { id: 'source-fence-session' }
    const rejected = job({ description: `${LONG_JD} Pay Rs 500 before joining` })
    mockHasRestoredQualityDecision
      .mockResolvedValueOnce(true)
      .mockResolvedValueOnce(false)

    const restored = await ingestBatch([rejected], 'jsearch', {
      session: session as never,
      sourceControlRevision: 4,
      sourceOperationalRevision: 9,
    })
    const changed = await ingestBatch([{ ...rejected, description: `${rejected.description} Updated.` }], 'jsearch', {
      session: session as never,
      sourceControlRevision: 4,
      sourceOperationalRevision: 9,
    })

    expect(restored).toMatchObject({ newCount: 1, drops: {} })
    expect(changed.drops).toMatchObject({ 'fee-fraud': 1 })
    expect(mockCreate).toHaveBeenCalledTimes(1)
    expect(mockRecordAutomaticQualityDecision).toHaveBeenCalledTimes(1)
    const firstIdentity = mockHasRestoredQualityDecision.mock.calls[0][0]
    const changedIdentity = mockHasRestoredQualityDecision.mock.calls[1][0]
    expect(firstIdentity).toMatchObject({
      subjectKey: changedIdentity.subjectKey,
      sourceRevisions: changedIdentity.sourceRevisions,
    })
    expect(firstIdentity.inputHash).not.toBe(changedIdentity.inputHash)
  })

  it('does not reuse a restore after the same provider payload gains another drop reason', async () => {
    reset()
    const session = { id: 'source-fence-session' }
    const rejected = job({ description: `${LONG_JD} Pay Rs 500 before joining` })
    mockHasRestoredQualityDecision
      .mockResolvedValueOnce(true)
      .mockResolvedValueOnce(false)

    await ingestBatch([rejected], 'jsearch', {
      session: session as never,
      sourceControlRevision: 4,
      sourceOperationalRevision: 9,
    })
    const later = await ingestBatch([rejected], 'jsearch', {
      session: session as never,
      sourceControlRevision: 4,
      sourceOperationalRevision: 9,
      registerRepost: async () => 4,
    })

    const originalIdentity = mockHasRestoredQualityDecision.mock.calls[0][0]
    const expandedIdentity = mockHasRestoredQualityDecision.mock.calls[1][0]
    expect(originalIdentity.subjectKey).toBe(expandedIdentity.subjectKey)
    expect(originalIdentity.inputHash).not.toBe(expandedIdentity.inputHash)
    expect(later.drops).toMatchObject({ 'fee-fraud': 1, 'mass-repost': 1 })
    expect(mockRecordAutomaticQualityDecision).toHaveBeenCalledWith(
      expect.objectContaining({
        inputHash: expandedIdentity.inputHash,
        evidence: expect.objectContaining({
          reasonCodes: ['fee-fraud', 'mass-repost'],
          massRepostCompanyCount: 4,
        }),
      }),
      session,
    )
  })

  it('keeps a mass-repost restore stable when only the observed company count changes', async () => {
    reset()
    const session = { id: 'source-fence-session' }
    const rejected = job({ description: `${LONG_JD} Pay Rs 500 before joining` })
    mockHasRestoredQualityDecision
      .mockResolvedValueOnce(true)
      .mockResolvedValueOnce(true)

    await ingestBatch([rejected], 'jsearch', {
      session: session as never,
      sourceControlRevision: 4,
      sourceOperationalRevision: 9,
      registerRepost: async () => 4,
    })
    const later = await ingestBatch([rejected], 'jsearch', {
      session: session as never,
      sourceControlRevision: 4,
      sourceOperationalRevision: 9,
      registerRepost: async () => 100,
    })

    const countFourIdentity = mockHasRestoredQualityDecision.mock.calls[0][0]
    const countHundredIdentity = mockHasRestoredQualityDecision.mock.calls[1][0]
    expect(countFourIdentity.subjectKey).toBe(countHundredIdentity.subjectKey)
    expect(countFourIdentity.inputHash).toBe(countHundredIdentity.inputHash)
    expect(later).toMatchObject({ newCount: 1, drops: {} })
    expect(mockRecordAutomaticQualityDecision).not.toHaveBeenCalled()
  })

  it('keeps hard-drop identity stable across rotating provider metadata and tracking URLs', async () => {
    reset()
    const session = { id: 'source-fence-session' }
    const first = job({
      externalId: 'rotating-id-1',
      postedAt: '2026-07-10T00:00:00Z',
      description: `${LONG_JD} Pay Rs 500 before joining`,
      applyOptions: [{ url: 'https://careers.acme.com/roles/1?utm_source=first' }],
    })
    const second = {
      ...first,
      externalId: 'rotating-id-2',
      postedAt: '2026-07-10T05:30:00+05:30',
      applyOptions: [{ url: 'https://careers.acme.com/other-provider-path?tracking=second' }],
    }
    mockHasRestoredQualityDecision.mockResolvedValue(true)

    await ingestBatch([first], 'jsearch', {
      session: session as never,
      sourceControlRevision: 4,
      sourceOperationalRevision: 9,
    })
    await ingestBatch([second], 'jsearch', {
      session: session as never,
      sourceControlRevision: 4,
      sourceOperationalRevision: 9,
    })

    expect(mockHasRestoredQualityDecision.mock.calls[0][0])
      .toEqual(mockHasRestoredQualityDecision.mock.calls[1][0])
  })

  it('aborts when hard-drop evidence cannot be recorded', async () => {
    reset()
    const session = { id: 'source-fence-session' }
    const malformed = Object.assign(new Error('review overlay is malformed'), {
      name: 'QualityDecisionValidationError',
    })
    mockRecordAutomaticQualityDecision.mockRejectedValueOnce(malformed)
    const rejected = (externalId: string) =>
      job({ externalId, description: `${LONG_JD} Pay Rs 500 before joining` })

    await expect(ingestBatch(
      [rejected('bad-ledger-row'), rejected('valid-ledger-row')],
      'jsearch',
      {
        session: session as never,
        sourceControlRevision: 4,
        sourceOperationalRevision: 9,
      },
    )).rejects.toBe(malformed)

    expect(mockRecordAutomaticQualityDecision).toHaveBeenCalledOnce()
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

  it.each(['source-revoked', 'llm-verdict'] as const)(
    're-reads after a stale normal-archive reopen and never reverses a newer %s close',
    async (restrictedReason) => {
      reset()
      const provenance = [{
        sourceId: 'jsearch',
        externalId: 'ext-1',
        sourceKey: 'jsearch:ext-1',
        applyUrl: 'https://careers.acme.com/1',
        lastSeenAt: new Date('2026-07-01'),
      }]
      const staleError = new Error('lifecycle CAS missed')
      staleError.name = 'DocumentNotFoundError'
      const staleArchive = docStub({
        status: 'closed',
        closedReason: 'board-poll-miss',
        provenance: structuredClone(provenance),
        jdLength: 999,
        save: vi.fn().mockRejectedValue(staleError),
      })
      const restricted = docStub({
        status: 'closed',
        closedReason: restrictedReason,
        updatedAt: new Date('2026-07-20T01:00:00Z'),
        provenance: structuredClone(provenance),
        jdLength: 999,
      })
      mockFindOne.mockResolvedValueOnce(staleArchive)
      mockFindById.mockResolvedValueOnce(restricted)

      const counters = await ingestBatch([job()], 'jsearch')

      expect((staleArchive as Record<string, unknown>).status).toBe('open')
      expect((staleArchive as Record<string, unknown>).$where).toEqual({
        status: 'closed',
        closedReason: 'board-poll-miss',
        updatedAt: staleArchive.updatedAt,
      })
      expect(staleArchive.save).toHaveBeenCalledWith({ w: 1 })
      expect(mockFindById).toHaveBeenCalledWith('p1')
      expect(restricted.status).toBe('closed')
      expect((restricted as Record<string, unknown>).closedReason).toBe(restrictedReason)
      expect((restricted as Record<string, unknown>).$where).toEqual({
        status: 'closed',
        closedReason: restrictedReason,
        updatedAt: restricted.updatedAt,
      })
      expect(restricted.save).toHaveBeenCalledOnce()
      expect(restricted.save).toHaveBeenCalledWith({ w: 1 })
      expect(counters).toMatchObject({ refreshed: 1, storeErrors: 0 })
    },
  )

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

  it('persists date-only validThrough at end-of-day and keeps provider extensions', async () => {
    reset()
    await ingestBatch([job({ validThrough: '2999-07-21' })], 'jsearch')
    expect(mockCreate.mock.calls[0][0].validThrough).toEqual(
      new Date('2999-07-21T23:59:59.999Z'),
    )

    reset()
    const existing = docStub({
      validThrough: new Date('2999-07-21T23:59:59.999Z'),
      provenance: [{
        sourceId: 'jsearch', externalId: 'ext-1', sourceKey: 'jsearch:ext-1',
        lastSeenAt: new Date('2026-07-01'),
      }],
      jdLength: 99_999,
    })
    mockFindOne.mockResolvedValueOnce(existing)
    await ingestBatch([job({ validThrough: '2999-07-31' })], 'jsearch')
    expect(existing.validThrough).toEqual(new Date('2999-07-31T23:59:59.999Z'))
  })

  it('refreshes canonical lastSeenAt even when a provider row has no externalId', async () => {
    reset()
    const previous = new Date('2026-06-01T00:00:00.000Z')
    const existing = docStub({ lastSeenAt: previous, jdLength: 99_999 })
    mockFindOne.mockResolvedValueOnce(existing) // fingerprint hit; no sourceKey tier

    await ingestBatch([job({ externalId: null })], 'jsearch')

    expect(existing.lastSeenAt).toBeInstanceOf(Date)
    expect((existing.lastSeenAt as Date).getTime()).toBeGreaterThan(previous.getTime())
    expect(existing.save).toHaveBeenCalledOnce()
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
    expect(entry.applyUrlFirstSeenAt).toBeInstanceOf(Date)
    expect(entry.linkGovernance).toMatchObject({ reportCount: 0, incidentVersion: 1 })
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

  it('a canonically equivalent URL refresh preserves generation, governance, and liveness evidence', async () => {
    reset()
    const firstSeen = new Date('2026-07-01T00:00:00Z')
    const crowdAt = new Date('2026-07-10T00:00:00Z')
    const entry = governedEntry({
      sourceId: 'jsearch', externalId: 'ext-1', sourceKey: 'jsearch:ext-1',
      applyUrl: 'https://careers.acme.com/1', applyUrlFirstSeenAt: firstSeen,
      applyTier: 'employer', firstSeenAt: firstSeen, lastSeenAt: firstSeen,
    }, {
      reportWindowStartedAt: crowdAt,
      reportCount: 3,
      lastReportedAt: crowdAt,
      crowdDemotedAt: crowdAt,
    })
    const governance = entry.linkGovernance
    const applyCheck = { status: 'dead', deadStreak: 1, lastCheckedAt: crowdAt, lastDeadAt: crowdAt }
    const existing = docStub({ provenance: [entry], applyCheck, jdLength: 99_999 })
    mockFindOne.mockResolvedValueOnce(existing)

    await ingestBatch([job({
      applyOptions: [{ url: 'HTTPS://CAREERS.ACME.COM/1#apply' }],
    })], 'jsearch')

    expect(existing.provenance[0].applyUrl).toBe('https://careers.acme.com/1')
    expect(existing.provenance[0].applyUrlFirstSeenAt).toEqual(firstSeen)
    expect(existing.provenance[0].linkGovernance).toBe(governance)
    expect(existing.applyCheck).toBe(applyCheck)
  })

  it('A→B→A replacements in one batch mint monotonically distinct generations and drop stale governance', async () => {
    reset()
    const firstSeen = new Date('2026-07-01T00:00:00Z')
    const crowdAt = new Date('2026-07-10T00:00:00Z')
    const original = governedEntry({
      sourceId: 'jsearch', externalId: 'ext-1', sourceKey: 'jsearch:ext-1',
      applyUrl: 'https://careers.acme.com/1', applyUrlFirstSeenAt: firstSeen,
      applyTier: 'employer', firstSeenAt: firstSeen, lastSeenAt: firstSeen,
    }, {
      reportWindowStartedAt: crowdAt,
      reportCount: 3,
      lastReportedAt: crowdAt,
      crowdDemotedAt: crowdAt,
    })
    const originalGeneration = (original.linkGovernance as Record<string, unknown>).generation
    const existing = docStub({
      provenance: [original],
      applyCheck: { status: 'dead', deadStreak: 1, lastCheckedAt: crowdAt, lastDeadAt: crowdAt },
      jdLength: 99_999,
    })
    mockFindOne.mockResolvedValue(existing)

    await ingestBatch([
      job({ applyOptions: [{ url: 'https://careers.acme.com/2' }] }),
      job({ applyOptions: [{ url: 'https://careers.acme.com/1' }] }),
    ], 'jsearch')

    const current = existing.provenance[0] as Record<string, unknown>
    expect(current.applyUrl).toBe('https://careers.acme.com/1')
    expect((current.applyUrlFirstSeenAt as Date).getTime()).toBeGreaterThan(firstSeen.getTime())
    expect((current.linkGovernance as Record<string, unknown>).generation).not.toBe(originalGeneration)
    expect(current.linkGovernance).toMatchObject({ reportCount: 0, incidentVersion: 1 })
    expect(existing.applyCheck).toBeUndefined()
    expect(existing.save).toHaveBeenCalledTimes(2)
  })

  it('a duplicate provider for the same canonical URL inherits governance without resetting applyCheck', async () => {
    reset()
    const firstSeen = new Date('2026-07-01T00:00:00Z')
    const crowdAt = new Date('2026-07-10T00:00:00Z')
    const original = governedEntry({
      sourceId: 'jsearch', externalId: 'ext-1', sourceKey: 'jsearch:ext-1',
      applyUrl: 'https://careers.acme.com/1', applyUrlFirstSeenAt: firstSeen,
      applyTier: 'employer', firstSeenAt: firstSeen, lastSeenAt: firstSeen,
    }, {
      reportWindowStartedAt: crowdAt,
      reportCount: 3,
      lastReportedAt: crowdAt,
      crowdDemotedAt: crowdAt,
    })
    const applyCheck = { status: 'alive', deadStreak: 0, lastCheckedAt: crowdAt }
    const existing = docStub({ provenance: [original], applyCheck, jdLength: 99_999 })
    mockFindOne
      .mockResolvedValueOnce(null) // new provider sourceKey
      .mockResolvedValueOnce(existing) // same canonical fingerprint

    await ingestBatch([job({
      externalId: 'ext-2',
      applyOptions: [{ url: 'https://careers.acme.com/1#apply' }],
    })], 'greenhouse')

    expect(existing.provenance).toHaveLength(2)
    expect(existing.provenance[0].linkGovernance).toEqual(existing.provenance[1].linkGovernance)
    expect(existing.provenance[1].linkGovernance).toMatchObject({
      reportCount: 3,
      crowdDemotedAt: crowdAt,
    })
    expect(existing.applyCheck).toBe(applyCheck)
  })

  it('a legacy ungoverned same-URL provider retains the legacy generation without reopening', async () => {
    reset()
    const firstSeen = new Date('2026-07-01T00:00:00Z')
    const closedAt = new Date('2026-07-15T00:00:00Z')
    const legacy = {
      sourceId: 'jsearch', externalId: 'ext-1', sourceKey: 'jsearch:ext-1',
      applyUrl: 'https://careers.acme.com/1', applyTier: 'employer',
      firstSeenAt: firstSeen, lastSeenAt: firstSeen,
    }
    const legacyGeneration = groupApplyLinkSubjects([legacy])[0].generation
    const applyCheck = {
      status: 'dead', deadStreak: 2, lastCheckedAt: closedAt, lastDeadAt: closedAt,
    }
    const existing = docStub({
      status: 'closed',
      closedReason: 'dead-apply-link',
      closedAt,
      provenance: [legacy],
      applyCheck,
      jdLength: 99_999,
    })
    mockFindOne
      .mockResolvedValueOnce(null) // new provider sourceKey
      .mockResolvedValueOnce(existing) // same canonical fingerprint

    await ingestBatch([job({
      externalId: 'ext-2',
      applyOptions: [{ url: 'https://careers.acme.com/1#apply' }],
    })], 'greenhouse')

    const group = groupApplyLinkSubjects(existing.provenance)
    expect(group).toHaveLength(1)
    expect(group[0].generation).toBe(legacyGeneration)
    expect(existing.provenance).toHaveLength(2)
    expect(existing.provenance[0].linkGovernance).toEqual(existing.provenance[1].linkGovernance)
    expect(existing.provenance[0].linkGovernance).toMatchObject({
      generation: legacyGeneration,
      reportCount: 0,
      incidentVersion: 1,
    })
    expect(existing.status).toBe('closed')
    expect(existing.closedReason).toBe('dead-apply-link')
    expect(existing.applyCheck).toBe(applyCheck)
  })

  it('URL replacement resets only the superseded subject while preserving an unrelated link incident', async () => {
    reset()
    const firstSeen = new Date('2026-07-01T00:00:00Z')
    const crowdAt = new Date('2026-07-10T00:00:00Z')
    const replaced = governedEntry({
      sourceId: 'jsearch', externalId: 'ext-1', sourceKey: 'jsearch:ext-1',
      applyUrl: 'https://old.example/1', applyUrlFirstSeenAt: firstSeen,
      applyTier: 'employer', firstSeenAt: firstSeen, lastSeenAt: firstSeen,
    }, { reportWindowStartedAt: crowdAt, reportCount: 3, crowdDemotedAt: crowdAt })
    const retained = governedEntry({
      sourceId: 'greenhouse', externalId: 'ext-2', sourceKey: 'greenhouse:ext-2',
      applyUrl: 'https://retained.example/2', applyUrlFirstSeenAt: firstSeen,
      applyTier: 'direct-ats', firstSeenAt: firstSeen, lastSeenAt: firstSeen,
    }, { reportWindowStartedAt: crowdAt, reportCount: 3, crowdDemotedAt: crowdAt })
    const retainedGeneration = (retained.linkGovernance as Record<string, unknown>).generation
    const existing = docStub({ provenance: [replaced, retained], jdLength: 99_999 })
    mockFindOne.mockResolvedValueOnce(existing)

    await ingestBatch([job({ applyOptions: [{ url: 'https://new.example/1' }] })], 'jsearch')

    const changed = existing.provenance.find((entry) => entry.sourceKey === 'jsearch:ext-1')!
    const untouched = existing.provenance.find((entry) => entry.sourceKey === 'greenhouse:ext-2')!
    expect(changed.linkGovernance).toMatchObject({ reportCount: 0, incidentVersion: 1 })
    expect(untouched.linkGovernance).toMatchObject({
      generation: retainedGeneration,
      reportCount: 3,
      crowdDemotedAt: crowdAt,
    })
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

describe('OPEN-row URL replacement clears stale strikes (Codex #543 r5)', () => {
  it('a strike-1 earned by the OLD url never combines with the NEW url into a close', async () => {
    reset()
    const j = job()
    const openStruck = docStub({
      status: 'open',
      provenance: [{ sourceId: 'jsearch', externalId: 'ext-1', sourceKey: 'jsearch:ext-1', applyUrl: 'https://old-dead.example/x', applyTier: 'employer', lastSeenAt: new Date('2026-07-01') }],
      jdLength: 99999,
      applyCheck: { status: 'dead', deadStreak: 1, lastCheckedAt: new Date('2026-07-15'), lastDeadAt: new Date('2026-07-15') },
    })
    mockFindOne.mockResolvedValueOnce(openStruck)
    await ingestBatch([j], 'jsearch')
    expect((openStruck as Record<string, unknown>).applyCheck).toBeUndefined()
    expect((openStruck as Record<string, unknown>).status).toBe('open')
  })
})

describe('dead-apply-link reopen on URL replacement (Codex #543)', () => {
  it('a source shipping a REPLACED apply URL reopens the closure and resets applyCheck; same-URL refreshes stay closed', async () => {
    reset()
    const j = job()
    const closedSameUrl = docStub({
      status: 'closed', closedReason: 'dead-apply-link', closedAt: new Date('2026-07-15'),
      provenance: [{ sourceId: 'jsearch', externalId: 'ext-1', sourceKey: 'jsearch:ext-1', applyUrl: j.applyOptions[0].url, applyTier: 'direct-ats', lastSeenAt: new Date('2026-07-01') }],
      jdLength: 99999,
      applyCheck: { status: 'dead', deadStreak: 2, lastCheckedAt: new Date('2026-07-15'), lastDeadAt: new Date('2026-07-15') },
    })
    mockFindOne.mockResolvedValueOnce(closedSameUrl)
    await ingestBatch([j], 'jsearch')
    // Same dead URL re-served → spam re-uploads must NOT resurrect.
    expect((closedSameUrl as Record<string, unknown>).status).toBe('closed')

    const closedNewUrl = docStub({
      status: 'closed', closedReason: 'dead-apply-link', closedAt: new Date('2026-07-15'),
      provenance: [{ sourceId: 'jsearch', externalId: 'ext-1', sourceKey: 'jsearch:ext-1', applyUrl: 'https://old-dead.example/x', applyTier: 'employer', lastSeenAt: new Date('2026-07-01') }],
      jdLength: 99999,
      applyCheck: { status: 'dead', deadStreak: 2, lastCheckedAt: new Date('2026-07-15'), lastDeadAt: new Date('2026-07-15') },
    })
    mockFindOne.mockResolvedValueOnce(closedNewUrl)
    await ingestBatch([j], 'jsearch')
    const rec = closedNewUrl as Record<string, unknown>
    // Fresh liveness evidence → back to the open pool, sweep re-verifies.
    expect(rec.status).toBe('open')
    expect(rec.closedReason).toBeUndefined()
    expect(rec.applyCheck).toBeUndefined()
  })

  it('a new provider with a genuinely new URL reopens a dead-link closure', async () => {
    reset()
    const closedAt = new Date('2026-07-15T00:00:00Z')
    const oldUrl = 'https://old-dead.example/x'
    const newUrl = 'https://careers.acme.com/1'
    const closed = docStub({
      status: 'closed',
      closedReason: 'dead-apply-link',
      closedAt,
      purgeAt: new Date('2026-07-22T00:00:00Z'),
      provenance: [{
        sourceId: 'jsearch', externalId: 'ext-1', sourceKey: 'jsearch:ext-1',
        applyUrl: oldUrl, applyTier: 'employer',
        firstSeenAt: new Date('2026-07-01'), lastSeenAt: new Date('2026-07-01'),
      }],
      applyCheck: {
        status: 'dead', deadStreak: 2, lastCheckedAt: closedAt, lastDeadAt: closedAt,
      },
      jdLength: 99_999,
    })
    mockFindOne
      .mockResolvedValueOnce(null) // new provider sourceKey
      .mockResolvedValueOnce(closed) // same canonical fingerprint

    await ingestBatch([job({
      externalId: 'ext-2',
      applyOptions: [{ url: newUrl }],
    })], 'greenhouse')

    expect(groupApplyLinkSubjects(closed.provenance).map((group) => group.canonicalUrl))
      .toEqual(expect.arrayContaining([oldUrl, newUrl]))
    expect(closed.status).toBe('open')
    expect(closed.closedReason).toBeUndefined()
    expect(closed.closedAt).toBeUndefined()
    expect(closed.purgeAt).toBeUndefined()
    expect(closed.applyCheck).toBeUndefined()
  })

  it('a removal-only link-set change stays closed and preserves recovery evidence', async () => {
    reset()
    const closedAt = new Date('2026-07-15T00:00:00Z')
    const applyCheck = {
      status: 'dead', deadStreak: 2, lastCheckedAt: closedAt, lastDeadAt: closedAt,
    }
    const provenance = [
      {
        sourceId: 'jsearch', externalId: 'old-link', sourceKey: 'jsearch:old-link',
        applyUrl: 'https://old-dead.example/x', applyTier: 'employer',
        firstSeenAt: new Date('2026-06-01'), lastSeenAt: new Date('2026-06-01'),
      },
      ...Array.from({ length: 7 }, (_, index) => ({
        sourceId: `source-${index}`,
        externalId: `ext-${index}`,
        sourceKey: `source-${index}:ext-${index}`,
        firstSeenAt: new Date('2026-07-01'),
        lastSeenAt: new Date('2026-07-01'),
      })),
    ]
    const closed = docStub({
      status: 'closed',
      closedReason: 'dead-apply-link',
      closedAt,
      purgeAt: new Date('2026-07-22T00:00:00Z'),
      provenance,
      applyCheck,
      jdLength: 99_999,
    })
    mockFindOne
      .mockResolvedValueOnce(null) // new sourceKey
      .mockResolvedValueOnce(closed) // same canonical fingerprint

    // The cap-8 append evicts the stale URL-bearing jsearch row and adds no
    // replacement URL, so the subject:generation set changed only by removal.
    await ingestBatch([job({ externalId: 'ext-2', applyOptions: [] })], 'jsearch')

    expect(groupApplyLinkSubjects(closed.provenance)).toHaveLength(0)
    expect(closed.status).toBe('closed')
    expect(closed.closedReason).toBe('dead-apply-link')
    expect(closed.closedAt).toEqual(closedAt)
    expect(closed.purgeAt).toEqual(new Date('2026-07-22T00:00:00Z'))
    expect(closed.applyCheck).toBe(applyCheck)
  })

  it('a removal-only link-set change clears an open row for a fresh aggregate check', async () => {
    reset()
    const applyCheck = {
      status: 'alive', deadStreak: 0, lastCheckedAt: new Date('2026-07-15T00:00:00Z'),
    }
    const provenance = [
      {
        sourceId: 'jsearch', externalId: 'old-link', sourceKey: 'jsearch:old-link',
        applyUrl: 'https://old-alive.example/x', applyTier: 'employer',
        firstSeenAt: new Date('2026-06-01'), lastSeenAt: new Date('2026-06-01'),
      },
      {
        sourceId: 'jsearch', externalId: 'retained', sourceKey: 'jsearch:retained',
        firstSeenAt: new Date('2026-07-01'), lastSeenAt: new Date('2026-07-01'),
      },
      ...Array.from({ length: 6 }, (_, index) => ({
        sourceId: `source-${index}`,
        externalId: `ext-${index}`,
        sourceKey: `source-${index}:ext-${index}`,
        firstSeenAt: new Date('2026-07-01'),
        lastSeenAt: new Date('2026-07-01'),
      })),
    ]
    const open = docStub({ provenance, applyCheck, jdLength: 99_999 })
    mockFindOne
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce(open)

    await ingestBatch([job({ externalId: 'ext-new', applyOptions: [] })], 'greenhouse')

    expect(groupApplyLinkSubjects(open.provenance)).toHaveLength(0)
    expect(open.status).toBe('open')
    expect(open.applyCheck).toBeUndefined()
  })
})
