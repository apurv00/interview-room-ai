import { describe, it, expect, vi } from 'vitest'

const {
  mockSend, mockSourceFindOne, mockSourceFind, mockSourceUpdateOne,
  mockCursorFind, mockCursorBulkWrite, mockCycleCreate, mockAdapterFetch,
} = vi.hoisted(() => ({
  mockSend: vi.fn(),
  mockSourceFindOne: vi.fn(),
  mockSourceFind: vi.fn(),
  mockSourceUpdateOne: vi.fn(),
  mockCursorFind: vi.fn(),
  mockCursorBulkWrite: vi.fn(),
  mockCycleCreate: vi.fn(),
  mockAdapterFetch: vi.fn(),
}))

vi.mock('@shared/services/inngest', () => ({
  inngest: { send: mockSend, createFunction: vi.fn(() => ({})) },
}))
vi.mock('@shared/db/connection', () => ({ connectDB: vi.fn().mockResolvedValue(undefined) }))
vi.mock('@shared/redis', () => ({ redis: { sadd: vi.fn(), expire: vi.fn(), scard: vi.fn() } }))
vi.mock('@shared/logger', () => ({ logger: { warn: vi.fn() } }))
vi.mock('@shared/db/models', () => ({
  JobPosting: { findOne: vi.fn().mockResolvedValue(null), find: vi.fn(() => ({ limit: () => Promise.resolve([]) })), create: vi.fn().mockResolvedValue({}), updateMany: vi.fn().mockResolvedValue({}) },
  JobSourceConfig: { findOne: mockSourceFindOne, find: mockSourceFind, updateOne: mockSourceUpdateOne },
  JobIngestCursor: { find: mockCursorFind, bulkWrite: mockCursorBulkWrite },
  JobIngestCycle: { create: mockCycleCreate },
  // §4.5 switch read once per sync — OFF keeps these tests byte-identical.
  JobsVerdictConfig: { getConfig: vi.fn().mockResolvedValue({ collectionEnabled: false, enforceEnabled: false }) },
}))
vi.mock('../adapters/jsearchAdapter', async (importOriginal) => {
  const real = await importOriginal<typeof import('../adapters/jsearchAdapter')>()
  return { jsearchAdapter: { ...real.jsearchAdapter, fetch: mockAdapterFetch } }
})
vi.mock('../adapters/atsBoardAdapter', async (importOriginal) => {
  const real = await importOriginal<typeof import('../adapters/atsBoardAdapter')>()
  return { atsBoardAdapter: { ...real.atsBoardAdapter, fetch: mockAdapterFetch } }
})

import { runIngestSchedulerHandler, runSourceSyncHandler, runBoardProbeHandler } from '../jobs/ingestJobs'

const step = { run: <T,>(_n: string, fn: () => Promise<T> | T) => Promise.resolve(fn()) }

function resetAll(): void {
  for (const m of [mockSend, mockSourceFindOne, mockSourceFind, mockSourceUpdateOne, mockCursorFind, mockCursorBulkWrite, mockCycleCreate, mockAdapterFetch]) m.mockReset()
  mockSourceFindOne.mockReturnValue({ lean: () => Promise.resolve(null) })
  mockSourceUpdateOne.mockResolvedValue({})
  mockCursorBulkWrite.mockResolvedValue({})
  mockCycleCreate.mockResolvedValue({})
}

describe('runIngestSchedulerHandler', () => {
  it('no enabled sources → zero dispatches (data is the only switch — no flags)', async () => {
    resetAll()
    mockSourceFind.mockReturnValue({ lean: () => Promise.resolve([]) })
    const r = await runIngestSchedulerHandler(step)
    expect(r).toEqual({ dispatched: 0 })
    expect(mockSend).not.toHaveBeenCalled()
  })

  it('seeds jsearch DISABLED and dispatches only due enabled sources', async () => {
    resetAll()
    const now = Date.now()
    mockSourceFind.mockReturnValue({
      lean: () => Promise.resolve([
        { sourceId: 'due-source', enabled: true, health: 'active', cadenceMinutes: 60, lastSyncAt: new Date(now - 2 * 3600_000) },
        { sourceId: 'not-due', enabled: true, health: 'active', cadenceMinutes: 1440, lastSyncAt: new Date(now - 3600_000) },
      ]),
    })
    const r = await runIngestSchedulerHandler(step)
    expect(r).toEqual({ dispatched: 1 })
    // seed uses $setOnInsert with enabled:false — the scheduler never
    // invents an active source
    const seed = mockSourceUpdateOne.mock.calls[0]
    expect(seed[1].$setOnInsert.enabled).toBe(false)
    // board seeds carry displayName on insert; a guarded second update
    // backfills ONLY absent values so ops edits are never stomped
    const boardSeed = mockSourceUpdateOne.mock.calls[1]
    expect(boardSeed[1].$setOnInsert.displayName).toBeTruthy()
    expect(boardSeed[1].$setOnInsert.enabled).toBe(false)
    const backfill = mockSourceUpdateOne.mock.calls[2]
    expect(backfill[0].displayName).toEqual({ $in: [null, ''] })
    expect(backfill[1].$set.displayName).toBeTruthy()
    expect(backfill[2]?.upsert).toBeUndefined()
    expect(mockSend).toHaveBeenCalledWith({ name: 'jobs/source.sync', data: { sourceId: 'due-source' } })
  })
})

describe('runSourceSyncHandler', () => {
  const EVENT = { data: { sourceId: 'jsearch' } }

  it('unknown adapter / disabled source / bad health all skip', async () => {
    resetAll()
    // enabled + healthy but no adapter resolves for this kind/id
    mockSourceFindOne.mockReturnValue({ lean: () => Promise.resolve({ sourceId: 'nope', enabled: true, health: 'active', kind: 'public-api' }) })
    expect(await runSourceSyncHandler({ data: { sourceId: 'nope' } }, step)).toMatchObject({ skipped: true, reason: 'no adapter for nope' })

    resetAll()
    mockSourceFindOne.mockReturnValue({ lean: () => Promise.resolve({ sourceId: 'jsearch', enabled: false, health: 'active' }) })
    expect(await runSourceSyncHandler(EVENT, step)).toMatchObject({ skipped: true, reason: 'source disabled' })

    resetAll()
    mockSourceFindOne.mockReturnValue({ lean: () => Promise.resolve({ sourceId: 'jsearch', enabled: true, health: 'quarantined' }) })
    expect(await runSourceSyncHandler(EVENT, step)).toMatchObject({ skipped: true, reason: 'health quarantined' })
  })

  it('runs chunks, writes cursors + cycle row, keeps health active on a clean run', async () => {
    resetAll()
    mockSourceFindOne.mockReturnValue({ lean: () => Promise.resolve({ sourceId: 'jsearch', enabled: true, health: 'active', cadenceMinutes: 1440 }) })
    mockCursorFind.mockReturnValue({ lean: () => Promise.resolve([]) })
    // Every bucket returns one fresh row (non-full page → no pagination).
    mockAdapterFetch.mockImplementation(async (t: { bucketId?: string }) => ({
      ok: true, status: 200, attempts: 1,
      raw: [{
        job_id: `id-${t.bucketId}`, job_title: 'Backend Developer', employer_name: `Acme ${t.bucketId}`,
        job_city: 'Pune', job_description: 'Build APIs. '.repeat(50),
        job_posted_at_datetime_utc: '2026-07-12T00:00:00Z', job_apply_link: 'https://careers.acme.com/1',
      }],
    }))
    const r = await runSourceSyncHandler(EVENT, step, { interRequestDelayMs: 0 })
    expect(r).toMatchObject({ cycleWritten: true })
    const cycle = mockCycleCreate.mock.calls[0][0]
    expect(cycle.kind).toBe('sync')
    expect(cycle.fetched).toBeGreaterThan(0)
    expect(cycle.quotaSpent).toBe(cycle.fetched) // 1 attempt per bucket, 1 row each
    expect(mockCursorBulkWrite).toHaveBeenCalled()
    // Monotonic cursors (Codex #511): newestPostedAt via $max, never $set.
    const op = mockCursorBulkWrite.mock.calls[0][0][0].updateOne
    expect(op.update.$max.newestPostedAt).toBeInstanceOf(Date)
    expect(op.update.$set.newestPostedAt).toBeUndefined()
    const health = mockSourceUpdateOne.mock.calls.at(-1)![1].$set.health
    expect(health).toBe('active')
  })

  it('a garbage postedAt never reaches the cursor write — finalize still succeeds', async () => {
    resetAll()
    mockSourceFindOne.mockReturnValue({ lean: () => Promise.resolve({ sourceId: 'jsearch', enabled: true, health: 'active', cadenceMinutes: 1440 }) })
    mockCursorFind.mockReturnValue({ lean: () => Promise.resolve([]) })
    mockAdapterFetch.mockResolvedValue({
      ok: true, status: 200, attempts: 1,
      raw: [{
        job_id: 'id-1', job_title: 'Backend Developer', employer_name: 'Acme',
        job_city: 'Pune', job_description: 'Build APIs. '.repeat(50),
        job_posted_at_datetime_utc: 'Posted 3 days ago', // non-parseable
        job_apply_link: 'https://careers.acme.com/1',
      }],
    })
    const r = await runSourceSyncHandler(EVENT, step, { interRequestDelayMs: 0 })
    expect(r).toMatchObject({ cycleWritten: true })
    // no parseable dates observed -> zero cursor ops, bulkWrite skipped
    expect(mockCursorBulkWrite).not.toHaveBeenCalled()
    expect(mockCycleCreate).toHaveBeenCalled() // finalize completed
  })

  it('a run with store failures never reads healthy — degraded + storeErrors persisted', async () => {
    resetAll()
    mockSourceFindOne.mockReturnValue({ lean: () => Promise.resolve({ sourceId: 'jsearch', enabled: true, health: 'active', cadenceMinutes: 1440 }) })
    mockCursorFind.mockReturnValue({ lean: () => Promise.resolve([]) })
    mockAdapterFetch.mockResolvedValue({
      ok: true, status: 200, attempts: 1,
      raw: [{ job_id: 'x', job_title: 'Backend Developer', employer_name: 'Acme', job_city: 'Pune', job_description: 'Build APIs. '.repeat(50), job_apply_link: 'https://careers.acme.com/1' }],
    })
    const { JobPosting } = await import('@shared/db/models')
    vi.mocked(JobPosting.create).mockRejectedValue(new Error('index regression'))
    const r = await runSourceSyncHandler(EVENT, step, { interRequestDelayMs: 0 })
    expect(r).toMatchObject({ cycleWritten: true })
    const health = mockSourceUpdateOne.mock.calls.at(-1)![1].$set.health
    expect(health).toBe('degraded')
    expect(mockSourceUpdateOne.mock.calls.at(-1)![1].$set.lastHealthyProbeAt).toBeUndefined()
    expect(mockCycleCreate.mock.calls[0][0].storeErrors).toBeGreaterThan(0)
    vi.mocked(JobPosting.create).mockResolvedValue({} as never)
  })

  it('total schema drift (>50%) QUARANTINES the source — §4.4 contract', async () => {
    resetAll()
    mockSourceFindOne.mockReturnValue({ lean: () => Promise.resolve({ sourceId: 'jsearch', enabled: true, health: 'active', cadenceMinutes: 1440 }) })
    mockCursorFind.mockReturnValue({ lean: () => Promise.resolve([]) })
    mockAdapterFetch.mockResolvedValue({ ok: true, status: 200, attempts: 1, raw: [{ shape: 'drifted' }] })
    const r = await runSourceSyncHandler(EVENT, step, { interRequestDelayMs: 0 })
    expect(r).toMatchObject({ cycleWritten: true })
    const health = mockSourceUpdateOne.mock.calls.at(-1)![1].$set.health
    expect(health).toBe('quarantined')
    expect(mockSourceUpdateOne.mock.calls.at(-1)![1].$set.lastHealthyProbeAt).toBeUndefined()
  })

  it('partial schema drift (20-50%) DEGRADES the source', async () => {
    resetAll()
    mockSourceFindOne.mockReturnValue({ lean: () => Promise.resolve({ sourceId: 'jsearch', enabled: true, health: 'active', cadenceMinutes: 1440 }) })
    mockCursorFind.mockReturnValue({ lean: () => Promise.resolve([]) })
    // 1 drifted row of 3 per bucket = ~33% drift: above degrade, below quarantine.
    mockAdapterFetch.mockResolvedValue({
      ok: true, status: 200, attempts: 1,
      raw: [
        { shape: 'drifted' },
        { job_id: 'a', job_title: 'Backend Developer', employer_name: 'Acme One', job_city: 'Pune', job_description: 'Build APIs. '.repeat(50), job_apply_link: 'https://careers.acme.com/1' },
        { job_id: 'b', job_title: 'Data Analyst', employer_name: 'Acme Two', job_city: 'Pune', job_description: 'Analyze data. '.repeat(50), job_apply_link: 'https://careers.acme.com/2' },
      ],
    })
    const r = await runSourceSyncHandler(EVENT, step, { interRequestDelayMs: 0 })
    expect(r).toMatchObject({ cycleWritten: true })
    const health = mockSourceUpdateOne.mock.calls.at(-1)![1].$set.health
    expect(health).toBe('degraded')
  })

  it('a 429 anywhere degrades the source; drift rows are counted', async () => {
    resetAll()
    mockSourceFindOne.mockReturnValue({ lean: () => Promise.resolve({ sourceId: 'jsearch', enabled: true, health: 'active', cadenceMinutes: 1440 }) })
    mockCursorFind.mockReturnValue({ lean: () => Promise.resolve([]) })
    let first = true
    mockAdapterFetch.mockImplementation(async () => {
      if (first) { first = false; return { ok: false, status: 429, attempts: 1, raw: [] } }
      // one drift row among valid ones — drift stays at exactly 50%
      // (NOT >50%), so the degrade must come from the 429, not quarantine
      return {
        ok: true, status: 200, attempts: 1,
        raw: [
          { not_a_job: true },
          { job_id: 'ok', job_title: 'Backend Developer', employer_name: 'Acme', job_city: 'Pune', job_description: 'Build APIs. '.repeat(50), job_apply_link: 'https://careers.acme.com/1' },
        ],
      }
    })
    const r = await runSourceSyncHandler(EVENT, step, { interRequestDelayMs: 0 })
    expect(r).toMatchObject({ cycleWritten: true })
    const cycle = mockCycleCreate.mock.calls[0][0]
    expect(cycle.driftNulls).toBeGreaterThan(0)
    const health = mockSourceUpdateOne.mock.calls.at(-1)![1].$set.health
    expect(health).toBe('degraded')
  })
})


describe('board sync uses per-config sourceId (Codex #513 P1)', () => {
  it('provenance sourceKeys carry gh:phonepe, never the adapter constant', async () => {
    resetAll()
    mockSourceFindOne.mockReturnValue({ lean: () => Promise.resolve({ sourceId: 'gh:phonepe', enabled: true, health: 'active', kind: 'ats-board', atsKind: 'greenhouse', slug: 'phonepe', cadenceMinutes: 360 }) })
    mockCursorFind.mockReturnValue({ lean: () => Promise.resolve([]) })
    mockAdapterFetch.mockResolvedValue({
      ok: true, status: 200, attempts: 1,
      raw: [{ kind: 'greenhouse', raw: { id: 123, title: 'Backend Engineer', location: { name: 'Pune, India' }, content: 'Build things. '.repeat(40), absolute_url: 'https://boards.greenhouse.io/phonepe/jobs/123' } }],
    })
    const { JobPosting } = await import('@shared/db/models')
    vi.mocked(JobPosting.create).mockClear()
    const r = await runSourceSyncHandler({ data: { sourceId: 'gh:phonepe' } }, step, { interRequestDelayMs: 0 })
    expect(r).toMatchObject({ cycleWritten: true })
    const doc = vi.mocked(JobPosting.create).mock.calls[0][0] as { provenance: Array<{ sourceKey: string; sourceId: string }> }
    expect(doc.provenance[0].sourceKey).toBe('gh:phonepe:123')
    expect(doc.provenance[0].sourceId).toBe('gh:phonepe')
  })
})

function docStub(overrides: Record<string, unknown> = {}) {
  return {
    status: 'open',
    closedReason: undefined as string | undefined,
    provenance: [] as Array<Record<string, unknown>>,
    locationKeys: [] as string[],
    locations: [] as string[],
    jdLength: 0,
    boardPollMisses: 0,
    save: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  }
}

describe('board delisting closure (§4.3 board-poll-miss; Codex #513 P2)', () => {
  it('second consecutive miss closes a board-only posting; other-source rows untouched', async () => {
    resetAll()
    mockSourceFindOne.mockReturnValue({ lean: () => Promise.resolve({ sourceId: 'gh:phonepe', enabled: true, health: 'active', kind: 'ats-board', atsKind: 'greenhouse', slug: 'phonepe', cadenceMinutes: 360 }) })
    mockCursorFind.mockReturnValue({ lean: () => Promise.resolve([]) })
    mockAdapterFetch.mockResolvedValue({ ok: true, status: 200, attempts: 1, raw: [] }) // clean sync, lists nothing
    const staleSolo = docStub({ boardPollMisses: 1, provenance: [{ sourceId: 'gh:phonepe', externalId: 'gone', sourceKey: 'gh:phonepe:gone', lastSeenAt: new Date() }] })
    const staleShared = docStub({ boardPollMisses: 1, provenance: [
      { sourceId: 'gh:phonepe', externalId: 'x', sourceKey: 'gh:phonepe:x', lastSeenAt: new Date() },
      { sourceId: 'jsearch', externalId: 'y', sourceKey: 'jsearch:y', lastSeenAt: new Date() },
    ] })
    const { JobPosting } = await import('@shared/db/models')
    vi.mocked(JobPosting.find).mockReturnValueOnce({ limit: () => Promise.resolve([staleSolo, staleShared]) } as never)
    const r = await runSourceSyncHandler({ data: { sourceId: 'gh:phonepe' } }, step, { interRequestDelayMs: 0 })
    expect(r).toMatchObject({ cycleWritten: true })
    expect(staleSolo.status).toBe('closed')
    expect(staleSolo.closedReason).toBe('board-poll-miss')
    expect(staleSolo.save).toHaveBeenCalled()
    expect(staleShared.status).toBe('open') // another source still lists it
    expect(staleShared.save).not.toHaveBeenCalled()
  })

  it('first miss only increments; a failed fetch is NOT a miss', async () => {
    resetAll()
    mockSourceFindOne.mockReturnValue({ lean: () => Promise.resolve({ sourceId: 'gh:phonepe', enabled: true, health: 'active', kind: 'ats-board', atsKind: 'greenhouse', slug: 'phonepe', cadenceMinutes: 360 }) })
    mockCursorFind.mockReturnValue({ lean: () => Promise.resolve([]) })
    const stale = docStub({ boardPollMisses: 0, provenance: [{ sourceId: 'gh:phonepe', externalId: 'gone', sourceKey: 'gh:phonepe:gone', lastSeenAt: new Date() }] })
    const { JobPosting } = await import('@shared/db/models')
    vi.mocked(JobPosting.find).mockReturnValueOnce({ limit: () => Promise.resolve([stale]) } as never)
    mockAdapterFetch.mockResolvedValue({ ok: true, status: 200, attempts: 1, raw: [] })
    await runSourceSyncHandler({ data: { sourceId: 'gh:phonepe' } }, step, { interRequestDelayMs: 0 })
    expect(stale.boardPollMisses).toBe(1)
    expect(stale.status).toBe('open')

    // drifted run: incomplete seen-set — the sweep must not run either
    resetAll()
    mockSourceFindOne.mockReturnValue({ lean: () => Promise.resolve({ sourceId: 'gh:phonepe', enabled: true, health: 'active', kind: 'ats-board', atsKind: 'greenhouse', slug: 'phonepe', cadenceMinutes: 360 }) })
    mockCursorFind.mockReturnValue({ lean: () => Promise.resolve([]) })
    mockAdapterFetch.mockResolvedValue({ ok: true, status: 200, attempts: 1, raw: [{ kind: 'greenhouse', raw: { shape: 'drifted' } }] })
    const { JobPosting: JP } = await import('@shared/db/models')
    vi.mocked(JP.find).mockClear()
    await runSourceSyncHandler({ data: { sourceId: 'gh:phonepe' } }, step, { interRequestDelayMs: 0 })
    // fuzzy-tier find never fires (row dropped as drift) and the stale
    // sweep must not fire on a drifted run
    expect(vi.mocked(JP.find)).not.toHaveBeenCalled()

    // failed fetch: the sweep must not run at all
    resetAll()
    mockSourceFindOne.mockReturnValue({ lean: () => Promise.resolve({ sourceId: 'gh:phonepe', enabled: true, health: 'active', kind: 'ats-board', atsKind: 'greenhouse', slug: 'phonepe', cadenceMinutes: 360 }) })
    mockCursorFind.mockReturnValue({ lean: () => Promise.resolve([]) })
    mockAdapterFetch.mockResolvedValue({ ok: false, status: 503, attempts: 1, raw: [] })
    vi.mocked(JobPosting.find).mockClear()
    await runSourceSyncHandler({ data: { sourceId: 'gh:phonepe' } }, step, { interRequestDelayMs: 0 })
    expect(vi.mocked(JobPosting.find)).not.toHaveBeenCalled()
  })
})

describe('runBoardProbeHandler (weekly liveness, §4.4)', () => {
  function boardRow(overrides: Record<string, unknown> = {}) {
    return {
      sourceId: 'gh:phonepe', kind: 'ats-board', atsKind: 'greenhouse', slug: 'phonepe',
      enabled: true, health: 'active', minIndiaPostings: 10, emptyStreak: 0, healthyProbeStreak: 0,
      ...overrides,
    }
  }

  it('the probe never loads revoked boards — a legal block cannot be probe-cleared (Codex #513 P2)', async () => {
    resetAll()
    mockSourceFind.mockReturnValue({ lean: () => Promise.resolve([]) })
    await runBoardProbeHandler(step)
    const filter = mockSourceFind.mock.calls[0][0]
    expect(filter.health).toEqual({ $in: ['active', 'degraded', 'quarantined'] })
  })

  it('404 quarantines a dead board immediately', async () => {
    resetAll()
    mockSourceFind.mockReturnValue({ lean: () => Promise.resolve([boardRow()]) })
    mockAdapterFetch.mockResolvedValue({ ok: false, status: 404, attempts: 1, raw: [] })
    await runBoardProbeHandler(step)
    const update = mockSourceUpdateOne.mock.calls.at(-1)![1].$set
    expect(update.health).toBe('quarantined')
  })

  it('sub-minIndiaPostings yield 3 weeks running quarantines (emptyStreak)', async () => {
    resetAll()
    mockSourceFind.mockReturnValue({ lean: () => Promise.resolve([boardRow({ emptyStreak: 2 })]) })
    mockAdapterFetch.mockResolvedValue({ ok: true, status: 200, attempts: 1, raw: [{ kind: 'greenhouse', raw: {} }] }) // 1 < 10
    await runBoardProbeHandler(step)
    const update = mockSourceUpdateOne.mock.calls.at(-1)![1].$set
    expect(update.emptyStreak).toBe(3)
    expect(update.health).toBe('quarantined')
  })

  it('an under-supply probe RESETS the recovery streak — consecutive means consecutive', async () => {
    resetAll()
    mockSourceFind.mockReturnValue({ lean: () => Promise.resolve([boardRow({ health: 'quarantined', healthyProbeStreak: 1, emptyStreak: 0 })]) })
    mockAdapterFetch.mockResolvedValue({ ok: true, status: 200, attempts: 1, raw: [{ kind: 'greenhouse', raw: {} }] }) // 1 < 10 = under
    await runBoardProbeHandler(step)
    const update = mockSourceUpdateOne.mock.calls.at(-1)![1].$set
    expect(update.healthyProbeStreak).toBe(0)
    expect(update.emptyStreak).toBe(1)
    expect(update.health).toBeUndefined() // not yet 3 weeks under
  })

  it('a quarantined board needs TWO healthy probes to recover', async () => {
    resetAll()
    const healthyRaw = Array.from({ length: 12 }, (_, i) => ({ kind: 'greenhouse', raw: { id: i, title: 'SDE', location: { name: 'Pune, India' }, content: 'x', absolute_url: `https://boards.greenhouse.io/phonepe/jobs/${i}` } }))
    mockSourceFind.mockReturnValue({ lean: () => Promise.resolve([boardRow({ health: 'quarantined', healthyProbeStreak: 0 })]) })
    mockAdapterFetch.mockResolvedValue({ ok: true, status: 200, attempts: 1, raw: healthyRaw })
    await runBoardProbeHandler(step)
    expect(mockSourceUpdateOne.mock.calls.at(-1)![1].$set.healthyProbeStreak).toBe(1)

    resetAll()
    mockSourceFind.mockReturnValue({ lean: () => Promise.resolve([boardRow({ health: 'quarantined', healthyProbeStreak: 1 })]) })
    mockAdapterFetch.mockResolvedValue({ ok: true, status: 200, attempts: 1, raw: healthyRaw })
    await runBoardProbeHandler(step)
    const update = mockSourceUpdateOne.mock.calls.at(-1)![1].$set
    expect(update.health).toBe('active')
    expect(update.healthyProbeStreak).toBe(0)
  })

  it('drift-broken rows are NOT supply — a shape-broken board cannot probe-recover (Codex #513 round-4)', async () => {
    resetAll()
    const driftedRaw = Array.from({ length: 12 }, () => ({ kind: 'greenhouse', raw: { shape: 'drifted' } })) // 12 raw, 0 normalize
    mockSourceFind.mockReturnValue({ lean: () => Promise.resolve([boardRow({ health: 'quarantined', healthyProbeStreak: 1 })]) })
    mockAdapterFetch.mockResolvedValue({ ok: true, status: 200, attempts: 1, raw: driftedRaw })
    await runBoardProbeHandler(step)
    const update = mockSourceUpdateOne.mock.calls.at(-1)![1].$set
    expect(update.health).toBeUndefined() // stays quarantined
    expect(update.healthyProbeStreak).toBe(0) // under-supply resets the streak
    expect(update.emptyStreak).toBe(1)
  })
})
