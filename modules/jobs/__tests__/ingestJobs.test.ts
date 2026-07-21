import { describe, it, expect, vi } from 'vitest'

const {
  mockSend, mockSourceFindOne, mockSourceFind, mockSourceUpdateOne,
  mockCursorFind, mockCursorBulkWrite, mockCycleCreate, mockAdapterFetch,
  mockPostingFindOne, mockPostingFind, mockPostingCreate, mockPostingUpdateMany,
  mockPostingUpdateOne, mockPostingBulkWrite, mockAssertSourceSyncAuthority, mockAssertSourceTransactionsReady,
  mockAssertSourceProbeAuthority, mockWithSourceWriteFence,
} = vi.hoisted(() => ({
  mockSend: vi.fn(),
  mockSourceFindOne: vi.fn(),
  mockSourceFind: vi.fn(),
  mockSourceUpdateOne: vi.fn(),
  mockCursorFind: vi.fn(),
  mockCursorBulkWrite: vi.fn(),
  mockCycleCreate: vi.fn(),
  mockAdapterFetch: vi.fn(),
  mockPostingFindOne: vi.fn(),
  mockPostingFind: vi.fn(),
  mockPostingCreate: vi.fn(),
  mockPostingUpdateMany: vi.fn(),
  mockPostingUpdateOne: vi.fn(),
  mockPostingBulkWrite: vi.fn(),
  mockAssertSourceSyncAuthority: vi.fn(),
  mockAssertSourceTransactionsReady: vi.fn(),
  mockAssertSourceProbeAuthority: vi.fn(),
  mockWithSourceWriteFence: vi.fn(),
}))

vi.mock('@shared/services/inngest', () => ({
  inngest: { send: mockSend, createFunction: vi.fn(() => ({})) },
}))
vi.mock('@shared/db/connection', () => ({ connectDB: vi.fn().mockResolvedValue(undefined) }))
vi.mock('@shared/redis', () => ({ redis: { sadd: vi.fn(), expire: vi.fn(), scard: vi.fn() } }))
vi.mock('@shared/logger', () => ({ logger: { warn: vi.fn(), error: vi.fn() } }))
vi.mock('@shared/db/models', () => ({
  JobPosting: { findOne: mockPostingFindOne, find: mockPostingFind, create: mockPostingCreate, updateMany: mockPostingUpdateMany, updateOne: mockPostingUpdateOne, bulkWrite: mockPostingBulkWrite },
  JobSourceConfig: { findOne: mockSourceFindOne, find: mockSourceFind, updateOne: mockSourceUpdateOne },
  JobIngestCursor: { find: mockCursorFind, bulkWrite: mockCursorBulkWrite },
  JobIngestCycle: { create: mockCycleCreate },
  // §4.5 switch read once per sync — OFF keeps these tests byte-identical.
  JobsVerdictConfig: { getConfig: vi.fn().mockResolvedValue({ collectionEnabled: false, enforceEnabled: false }) },
}))
vi.mock('../services/sourceControl', () => {
  class SourceAuthorityChangedError extends Error {
    constructor(public readonly sourceId: string, public readonly expectedRevision: number) {
      super(`source authority changed: ${sourceId}@${expectedRevision}`)
      this.name = 'SourceAuthorityChangedError'
    }
  }
  class SourceTransactionsRequiredError extends Error {
    constructor() {
      super('job source control requires MongoDB replica-set transactions')
      this.name = 'SourceTransactionsRequiredError'
    }
  }
  return {
    SourceAuthorityChangedError,
    SourceTransactionsRequiredError,
    controlRevisionOf: (source: { controlRevision?: number | null }) =>
      Number.isInteger(source.controlRevision) && (source.controlRevision as number) >= 0
        ? source.controlRevision as number
        : 0,
    controlRevisionFilter: (revision: number) => revision === 0
      ? { $or: [{ controlRevision: 0 }, { controlRevision: { $exists: false } }] }
      : { controlRevision: revision },
    assertSourceSyncAuthority: (sourceId: string, revision: number) =>
      mockAssertSourceSyncAuthority(sourceId, revision),
    assertSourceTransactionsReady: (sourceId: string, revision: number) =>
      mockAssertSourceTransactionsReady(sourceId, revision),
    assertSourceProbeAuthority: (sourceId: string, revision: number) =>
      mockAssertSourceProbeAuthority(sourceId, revision),
    withSourceWriteFence: <T,>(sourceId: string, revision: number, work: (session: undefined) => Promise<T>) =>
      mockWithSourceWriteFence(sourceId, revision, work),
  }
})
vi.mock('../adapters/jsearchAdapter', async (importOriginal) => {
  const real = await importOriginal<typeof import('../adapters/jsearchAdapter')>()
  return { jsearchAdapter: { ...real.jsearchAdapter, fetch: mockAdapterFetch } }
})
vi.mock('../adapters/unstopAdapter', async (importOriginal) => {
  const real = await importOriginal<typeof import('../adapters/unstopAdapter')>()
  return { unstopAdapter: { ...real.unstopAdapter, fetch: mockAdapterFetch } }
})
vi.mock('../adapters/atsBoardAdapter', async (importOriginal) => {
  const real = await importOriginal<typeof import('../adapters/atsBoardAdapter')>()
  return { atsBoardAdapter: { ...real.atsBoardAdapter, fetch: mockAdapterFetch } }
})

import { runIngestSchedulerHandler, runSourceSyncHandler, runBoardProbeHandler } from '../jobs/ingestJobs'
import { jsearchAdapter } from '../adapters/jsearchAdapter'
import { JobPosting } from '@shared/db/models'
import { SourceAuthorityChangedError, SourceTransactionsRequiredError } from '../services/sourceControl'

const step = { run: <T,>(_n: string, fn: () => Promise<T> | T) => Promise.resolve(fn()) }

function resetAll(): void {
  for (const m of [
    mockSend, mockSourceFindOne, mockSourceFind, mockSourceUpdateOne,
    mockCursorFind, mockCursorBulkWrite, mockCycleCreate, mockAdapterFetch,
    mockPostingFindOne, mockPostingFind, mockPostingCreate,
    mockPostingUpdateMany, mockPostingUpdateOne, mockPostingBulkWrite,
    mockAssertSourceSyncAuthority, mockAssertSourceTransactionsReady, mockAssertSourceProbeAuthority,
    mockWithSourceWriteFence,
  ]) m.mockReset()
  mockSourceFindOne.mockReturnValue({ lean: () => Promise.resolve(null) })
  mockSourceUpdateOne.mockResolvedValue({})
  mockCursorBulkWrite.mockResolvedValue({})
  mockCycleCreate.mockResolvedValue({})
  mockPostingFindOne.mockResolvedValue(null)
  mockPostingFind.mockReturnValue({ limit: () => Promise.resolve([]) })
  mockPostingCreate.mockResolvedValue({})
  mockPostingUpdateMany.mockResolvedValue({})
  mockPostingUpdateOne.mockResolvedValue({ matchedCount: 1 })
  mockPostingBulkWrite.mockResolvedValue({ matchedCount: 1 })
  mockAssertSourceSyncAuthority.mockResolvedValue(undefined)
  mockAssertSourceTransactionsReady.mockResolvedValue(undefined)
  mockAssertSourceProbeAuthority.mockResolvedValue(undefined)
  mockWithSourceWriteFence.mockImplementation(
    (_sourceId: string, _revision: number, work: (session: undefined) => Promise<unknown>) => work(undefined)
  )
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
        { sourceId: 'due-source', enabled: true, health: 'active', controlRevision: 7, cadenceMinutes: 60, lastSyncAt: new Date(now - 2 * 3600_000) },
        { sourceId: 'not-due', enabled: true, health: 'active', cadenceMinutes: 1440, lastSyncAt: new Date(now - 3600_000) },
      ]),
    })
    const r = await runIngestSchedulerHandler(step)
    expect(r).toEqual({ dispatched: 1 })
    // seed uses $setOnInsert with enabled:false — the scheduler never
    // invents an active source
    const seed = mockSourceUpdateOne.mock.calls[0]
    expect(seed[1].$setOnInsert.enabled).toBe(false)
    expect(seed[1].$setOnInsert).toMatchObject({ controlRevision: 0, ingestWriteSeq: 0 })
    // India-native sources seed next (§6 items 5/6), also DISABLED — the
    // founder's ToS read gates their enable (DECISIONS #9).
    const apnaSeed = mockSourceUpdateOne.mock.calls[1]
    expect(apnaSeed[0]).toEqual({ sourceId: 'apna' })
    expect(apnaSeed[1].$setOnInsert).toMatchObject({ kind: 'sitemap-jsonld', enabled: false })
    const unstopSeed = mockSourceUpdateOne.mock.calls[2]
    expect(unstopSeed[0]).toEqual({ sourceId: 'unstop' })
    expect(unstopSeed[1].$setOnInsert).toMatchObject({ kind: 'public-api', enabled: false })
    // board seeds carry displayName on insert; a guarded second update
    // backfills ONLY absent values so ops edits are never stomped
    const boardSeed = mockSourceUpdateOne.mock.calls[3]
    expect(boardSeed[1].$setOnInsert.displayName).toBeTruthy()
    expect(boardSeed[1].$setOnInsert.enabled).toBe(false)
    const backfill = mockSourceUpdateOne.mock.calls[4]
    expect(backfill[0].displayName).toEqual({ $in: [null, ''] })
    expect(backfill[1].$set.displayName).toBeTruthy()
    expect(backfill[2]?.upsert).toBeUndefined()
    expect(mockSend).toHaveBeenCalledWith({ name: 'jobs/source.sync', data: { sourceId: 'due-source', controlRevision: 7 } })
  })
})

describe('runSourceSyncHandler — feed continuation', () => {
  it('persists a large provider page in bounded source-authority transactions', async () => {
    resetAll()
    mockSourceFindOne.mockReturnValue({ lean: () => Promise.resolve({ sourceId: 'unstop', enabled: true, health: 'active', kind: 'public-api', cadenceMinutes: 1440 }) })
    mockCursorFind.mockReturnValue({ lean: () => Promise.resolve([]) })
    const rows = Array.from({ length: 26 }, (_, index) => ({
      id: `u${index}`,
      title: `Backend Developer ${index}`,
      organisation: { name: `Acme ${index}` },
      seo_url: `https://unstop.com/jobs/acme-${index}`,
      details: 'Build APIs. '.repeat(50),
      start_date: '2026-07-12T00:00:00Z',
      regn_open: true,
    }))
    mockAdapterFetch.mockResolvedValue({ ok: true, status: 200, raw: rows, rawPageSize: 2, attempts: 1 })
    const persistedPerFence: number[] = []
    mockWithSourceWriteFence.mockImplementation(async (
      _sourceId: string,
      _revision: number,
      work: (session: undefined) => Promise<unknown>,
    ) => {
      const before = mockPostingCreate.mock.calls.length
      const result = await work(undefined)
      persistedPerFence.push(mockPostingCreate.mock.calls.length - before)
      return result
    })

    await runSourceSyncHandler({ data: { sourceId: 'unstop' } }, step, { interRequestDelayMs: 0 })

    expect(persistedPerFence.filter((count) => count > 0)).toEqual([25, 1])
  })

  it('a physically-full page with ZERO open rows keeps paging — policy filtering is not exhaustion (Codex #536)', async () => {
    resetAll()
    mockSourceFindOne.mockReturnValue({ lean: () => Promise.resolve({ sourceId: 'unstop', enabled: true, health: 'active', kind: 'public-api', cadenceMinutes: 1440 }) })
    mockCursorFind.mockReturnValue({ lean: () => Promise.resolve([]) })
    mockAdapterFetch
      .mockResolvedValueOnce({ ok: true, status: 200, raw: [], rawPageSize: 15, attempts: 1 }) // full page, all closed
      .mockResolvedValueOnce({ ok: true, status: 200, raw: [], rawPageSize: 2, attempts: 1 })  // short page = true end
    await runSourceSyncHandler({ data: { sourceId: 'unstop' } }, step, { interRequestDelayMs: 0 })
    expect(mockAdapterFetch).toHaveBeenCalledTimes(2)
    expect(mockAdapterFetch.mock.calls[1][0]).toMatchObject({ page: 2 })
  })

  it('a first-run feed (no cursor) does NOT get the #559 bucket distrust — an all-known full page still hits the cutoff instead of draining to the feed cap (Codex #559 round 2)', async () => {
    resetAll()
    mockSourceFindOne.mockReturnValue({ lean: () => Promise.resolve({ sourceId: 'unstop', enabled: true, health: 'active', kind: 'public-api', cadenceMinutes: 1440 }) })
    mockCursorFind.mockReturnValue({ lean: () => Promise.resolve([]) }) // no cursor — first run for the feed
    // Every incoming row is already stored → Tier-1 refresh → knownRate = 1.
    ;(JobPosting.findOne as ReturnType<typeof vi.fn>).mockImplementation((q: Record<string, unknown>) =>
      q?.['provenance.sourceKey']
        ? Promise.resolve({ status: 'open', provenance: [{ sourceKey: q['provenance.sourceKey'], lastSeenAt: new Date(0) }], jdLength: 100000, locationKeys: [], locations: [], save: async () => ({}) })
        : Promise.resolve(null)
    )
    // A physically-FULL page (rawPageSize ≥ PER_PAGE) of open, normalizable rows.
    const openRow = (k: number) => ({ id: `u${k}`, title: 'Backend Developer', organisation: { name: `Acme ${k}` }, seo_url: `https://unstop.com/jobs/acme-${k}`, details: 'Build APIs. '.repeat(50), start_date: '2026-07-12T00:00:00Z', regn_open: true })
    mockAdapterFetch.mockResolvedValue({ ok: true, status: 200, attempts: 1, raw: [openRow(1), openRow(2), openRow(3)], rawPageSize: 15 })
    try {
      await runSourceSyncHandler({ data: { sourceId: 'unstop' } }, step, { interRequestDelayMs: 0 })
      // Cutoff fired at page 1 (the feed is NOT first-run-distrusted) — a single
      // fetch, no drain to MAX_PAGES_PER_FEED, no cap-exit continuation.
      expect(mockAdapterFetch).toHaveBeenCalledTimes(1)
    } finally {
      ;(JobPosting.findOne as ReturnType<typeof vi.fn>).mockReset().mockResolvedValue(null)
    }
  })

  it('resumes unstop at the persisted lastPage+1 — the continuation offset is never stomped (Codex #536)', async () => {
    resetAll()
    mockSourceFindOne.mockReturnValue({ lean: () => Promise.resolve({ sourceId: 'unstop', enabled: true, health: 'active', kind: 'public-api', cadenceMinutes: 1440 }) })
    mockCursorFind.mockReturnValue({ lean: () => Promise.resolve([{ bucket: 'unstop:feed', lastPage: 12 }]) })
    mockAdapterFetch.mockResolvedValue({ ok: true, status: 200, raw: [], rawPageSize: 0, attempts: 1 })
    await runSourceSyncHandler({ data: { sourceId: 'unstop' } }, step, { interRequestDelayMs: 0 })
    expect(mockAdapterFetch.mock.calls[0][0]).toMatchObject({ kind: 'feed', page: 13 })
  })
})

describe('runSourceSyncHandler', () => {
  const EVENT = { data: { sourceId: 'jsearch' } }
  const CONTROL_REVISION = 4
  const REVISION_EVENT = { data: { sourceId: 'jsearch', controlRevision: CONTROL_REVISION } }
  const REVISION_CONFIG = {
    sourceId: 'jsearch', enabled: true, health: 'active',
    controlRevision: CONTROL_REVISION, cadenceMinutes: 1440,
  }
  const REVISION_ROW = {
    job_id: 'revision-row', job_title: 'Backend Developer', employer_name: 'Authority Fence Ltd',
    job_city: 'Pune', job_description: 'Build APIs. '.repeat(50),
    job_posted_at_datetime_utc: '2026-07-12T00:00:00Z',
    job_apply_link: 'https://careers.authority-fence.example/jobs/1',
  }

  function prepareRevisionedSync(): void {
    mockSourceFindOne.mockReturnValue({ lean: () => Promise.resolve(REVISION_CONFIG) })
    mockCursorFind.mockReturnValue({ lean: () => Promise.resolve([]) })
    mockAdapterFetch.mockResolvedValue({ ok: true, status: 200, attempts: 1, raw: [REVISION_ROW] })
  }

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

  it('fails transaction readiness before spending provider quota', async () => {
    resetAll()
    mockSourceFindOne.mockReturnValue({ lean: () => Promise.resolve(REVISION_CONFIG) })
    mockCursorFind.mockReturnValue({ lean: () => Promise.resolve([]) })
    mockAssertSourceTransactionsReady.mockRejectedValueOnce(new SourceTransactionsRequiredError())

    await expect(runSourceSyncHandler(REVISION_EVENT, step, { interRequestDelayMs: 0 }))
      .rejects.toBeInstanceOf(SourceTransactionsRequiredError)

    expect(mockAdapterFetch).not.toHaveBeenCalled()
  })

  it.each([
    [{ data: { sourceId: 'jsearch', controlRevision: CONTROL_REVISION - 1 } }, 'stale source revision'],
    [{ data: { sourceId: 'jsearch' } }, 'stale source revision'],
    [{ data: { sourceId: 'jsearch', controlRevision: -1 } }, 'invalid source revision'],
  ])('rejects stale, missing, and invalid post-epoch authority before source access', async (event, reason) => {
    resetAll()
    prepareRevisionedSync()

    const result = await runSourceSyncHandler(event, step, { interRequestDelayMs: 0 })

    expect(result).toEqual({ skipped: true, reason })
    expect(mockAssertSourceSyncAuthority).not.toHaveBeenCalled()
    expect(mockAdapterFetch).not.toHaveBeenCalled()
    expect(mockWithSourceWriteFence).not.toHaveBeenCalled()
    expect(mockCursorBulkWrite).not.toHaveBeenCalled()
    expect(mockCycleCreate).not.toHaveBeenCalled()
  })

  it('stops before fetching when the pre-fetch authority guard observes a control change', async () => {
    resetAll()
    prepareRevisionedSync()
    mockAssertSourceSyncAuthority.mockRejectedValueOnce(
      new SourceAuthorityChangedError('jsearch', CONTROL_REVISION)
    )

    const result = await runSourceSyncHandler(REVISION_EVENT, step, { interRequestDelayMs: 0 })

    expect(result).toEqual({ skipped: true, reason: 'source authority changed during sync' })
    expect(mockAssertSourceSyncAuthority).toHaveBeenCalledWith('jsearch', CONTROL_REVISION)
    expect(mockAdapterFetch).not.toHaveBeenCalled()
    expect(mockWithSourceWriteFence).not.toHaveBeenCalled()
    expect(mockCursorBulkWrite).not.toHaveBeenCalled()
    expect(mockSourceUpdateOne).not.toHaveBeenCalled()
    expect(mockCycleCreate).not.toHaveBeenCalled()
  })

  it('treats revocation after adapter entry as authority loss, not provider health failure', async () => {
    resetAll()
    prepareRevisionedSync()
    mockAssertSourceSyncAuthority
      .mockResolvedValueOnce(undefined) // processTarget pre-fetch guard
      .mockRejectedValueOnce(new SourceAuthorityChangedError('jsearch', CONTROL_REVISION)) // physical request gate
    mockAdapterFetch.mockImplementation(async (_target, options: { beforePhysicalRequest?: () => Promise<boolean> }) => {
      try {
        await options.beforePhysicalRequest?.()
        return { ok: true, status: 200, attempts: 1, raw: [REVISION_ROW] }
      } catch {
        return { ok: false, status: 0, attempts: 0, raw: [], authorityChanged: true }
      }
    })

    const result = await runSourceSyncHandler(REVISION_EVENT, step, { interRequestDelayMs: 0 })

    expect(result).toEqual({ skipped: true, reason: 'source authority changed during sync' })
    expect(mockAssertSourceSyncAuthority).toHaveBeenCalledTimes(2)
    expect(mockPostingCreate).not.toHaveBeenCalled()
    expect(mockCursorBulkWrite).not.toHaveBeenCalled()
    expect(mockSourceUpdateOne).not.toHaveBeenCalled()
    expect(mockCycleCreate).not.toHaveBeenCalled()
  })

  it('does not persist a fetched page when authority changes at the page write fence', async () => {
    resetAll()
    prepareRevisionedSync()
    mockWithSourceWriteFence.mockRejectedValueOnce(
      new SourceAuthorityChangedError('jsearch', CONTROL_REVISION)
    )

    const result = await runSourceSyncHandler(REVISION_EVENT, step, { interRequestDelayMs: 0 })

    expect(result).toEqual({ skipped: true, reason: 'source authority changed during sync' })
    expect(mockAdapterFetch).toHaveBeenCalledTimes(1)
    expect(mockPostingCreate).not.toHaveBeenCalled()
    expect(mockCursorBulkWrite).not.toHaveBeenCalled()
    expect(mockSourceUpdateOne).not.toHaveBeenCalled()
    expect(mockCycleCreate).not.toHaveBeenCalled()
  })

  it('does not checkpoint or finalize when authority changes after a page write', async () => {
    resetAll()
    prepareRevisionedSync()
    mockWithSourceWriteFence
      .mockImplementationOnce(
        (_sourceId: string, _revision: number, work: (session: undefined) => Promise<unknown>) => work(undefined)
      )
      .mockRejectedValueOnce(new SourceAuthorityChangedError('jsearch', CONTROL_REVISION))

    const result = await runSourceSyncHandler(REVISION_EVENT, step, { interRequestDelayMs: 0 })

    expect(result).toEqual({ skipped: true, reason: 'source authority changed during sync' })
    expect(mockPostingCreate).toHaveBeenCalledTimes(1)
    expect(mockWithSourceWriteFence).toHaveBeenCalledTimes(2)
    expect(mockCursorBulkWrite).not.toHaveBeenCalled()
    expect(mockSourceUpdateOne).not.toHaveBeenCalled()
    expect(mockCycleCreate).not.toHaveBeenCalled()
  })

  it('keeps durable chunk checkpoints but makes no final writes when authority changes before finalize', async () => {
    resetAll()
    prepareRevisionedSync()
    let checkpointsBeforeFinalize = -1
    const finalAuthorityChangeStep = {
      run: async <T,>(name: string, fn: () => Promise<T> | T): Promise<T> => {
        if (name === 'finalize') {
          checkpointsBeforeFinalize = mockCursorBulkWrite.mock.calls.length
          mockWithSourceWriteFence.mockRejectedValueOnce(
            new SourceAuthorityChangedError('jsearch', CONTROL_REVISION)
          )
        }
        return fn()
      },
    }

    const result = await runSourceSyncHandler(REVISION_EVENT, finalAuthorityChangeStep, { interRequestDelayMs: 0 })

    expect(result).toEqual({ skipped: true, reason: 'source authority changed during sync' })
    expect(checkpointsBeforeFinalize).toBeGreaterThan(0)
    expect(mockCursorBulkWrite).toHaveBeenCalledTimes(checkpointsBeforeFinalize)
    expect(mockSourceUpdateOne).not.toHaveBeenCalled()
    expect(mockPostingUpdateMany).not.toHaveBeenCalled()
    expect(mockPostingUpdateOne).not.toHaveBeenCalled()
    expect(mockCycleCreate).not.toHaveBeenCalled()
  })

  it('runs chunks, writes cursors + cycle row, keeps health active on a clean run', async () => {
    resetAll()
    mockSourceFindOne.mockReturnValue({ lean: () => Promise.resolve(REVISION_CONFIG) })
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
    const r = await runSourceSyncHandler(REVISION_EVENT, step, { interRequestDelayMs: 0 })
    expect(r).toMatchObject({ cycleWritten: true })
    const cycle = mockCycleCreate.mock.calls[0][0][0]
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
    expect(mockSourceUpdateOne.mock.calls.at(-1)![0]).toMatchObject({
      sourceId: 'jsearch',
      enabled: true,
      controlRevision: CONTROL_REVISION,
    })
    expect(mockCycleCreate).toHaveBeenCalledWith(
      [expect.objectContaining({ kind: 'sync', sourceId: 'jsearch' })],
      { session: undefined },
    )
  })

  it('cursors checkpoint per chunk — durable even when the run dies before finalize (prod first-fill, 2026-07-15)', async () => {
    resetAll()
    mockSourceFindOne.mockReturnValue({ lean: () => Promise.resolve({ sourceId: 'jsearch', enabled: true, health: 'active', cadenceMinutes: 1440 }) })
    mockCursorFind.mockReturnValue({ lean: () => Promise.resolve([]) })
    mockAdapterFetch.mockImplementation(async (t: { bucketId?: string }) => ({
      ok: true, status: 200, attempts: 1,
      raw: [{
        job_id: `id-${t.bucketId}`, job_title: 'Backend Developer', employer_name: `Acme ${t.bucketId}`,
        job_city: 'Pune', job_description: 'Build APIs. '.repeat(50),
        job_posted_at_datetime_utc: '2026-07-12T00:00:00Z', job_apply_link: 'https://careers.acme.com/1',
      }],
    }))
    // Simulate the platform killing the invocation before finalize (the
    // 300s maxDuration guillotine): chunk steps run, finalize never does.
    const dyingStep = {
      run: <T,>(name: string, fn: () => Promise<T> | T): Promise<T> => {
        if (name === 'finalize') throw new Error('invocation killed')
        return Promise.resolve(fn())
      },
    }
    await expect(runSourceSyncHandler(EVENT, dyingStep, { interRequestDelayMs: 0 })).rejects.toThrow('invocation killed')
    // The chunk-level checkpoints already landed: monotonic $max upserts,
    // so the next re-dispatch reads narrowed windows instead of refetching
    // the whole corpus on billed quota.
    expect(mockCursorBulkWrite).toHaveBeenCalled()
    const op = mockCursorBulkWrite.mock.calls[0][0][0].updateOne
    expect(op.update.$max.newestPostedAt).toBeInstanceOf(Date)
    expect(op.upsert).toBe(true)
    expect(mockCycleCreate).not.toHaveBeenCalled() // finalize genuinely never ran
  })

  it('a partially-fetched bucket never advances its cursor (Codex #528) — failed later pages stay in the window', async () => {
    resetAll()
    mockSourceFindOne.mockReturnValue({ lean: () => Promise.resolve({ sourceId: 'jsearch', enabled: true, health: 'active', cadenceMinutes: 1440 }) })
    mockCursorFind.mockReturnValue({ lean: () => Promise.resolve([]) })
    // Page 1: FULL page (10 fresh rows) → pagination continues; page 2: 500.
    // The bucket ingested page 1 but is INCOMPLETE — advancing its cursor
    // would shrink the next run's window past the rows page 2 owed us.
    const fullPage = (bucket: string) => Array.from({ length: 10 }, (_, k) => ({
      job_id: `id-${bucket}-${k}`, job_title: 'Backend Developer', employer_name: `Acme ${bucket} ${k}`,
      job_city: 'Pune', job_description: 'Build APIs. '.repeat(50),
      job_posted_at_datetime_utc: '2026-07-12T00:00:00Z', job_apply_link: `https://careers.acme.com/${k}`,
    }))
    mockAdapterFetch.mockImplementation(async (t: { bucketId?: string; page?: number }) =>
      (t.page ?? 1) === 1
        ? { ok: true, status: 200, attempts: 1, raw: fullPage(t.bucketId ?? 'b') }
        : { ok: false, status: 500, attempts: 1, raw: [] }
    )
    const r = await runSourceSyncHandler(EVENT, step, { interRequestDelayMs: 0 })
    expect(r).toMatchObject({ cycleWritten: true })
    // Rows from page 1 WERE ingested (no data loss)...
    expect(mockCycleCreate.mock.calls[0][0][0].fetched).toBeGreaterThan(0)
    // ...but no cursor ADVANCED anywhere: every bucket died on page 2 —
    // the only writes are the durable windowIncomplete flags (#528 P1),
    // never a newestPostedAt move.
    const allOps = mockCursorBulkWrite.mock.calls.flatMap((c) => c[0])
    expect(allOps.length).toBeGreaterThan(0)
    for (const op of allOps) {
      expect(op.updateOne.update.$max).toBeUndefined()
      expect(op.updateOne.update.$set.windowIncomplete).toBe(true)
    }
    // And the run reads sick, not healthy (httpErrors on every bucket).
    expect(mockSourceUpdateOne.mock.calls.at(-1)![1].$set.health).toBe('degraded')
  })

  it('a windowIncomplete bucket distrusts the known-rate cutoff — the failed page is retried before the cursor moves (Codex #528 P1)', async () => {
    resetAll()
    mockSourceFindOne.mockReturnValue({ lean: () => Promise.resolve({ sourceId: 'jsearch', enabled: true, health: 'active', cadenceMinutes: 1440 }) })
    // Real bucket ids from the real matrix (only fetch is mocked).
    const targets = jsearchAdapter.buildTargets({ sourceId: 'jsearch', enabled: true }, [])
    const retryBucket = (targets[0] as { bucketId: string }).bucketId
    const trustedBucket = (targets[1] as { bucketId: string }).bucketId
    // Prior run stored page 1 of retryBucket then died on page 2 → its
    // cursor row carries the durable flag and NO newestPostedAt. trustedBucket
    // carries a normal COMPLETED cursor so it is not a first run — the #559
    // no-cursor distrust doesn't apply and it trusts the cutoff.
    mockCursorFind.mockReturnValue({ lean: () => Promise.resolve([
      { bucket: retryBucket, windowIncomplete: true },
      { bucket: trustedBucket, newestPostedAt: new Date('2026-07-01T00:00:00Z') },
    ]) })
    // Every incoming row is ALREADY STORED (the partial run's writes):
    // Tier-1 sourceKey lookup returns a refreshable doc → refreshed++ →
    // knownRate = 1 ≥ cutoff on every page-1.
    ;(JobPosting.findOne as ReturnType<typeof vi.fn>).mockImplementation((q: Record<string, unknown>) =>
      q?.['provenance.sourceKey']
        ? Promise.resolve({
            status: 'open',
            provenance: [{ sourceKey: q['provenance.sourceKey'], lastSeenAt: new Date(0) }],
            jdLength: 100000, locationKeys: [], locations: [],
            save: async () => ({}),
          })
        : Promise.resolve(null)
    )
    const fullPage = (bucket: string, page: number, n: number) => Array.from({ length: n }, (_, k) => ({
      job_id: `id-${bucket}-p${page}-${k}`, job_title: 'Backend Developer', employer_name: `Acme ${k}`,
      job_city: 'Pune', job_description: 'Build APIs. '.repeat(50),
      job_posted_at_datetime_utc: '2026-07-12T00:00:00Z', job_apply_link: `https://careers.acme.com/${page}/${k}`,
    }))
    mockAdapterFetch.mockImplementation(async (t: { bucketId?: string; page?: number }) => ({
      ok: true, status: 200, attempts: 1,
      // Page 1 full everywhere; page 2 (reached only by distrusted buckets)
      // is non-full → full clean exit.
      raw: fullPage(t.bucketId ?? 'b', t.page ?? 1, (t.page ?? 1) === 1 ? 10 : 1),
    }))
    try {
      const r = await runSourceSyncHandler(EVENT, step, { interRequestDelayMs: 0 })
      expect(r).toMatchObject({ cycleWritten: true })
      const pagesFor = (b: string) => mockAdapterFetch.mock.calls.filter((c) => c[0].bucketId === b).map((c) => c[0].page)
      // The flagged bucket paginated PAST the all-known page 1 (cutoff
      // distrusted) and retried page 2; a trusted bucket stopped at page 1.
      expect(pagesFor(retryBucket)).toContain(2)
      expect(pagesFor(trustedBucket)).toEqual([1])
      // Its window completed cleanly → cursor advanced AND flag cleared.
      const ops = mockCursorBulkWrite.mock.calls.flatMap((c) => c[0])
      const retryOp = ops.find((o) => o.updateOne.filter.bucket === retryBucket)
      expect(retryOp.updateOne.update.$max.newestPostedAt).toBeInstanceOf(Date)
      expect(retryOp.updateOne.update.$set.windowIncomplete).toBe(false)
      // Trusted buckets keep the steady-state economics: cutoff exit at
      // page 1 still advances their cursor.
      const trustedOp = ops.find((o) => o.updateOne.filter.bucket === trustedBucket)
      expect(trustedOp.updateOne.update.$max.newestPostedAt).toBeInstanceOf(Date)
    } finally {
      ;(JobPosting.findOne as ReturnType<typeof vi.fn>).mockReset().mockResolvedValue(null)
    }
  })

  it('a first-run bucket (no cursor yet) distrusts the known-rate cutoff — a #23 renamed bucket over an existing corpus must not freeze shallow (Codex #559)', async () => {
    resetAll()
    mockSourceFindOne.mockReturnValue({ lean: () => Promise.resolve({ sourceId: 'jsearch', enabled: true, health: 'active', cadenceMinutes: 1440 }) })
    const targets = jsearchAdapter.buildTargets({ sourceId: 'jsearch', enabled: true }, [])
    const freshBucket = (targets[0] as { bucketId: string }).bucketId    // brand new — no cursor (the rename)
    const knownBucket = (targets[1] as { bucketId: string }).bucketId    // already has a completed cursor
    // Only knownBucket has a persisted cursor; freshBucket is new to the corpus.
    mockCursorFind.mockReturnValue({ lean: () => Promise.resolve([{ bucket: knownBucket, newestPostedAt: new Date('2026-07-01T00:00:00Z') }]) })
    // Every incoming row is ALREADY STORED (the existing metro-built corpus) →
    // Tier-1 sourceKey lookup refreshes → knownRate = 1 on every page 1.
    ;(JobPosting.findOne as ReturnType<typeof vi.fn>).mockImplementation((q: Record<string, unknown>) =>
      q?.['provenance.sourceKey']
        ? Promise.resolve({
            status: 'open',
            provenance: [{ sourceKey: q['provenance.sourceKey'], lastSeenAt: new Date(0) }],
            jdLength: 100000, locationKeys: [], locations: [],
            save: async () => ({}),
          })
        : Promise.resolve(null)
    )
    const fullPage = (bucket: string, page: number, n: number) => Array.from({ length: n }, (_, k) => ({
      job_id: `id-${bucket}-p${page}-${k}`, job_title: 'Backend Developer', employer_name: `Acme ${k}`,
      job_city: 'Pune', job_description: 'Build APIs. '.repeat(50),
      job_posted_at_datetime_utc: '2026-07-12T00:00:00Z', job_apply_link: `https://careers.acme.com/${page}/${k}`,
    }))
    mockAdapterFetch.mockImplementation(async (t: { bucketId?: string; page?: number }) => ({
      ok: true, status: 200, attempts: 1,
      // Page 1 full everywhere; page 2 (reached only by distrusted buckets) is
      // non-full → a clean exit.
      raw: fullPage(t.bucketId ?? 'b', t.page ?? 1, (t.page ?? 1) === 1 ? 10 : 1),
    }))
    try {
      const r = await runSourceSyncHandler(EVENT, step, { interRequestDelayMs: 0 })
      expect(r).toMatchObject({ cycleWritten: true })
      const pagesFor = (b: string) => mockAdapterFetch.mock.calls.filter((c) => c[0].bucketId === b).map((c) => c[0].page)
      // The brand-new bucket paginated PAST the all-known page 1 — the deep
      // country coverage the #23 page cap relies on, instead of freezing shallow.
      expect(pagesFor(freshBucket)).toContain(2)
      // A bucket that already has a completed cursor still trusts the cutoff.
      expect(pagesFor(knownBucket)).toEqual([1])
    } finally {
      ;(JobPosting.findOne as ReturnType<typeof vi.fn>).mockReset().mockResolvedValue(null)
    }
  })

  it('a bucket that fills all MAX_PAGES_PER_BUCKET pages with fresh rows logs a cap-exit — deep-backlog drop is never silent (Codex #559 round 3)', async () => {
    resetAll()
    const { logger } = await import('@shared/logger')
    vi.mocked(logger.warn).mockClear()
    mockSourceFindOne.mockReturnValue({ lean: () => Promise.resolve({ sourceId: 'jsearch', enabled: true, health: 'active', cadenceMinutes: 1440 }) })
    mockCursorFind.mockReturnValue({ lean: () => Promise.resolve([]) })
    // Every page is FULL (10 rows) and every row is NEW (findOne default → null)
    // → knownRate 0, no cutoff → the bucket paginates to the 4-page cap and
    // cap-exits with backlog still behind it.
    mockAdapterFetch.mockImplementation(async (t: { bucketId?: string; page?: number }) => ({
      ok: true, status: 200, attempts: 1,
      raw: Array.from({ length: 10 }, (_, k) => ({
        job_id: `id-${t.bucketId}-p${t.page}-${k}`, job_title: 'Backend Developer', employer_name: `Acme ${t.page}-${k}`,
        job_city: 'Pune', job_description: 'Build APIs. '.repeat(50),
        job_posted_at_datetime_utc: '2026-07-12T00:00:00Z', job_apply_link: `https://careers.acme.com/${t.page}/${k}`,
      })),
    }))
    await runSourceSyncHandler(EVENT, step, { interRequestDelayMs: 0 })
    const warnCalls = vi.mocked(logger.warn).mock.calls as Array<[Record<string, unknown>, string]>
    const capWarn = warnCalls.find((c) => c[1]?.includes('cap-exit'))
    expect(capWarn).toBeTruthy()
    // 4 = MAX_PAGES_PER_BUCKET; the tail beyond page 4 was dropped this run.
    expect(capWarn![0]).toMatchObject({ bucket: expect.any(String), pagesFetched: 4 })
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
    expect(mockCycleCreate.mock.calls[0][0][0].storeErrors).toBeGreaterThan(0)
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
    const cycle = mockCycleCreate.mock.calls[0][0][0]
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
    _id: 'p1',
    updatedAt: new Date('2026-07-20T00:00:00Z'),
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
    const lifecycleOps = mockPostingBulkWrite.mock.calls[0][0]
    expect(lifecycleOps).toHaveLength(1)
    expect(lifecycleOps[0].updateOne.filter).toMatchObject({
      _id: 'p1', status: 'open', updatedAt: staleSolo.updatedAt,
    })
    expect(lifecycleOps[0].updateOne.update).toMatchObject({
      $set: { status: 'closed', closedReason: 'board-poll-miss', boardPollMisses: 2 },
    })
    expect(lifecycleOps[0].updateOne.update.$set.purgeAt).toBeInstanceOf(Date)
    expect(staleShared.status).toBe('open') // another source still lists it
    expect(staleShared.save).not.toHaveBeenCalled()
  })

  it('a restricted close that wins after the stale scan cannot be downgraded to a board archive', async () => {
    resetAll()
    mockSourceFindOne.mockReturnValue({ lean: () => Promise.resolve({ sourceId: 'gh:phonepe', enabled: true, health: 'active', kind: 'ats-board', atsKind: 'greenhouse', slug: 'phonepe', cadenceMinutes: 360 }) })
    mockCursorFind.mockReturnValue({ lean: () => Promise.resolve([]) })
    mockAdapterFetch.mockResolvedValue({ ok: true, status: 200, attempts: 1, raw: [] })
    const stale = docStub({ boardPollMisses: 1, provenance: [{ sourceId: 'gh:phonepe', externalId: 'gone', sourceKey: 'gh:phonepe:gone', lastSeenAt: new Date() }] })
    const { JobPosting } = await import('@shared/db/models')
    vi.mocked(JobPosting.find).mockReturnValueOnce({ limit: () => Promise.resolve([stale]) } as never)
    // source-revoked/llm-verdict landed and bumped the lifecycle before the
    // board close CAS. The miss must also suppress both TTL follow-up writes.
    mockPostingBulkWrite.mockResolvedValueOnce({ matchedCount: 0 })

    await runSourceSyncHandler({ data: { sourceId: 'gh:phonepe' } }, step, { interRequestDelayMs: 0 })

    expect(mockPostingBulkWrite).toHaveBeenCalledTimes(1)
    expect(mockPostingBulkWrite.mock.calls[0][0][0].updateOne.filter).toMatchObject({
      _id: 'p1', status: 'open', updatedAt: stale.updatedAt,
    })
    expect(stale.save).not.toHaveBeenCalled()
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
    expect(mockPostingBulkWrite).toHaveBeenCalledWith(
      [{ updateOne: {
        filter: expect.objectContaining({ _id: 'p1', status: 'open', updatedAt: stale.updatedAt }),
        update: { $set: { boardPollMisses: 1 } },
      } }],
      { session: undefined },
    )

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

    // a SAVED (userReferenced) posting closes on the 2nd miss but must
    // NEVER get a purgeAt — the tracker keeps its _id forever (Codex #517)
    resetAll()
    mockSourceFindOne.mockReturnValue({ lean: () => Promise.resolve({ sourceId: 'gh:phonepe', enabled: true, health: 'active', kind: 'ats-board', atsKind: 'greenhouse', slug: 'phonepe', cadenceMinutes: 360 }) })
    mockCursorFind.mockReturnValue({ lean: () => Promise.resolve([]) })
    mockAdapterFetch.mockResolvedValue({ ok: true, status: 200, attempts: 1, raw: [] })
    const pinned = docStub({ provenance: [{ sourceId: 'gh:phonepe', sourceKey: 'gh:phonepe:z9' }], boardPollMisses: 1, userReferenced: true })
    vi.mocked((await import('@shared/db/models')).JobPosting.find).mockReturnValueOnce({ limit: () => Promise.resolve([pinned]) } as never)
    await runSourceSyncHandler({ data: { sourceId: 'gh:phonepe' } }, step, { interRequestDelayMs: 0 })
    const pinnedUpdate = mockPostingBulkWrite.mock.calls[0][0][0].updateOne.update
    expect(pinnedUpdate).toMatchObject({
      $set: { status: 'closed', closedReason: 'board-poll-miss' },
      $unset: { purgeAt: 1 },
    })
    expect(pinnedUpdate.$set.purgeAt).toBeUndefined()

    // Pins are monotonic in the close path: clearing one from a cross-
    // collection existence check races a concurrent first ownership write.
    // Conservative orphan cleanup belongs in a separate reconciliation job.
    resetAll()
    mockSourceFindOne.mockReturnValue({ lean: () => Promise.resolve({ sourceId: 'gh:phonepe', enabled: true, health: 'active', kind: 'ats-board', atsKind: 'greenhouse', slug: 'phonepe', cadenceMinutes: 360 }) })
    mockCursorFind.mockReturnValue({ lean: () => Promise.resolve([]) })
    mockAdapterFetch.mockResolvedValue({ ok: true, status: 200, attempts: 1, raw: [] })
    const models = await import('@shared/db/models')
    const orphaned = docStub({ provenance: [{ sourceId: 'gh:phonepe', sourceKey: 'gh:phonepe:z8' }], boardPollMisses: 1, userReferenced: true })
    vi.mocked(models.JobPosting.find).mockReturnValueOnce({ limit: () => Promise.resolve([orphaned]) } as never)
    await runSourceSyncHandler({ data: { sourceId: 'gh:phonepe' } }, step, { interRequestDelayMs: 0 })
    expect(orphaned.userReferenced).toBe(true)
    expect(mockPostingBulkWrite.mock.calls[0][0][0].updateOne.update).toMatchObject({
      $unset: { purgeAt: 1 },
    })
    expect(orphaned.save).not.toHaveBeenCalled()

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

  it('does not contact a board when its authority epoch is revoked after the board list is loaded', async () => {
    resetAll()
    mockSourceFind.mockReturnValue({ lean: () => Promise.resolve([boardRow({ controlRevision: 5 })]) })
    mockAssertSourceProbeAuthority.mockRejectedValueOnce(
      new SourceAuthorityChangedError('gh:phonepe', 5)
    )

    const result = await runBoardProbeHandler(step)

    expect(result).toEqual({ probed: 1 })
    expect(mockAssertSourceProbeAuthority).toHaveBeenCalledWith('gh:phonepe', 5)
    expect(mockAdapterFetch).not.toHaveBeenCalled()
    expect(mockSourceUpdateOne).not.toHaveBeenCalled()
  })

  it('does not write board health when authority changes inside adapter pagination', async () => {
    resetAll()
    mockSourceFind.mockReturnValue({ lean: () => Promise.resolve([boardRow({ controlRevision: 5 })]) })
    mockAssertSourceProbeAuthority
      .mockResolvedValueOnce(undefined) // before adapter entry
      .mockRejectedValueOnce(new SourceAuthorityChangedError('gh:phonepe', 5)) // next physical request
    mockAdapterFetch.mockImplementation(async (_target, options: { beforePhysicalRequest?: () => Promise<boolean> }) => {
      try {
        await options.beforePhysicalRequest?.()
        return { ok: false, status: 404, attempts: 1, raw: [] }
      } catch {
        return { ok: false, status: 0, attempts: 0, raw: [], authorityChanged: true }
      }
    })

    const result = await runBoardProbeHandler(step)

    expect(result).toEqual({ probed: 1 })
    expect(mockAssertSourceProbeAuthority).toHaveBeenCalledTimes(2)
    expect(mockSourceUpdateOne).not.toHaveBeenCalled()
  })

  it('binds a probe health write to the exact loaded revision and lifecycle state', async () => {
    resetAll()
    mockSourceFind.mockReturnValue({ lean: () => Promise.resolve([boardRow({ controlRevision: 5 })]) })
    mockAdapterFetch.mockResolvedValue({ ok: false, status: 404, attempts: 1, raw: [] })
    // A concurrent revoke makes this CAS miss in Mongo; the stale probe gets
    // no revision-free retry that could overwrite health:'revoked'.
    mockSourceUpdateOne.mockResolvedValueOnce({ matchedCount: 0 })

    await runBoardProbeHandler(step)

    expect(mockSourceUpdateOne).toHaveBeenCalledOnce()
    expect(mockSourceUpdateOne.mock.calls[0][0]).toEqual({
      sourceId: 'gh:phonepe',
      enabled: true,
      health: 'active',
      controlRevision: 5,
    })
    expect(mockSourceUpdateOne.mock.calls[0][1].$set).toMatchObject({
      health: 'quarantined',
      healthyProbeStreak: 0,
    })
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
