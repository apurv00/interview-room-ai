import { describe, it, expect, vi } from 'vitest'

const {
  mockSend, mockIsFeatureEnabled, mockSourceFindOne, mockSourceFind, mockSourceUpdateOne,
  mockCursorFind, mockCursorBulkWrite, mockCycleCreate, mockAdapterFetch,
} = vi.hoisted(() => ({
  mockSend: vi.fn(),
  mockIsFeatureEnabled: vi.fn(),
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
vi.mock('@shared/featureFlags', () => ({ isFeatureEnabled: mockIsFeatureEnabled }))
vi.mock('@shared/db/connection', () => ({ connectDB: vi.fn().mockResolvedValue(undefined) }))
vi.mock('@shared/redis', () => ({ redis: { sadd: vi.fn(), expire: vi.fn(), scard: vi.fn() } }))
vi.mock('@shared/logger', () => ({ logger: { warn: vi.fn() } }))
vi.mock('@shared/db/models', () => ({
  JobPosting: { findOne: vi.fn().mockResolvedValue(null), find: vi.fn(() => ({ limit: () => Promise.resolve([]) })), create: vi.fn().mockResolvedValue({}) },
  JobSourceConfig: { findOne: mockSourceFindOne, find: mockSourceFind, updateOne: mockSourceUpdateOne },
  JobIngestCursor: { find: mockCursorFind, bulkWrite: mockCursorBulkWrite },
  JobIngestCycle: { create: mockCycleCreate },
}))
vi.mock('../adapters/jsearchAdapter', async (importOriginal) => {
  const real = await importOriginal<typeof import('../adapters/jsearchAdapter')>()
  return { jsearchAdapter: { ...real.jsearchAdapter, fetch: mockAdapterFetch } }
})

import { runIngestSchedulerHandler, runSourceSyncHandler } from '../jobs/ingestJobs'

const step = { run: <T,>(_n: string, fn: () => Promise<T> | T) => Promise.resolve(fn()) }

function resetAll(): void {
  for (const m of [mockSend, mockSourceFindOne, mockSourceFind, mockSourceUpdateOne, mockCursorFind, mockCursorBulkWrite, mockCycleCreate, mockAdapterFetch]) m.mockReset()
  mockIsFeatureEnabled.mockReset().mockReturnValue(true)
  mockSourceUpdateOne.mockReturnValue({ lean: () => Promise.resolve(null) })
  mockSourceUpdateOne.mockResolvedValue({})
  mockCursorBulkWrite.mockResolvedValue({})
  mockCycleCreate.mockResolvedValue({})
}

describe('runIngestSchedulerHandler', () => {
  it('flag off → skipped, zero dispatches', async () => {
    resetAll()
    mockIsFeatureEnabled.mockReturnValue(false)
    const r = await runIngestSchedulerHandler(step)
    expect(r).toEqual({ skipped: true })
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
    expect(mockSend).toHaveBeenCalledWith({ name: 'jobs/source.sync', data: { sourceId: 'due-source' } })
  })
})

describe('runSourceSyncHandler', () => {
  const EVENT = { data: { sourceId: 'jsearch' } }

  it('flag off / unknown adapter / disabled source / bad health all skip', async () => {
    resetAll()
    mockIsFeatureEnabled.mockReturnValue(false)
    expect(await runSourceSyncHandler(EVENT, step)).toMatchObject({ skipped: true })

    resetAll()
    expect(await runSourceSyncHandler({ data: { sourceId: 'nope' } }, step)).toMatchObject({ skipped: true })

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
    const health = mockSourceUpdateOne.mock.calls.at(-1)![1].$set.health
    expect(health).toBe('active')
  })

  it('a schema-drift run (HTTP 200, payloads no longer normalize) DEGRADES the source', async () => {
    resetAll()
    mockSourceFindOne.mockReturnValue({ lean: () => Promise.resolve({ sourceId: 'jsearch', enabled: true, health: 'active', cadenceMinutes: 1440 }) })
    mockCursorFind.mockReturnValue({ lean: () => Promise.resolve([]) })
    mockAdapterFetch.mockResolvedValue({ ok: true, status: 200, attempts: 1, raw: [{ shape: 'drifted' }] })
    const r = await runSourceSyncHandler(EVENT, step, { interRequestDelayMs: 0 })
    expect(r).toMatchObject({ cycleWritten: true })
    const health = mockSourceUpdateOne.mock.calls.at(-1)![1].$set.health
    expect(health).toBe('degraded')
    expect(mockSourceUpdateOne.mock.calls.at(-1)![1].$set.lastHealthyProbeAt).toBeUndefined()
  })

  it('a 429 anywhere degrades the source; drift rows are counted', async () => {
    resetAll()
    mockSourceFindOne.mockReturnValue({ lean: () => Promise.resolve({ sourceId: 'jsearch', enabled: true, health: 'active', cadenceMinutes: 1440 }) })
    mockCursorFind.mockReturnValue({ lean: () => Promise.resolve([]) })
    let first = true
    mockAdapterFetch.mockImplementation(async () => {
      if (first) { first = false; return { ok: false, status: 429, attempts: 1, raw: [] } }
      return { ok: true, status: 200, attempts: 1, raw: [{ not_a_job: true }] } // drift row
    })
    const r = await runSourceSyncHandler(EVENT, step, { interRequestDelayMs: 0 })
    expect(r).toMatchObject({ cycleWritten: true })
    const cycle = mockCycleCreate.mock.calls[0][0]
    expect(cycle.driftNulls).toBeGreaterThan(0)
    const health = mockSourceUpdateOne.mock.calls.at(-1)![1].$set.health
    expect(health).toBe('degraded')
  })
})
