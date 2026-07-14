import { describe, it, expect, vi } from 'vitest'

const {
  mockSend, mockGetConfig, mockPostingFindById, mockPostingUpdateOne, mockPostingFind,
  mockSourceFind, mockCycleCreate, mockRedis,
} = vi.hoisted(() => ({
  mockSend: vi.fn(),
  mockGetConfig: vi.fn(),
  mockPostingFindById: vi.fn(),
  mockPostingUpdateOne: vi.fn(),
  mockPostingFind: vi.fn(),
  mockSourceFind: vi.fn(),
  mockCycleCreate: vi.fn(),
  mockRedis: { get: vi.fn(), set: vi.fn(), incr: vi.fn(), incrbyfloat: vi.fn(), expire: vi.fn() },
}))

vi.mock('@shared/services/inngest', () => ({
  inngest: { send: mockSend, createFunction: vi.fn(() => ({})) },
}))
vi.mock('@shared/db/connection', () => ({ connectDB: vi.fn().mockResolvedValue(undefined) }))
vi.mock('@shared/redis', () => ({ redis: mockRedis }))
vi.mock('@shared/logger', () => ({ logger: { warn: vi.fn() } }))
vi.mock('@shared/services/modelRouter', async (importOriginal) => {
  const real = await importOriginal<typeof import('@shared/services/modelRouter')>()
  return { ...real, resolveModel: vi.fn().mockResolvedValue({ model: 'gpt-5.6-luna' }), completion: vi.fn() }
})
vi.mock('@shared/db/models', () => ({
  JobPosting: { findById: mockPostingFindById, updateOne: mockPostingUpdateOne, find: mockPostingFind },
  JobSourceConfig: { find: mockSourceFind },
  JobIngestCycle: { create: mockCycleCreate },
  JobsVerdictConfig: { getConfig: mockGetConfig },
}))

import { runEvaluatePostingsHandler, runVerdictSweeperHandler } from '../jobs/evaluatePostingsJob'
import { resolveModel } from '@shared/services/modelRouter'
import { verdictInputHash } from '../config/verdictPrompt'
import { JOB_DOMAINS } from '../config/domains'

// The CURRENT hash of the default posting() fixture as the worker computes it
// (empty body, greenhouse apply host, no salary, default epoch model).
const FIXTURE_HASH = verdictInputHash({
  companyKey: 'phonepe', titleKey: 'backend engineer', locationKey: 'bengaluru',
  normalizedBody: '', applyHosts: ['boards.greenhouse.io'], salaryText: null,
  epochModel: 'gpt-5.6-luna',
})

const step = { run: <T,>(_n: string, fn: () => Promise<T> | T) => Promise.resolve(fn()) }

const CFG_ON = {
  collectionEnabled: true, enforceEnabled: false,
  dailyVerdictCap: 900, dailyBudgetUsd: 2.5, monthlyBudgetUsd: 75,
  perCompanyDailyCap: 25, perSourceDailyCap: 500,
  inputUsdPerMTok: 0.5, outputUsdPerMTok: 2.0,
}

function posting(over: Record<string, unknown> = {}) {
  return {
    _id: 'p1', status: 'open', updatedAt: new Date('2026-07-14T00:00:00Z'),
    companyKey: 'phonepe', titleKey: 'backend engineer', locationKeys: ['bengaluru'],
    title: 'Backend Engineer', company: 'PhonePe', locations: ['Bengaluru'], isRemote: false,
    salaryText: null, jdCompressed: undefined,
    flags: { staffing: false, salaryConflict: false, shortJd: false, repost: false, repostCount: 0 },
    provenance: [{ sourceId: 'jsearch', externalId: 'x1', sourceKey: 'jsearch:x1', applyUrl: 'https://boards.greenhouse.io/x/1' }],
    llmVerdict: { status: 'pending', attempts: 0 },
    ...over,
  }
}

const OK_VERDICT = {
  verdict: 'fraud', reasonCodes: ['fee_fraud'], genuineness: 0.1, quality: 0.2, completeness: 0.4,
  domain: JOB_DOMAINS[0].id, domainConfidence: 0.9, seniority: 'fresher', fresherFriendly: true,
  geo: { locations: ['Pune'], workMode: 'onsite' },
}

function okOutcome(verdict = OK_VERDICT) {
  return { ok: true as const, verdict, model: 'gpt-5.6-luna', epoch: 'gpt-5.6-luna:v1', inputHash: 'h1', inputTokens: 100, outputTokens: 50, costUsd: 0.001, cached: false }
}

function resetAll(): void {
  for (const m of [mockSend, mockGetConfig, mockPostingFindById, mockPostingUpdateOne, mockPostingFind, mockSourceFind, mockCycleCreate]) m.mockReset()
  for (const m of Object.values(mockRedis)) (m as ReturnType<typeof vi.fn>).mockReset()
  mockGetConfig.mockResolvedValue({ ...CFG_ON })
  mockSourceFind.mockReturnValue({ select: () => ({ lean: () => Promise.resolve([]) }) })
  mockPostingUpdateOne.mockResolvedValue({})
  mockCycleCreate.mockResolvedValue({})
  mockRedis.get.mockResolvedValue(null)
  mockRedis.incr.mockResolvedValue(2)
  mockRedis.incrbyfloat.mockResolvedValue('1')
}

describe('runEvaluatePostingsHandler (§4.5 worker)', () => {
  it('collection disabled = DATA switch off → complete no-op', async () => {
    resetAll()
    mockGetConfig.mockResolvedValue({ ...CFG_ON, collectionEnabled: false })
    const r = await runEvaluatePostingsHandler({ data: { postingIds: ['p1'] } }, step)
    expect(r).toEqual({ skipped: 'collection-disabled' })
    expect(mockPostingFindById).not.toHaveBeenCalled()
  })

  it('shadow mode: verdict persisted, fraud+0.1 does NOT close the row (enforce off)', async () => {
    resetAll()
    mockPostingFindById.mockReturnValue({ lean: () => Promise.resolve(posting()) })
    const r = await runEvaluatePostingsHandler(
      { data: { postingIds: ['p1'] } }, step, { evaluateFn: vi.fn().mockResolvedValue(okOutcome()) as never }
    )
    expect(r).toMatchObject({ evaluated: 1, scored: 1, breakerTripped: false })
    const set = mockPostingUpdateOne.mock.calls[0][1].$set
    expect(set.llmVerdict).toMatchObject({ status: 'scored', verdict: 'fraud', verdictInputHash: 'h1', epoch: 'gpt-5.6-luna:v1', attempts: 1, disagreesWithRules: true })
    expect(set.status).toBeUndefined()
    expect(set.closedReason).toBeUndefined()
  })

  it('enforcement: fraud + genuineness ≤ 0.2 soft-closes (closedReason llm-verdict, never delete)', async () => {
    resetAll()
    mockGetConfig.mockResolvedValue({ ...CFG_ON, enforceEnabled: true })
    mockPostingFindById.mockReturnValue({ lean: () => Promise.resolve(posting()) })
    await runEvaluatePostingsHandler(
      { data: { postingIds: ['p1'] } }, step, { evaluateFn: vi.fn().mockResolvedValue(okOutcome()) as never }
    )
    const set = mockPostingUpdateOne.mock.calls[0][1].$set
    expect(set.status).toBe('closed')
    expect(set.closedReason).toBe('llm-verdict')
    expect(set.closedAt).toBeInstanceOf(Date)
  })

  it('skips: missing, closed, already-scored, attempts-exhausted, opted-out source', async () => {
    resetAll()
    mockSourceFind.mockReturnValue({ select: () => ({ lean: () => Promise.resolve([{ sourceId: 'optout-src' }]) }) })
    const docs: Record<string, unknown> = {
      gone: null,
      closed: posting({ _id: 'closed', status: 'closed' }),
      scored: posting({ _id: 'scored', llmVerdict: { status: 'scored', attempts: 1, verdictInputHash: FIXTURE_HASH } }),
      spent: posting({ _id: 'spent', llmVerdict: { status: 'pending', attempts: 5 } }),
      opted: posting({ _id: 'opted', provenance: [{ sourceId: 'optout-src', externalId: 'y', sourceKey: 'optout-src:y' }] }),
    }
    mockPostingFindById.mockImplementation((id: string) => ({ lean: () => Promise.resolve(docs[id] ?? null) }))
    const evaluateFn = vi.fn()
    const r = await runEvaluatePostingsHandler(
      { data: { postingIds: ['gone', 'closed', 'scored', 'spent', 'opted'] } }, step, { evaluateFn: evaluateFn as never }
    )
    expect(evaluateFn).not.toHaveBeenCalled()
    expect(r).toMatchObject({ evaluated: 0, scored: 0 })
  })

  it('verdict writes are freshness-guarded: a mid-flight merge supersedes the result (Codex #515)', async () => {
    resetAll()
    const doc = posting()
    mockPostingFindById.mockReturnValue({ lean: () => Promise.resolve(doc) })
    mockPostingUpdateOne.mockResolvedValue({ matchedCount: 0 }) // merge bumped updatedAt mid-flight
    const r = await runEvaluatePostingsHandler({ data: { postingIds: ['p1'] } }, step, { evaluateFn: vi.fn().mockResolvedValue(okOutcome()) as never })
    // filter carries the optimistic-concurrency token...
    expect(mockPostingUpdateOne.mock.calls[0][0]).toEqual({ _id: 'p1', updatedAt: doc.updatedAt })
    // ...and a superseded write is NOT counted as scored
    expect(r).toMatchObject({ evaluated: 1, scored: 0 })
    expect(mockCycleCreate.mock.calls.at(-1)![0].llm.scored).toBe(0)
  })

  it('a scored row with a STALE hash re-verdicts (§4.5 input change re-enqueues)', async () => {
    resetAll()
    mockPostingFindById.mockReturnValue({ lean: () => Promise.resolve(posting({ llmVerdict: { status: 'scored', attempts: 1, verdictInputHash: 'stale-hash' } })) })
    const evaluateFn = vi.fn().mockResolvedValue(okOutcome())
    const r = await runEvaluatePostingsHandler({ data: { postingIds: ['p1'] } }, step, { evaluateFn: evaluateFn as never })
    expect(evaluateFn).toHaveBeenCalledTimes(1)
    expect(r).toMatchObject({ evaluated: 1, scored: 1 })
  })

  it('llm-verdict tombstone whose new verdict clears the fraud bar REOPENS under enforcement', async () => {
    resetAll()
    mockGetConfig.mockResolvedValue({ ...CFG_ON, enforceEnabled: true })
    const tombstone = posting({ status: 'closed', closedReason: 'llm-verdict', llmVerdict: { status: 'pending', attempts: 1 } })
    mockPostingFindById.mockReturnValue({ lean: () => Promise.resolve(tombstone) })
    const genuine = { ...OK_VERDICT, verdict: 'genuine', reasonCodes: ['ok'], genuineness: 0.9 }
    await runEvaluatePostingsHandler({ data: { postingIds: ['p1'] } }, step, { evaluateFn: vi.fn().mockResolvedValue(okOutcome(genuine)) as never })
    const [, update] = mockPostingUpdateOne.mock.calls[0]
    expect(update.$set.status).toBe('open')
    expect(update.$unset).toEqual({ closedReason: 1, closedAt: 1 })
    // ...but a still-fraud verdict keeps the tombstone closed
    resetAll()
    mockGetConfig.mockResolvedValue({ ...CFG_ON, enforceEnabled: true })
    mockPostingFindById.mockReturnValue({ lean: () => Promise.resolve(posting({ status: 'closed', closedReason: 'llm-verdict', llmVerdict: { status: 'pending', attempts: 1 } })) })
    await runEvaluatePostingsHandler({ data: { postingIds: ['p1'] } }, step, { evaluateFn: vi.fn().mockResolvedValue(okOutcome()) as never })
    const set2 = mockPostingUpdateOne.mock.calls[0][1].$set
    expect(set2.status).toBe('closed')
  })

  it('closed rows with any OTHER reason stay ineligible', async () => {
    resetAll()
    mockPostingFindById.mockReturnValue({ lean: () => Promise.resolve(posting({ status: 'closed', closedReason: 'aged-out' })) })
    const evaluateFn = vi.fn()
    await runEvaluatePostingsHandler({ data: { postingIds: ['p1'] } }, step, { evaluateFn: evaluateFn as never })
    expect(evaluateFn).not.toHaveBeenCalled()
  })

  it('model geo strings are neutralized before persisting (no tags reach Mongo)', async () => {
    resetAll()
    mockPostingFindById.mockReturnValue({ lean: () => Promise.resolve(posting()) })
    const dirty = { ...OK_VERDICT, geo: { locations: ['<script>Pune</script>', '  '], workMode: 'onsite' } }
    await runEvaluatePostingsHandler({ data: { postingIds: ['p1'] } }, step, { evaluateFn: vi.fn().mockResolvedValue(okOutcome(dirty)) as never })
    const geo = mockPostingUpdateOne.mock.calls[0][1].$set.llmVerdict.geo
    expect(geo.locations).toEqual(['script Pune /script'])
    expect(JSON.stringify(geo)).not.toContain('<')
  })

  it('failure: attempts bump + pending + capped lastError; budget denial bumps NOTHING', async () => {
    resetAll()
    mockPostingFindById.mockReturnValue({ lean: () => Promise.resolve(posting()) })
    await runEvaluatePostingsHandler(
      { data: { postingIds: ['p1'] } }, step,
      { evaluateFn: vi.fn().mockResolvedValue({ ok: false, kind: 'timeout', message: 'x'.repeat(500), inputHash: 'h', costUsd: 0 }) as never }
    )
    const set = mockPostingUpdateOne.mock.calls[0][1].$set
    expect(set['llmVerdict.attempts']).toBe(1)
    expect(set['llmVerdict.status']).toBe('pending')
    expect((set['llmVerdict.lastError'] as string).length).toBeLessThanOrEqual(300)

    mockPostingUpdateOne.mockClear()
    await runEvaluatePostingsHandler(
      { data: { postingIds: ['p1'] } }, step,
      { evaluateFn: vi.fn().mockResolvedValue({ ok: false, kind: 'budget', message: 'daily-95pct', inputHash: 'h', costUsd: 0 }) as never }
    )
    expect(mockPostingUpdateOne).not.toHaveBeenCalled()
    // and it is NOT an error — throttling must not pollute the shadow-exit metric
    expect(mockCycleCreate.mock.calls.at(-1)![0].llm.errors).toBe(0)
  })

  it('circuit breaker: 6 consecutive failures set the degraded flag and stop the run', async () => {
    resetAll()
    const ids = ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h']
    mockPostingFindById.mockImplementation((id: string) => ({ lean: () => Promise.resolve(posting({ _id: id })) }))
    const r = await runEvaluatePostingsHandler(
      { data: { postingIds: ids } }, step,
      { evaluateFn: vi.fn().mockResolvedValue({ ok: false, kind: 'error', message: 'boom', inputHash: 'h', costUsd: 0 }) as never }
    )
    expect(r).toMatchObject({ breakerTripped: true })
    expect((r as { evaluated: number }).evaluated).toBe(6) // stopped at the breaker, not the full list
    expect(mockRedis.set).toHaveBeenCalledWith('jobs:llm:degraded', '1', 'EX', 1800)
  })

  it('cycle rows stamp the CMS-RESOLVED epoch, not the code default (Codex #515)', async () => {
    resetAll()
    vi.mocked(resolveModel).mockResolvedValueOnce({ model: 'gpt-9-zeta' } as never)
    mockPostingFindById.mockReturnValue({ lean: () => Promise.resolve(posting()) })
    await runEvaluatePostingsHandler({ data: { postingIds: ['p1'] } }, step, { evaluateFn: vi.fn().mockResolvedValue(okOutcome()) as never })
    expect(mockCycleCreate.mock.calls[0][0].llm.epoch).toBe('gpt-9-zeta:v1')
  })

  it('writes a kind:llm-verdict cycle row with the llm counter block', async () => {
    resetAll()
    mockPostingFindById.mockReturnValue({ lean: () => Promise.resolve(posting()) })
    await runEvaluatePostingsHandler(
      { data: { postingIds: ['p1'] } }, step, { evaluateFn: vi.fn().mockResolvedValue(okOutcome()) as never }
    )
    const cycle = mockCycleCreate.mock.calls[0][0]
    expect(cycle.kind).toBe('llm-verdict')
    expect(cycle.llm).toMatchObject({
      requested: 1, scored: 1,
      verdictDistribution: { genuine: 0, suspicious: 0, fraud: 1 },
      reasonCodeCounts: { fee_fraud: 1 },
      llmFlaggedCleanRow: 1,
      costUsd: 0.001,
    })
    expect(cycle.llm.bySource.jsearch.fraud).toBe(1)
  })
})

describe('runVerdictSweeperHandler (§4.5 sweeper)', () => {
  function sweepChain(rows: Array<{ _id: string }>) {
    // rows feed the FIRST find (pending/missing); the epoch-backfill find
    // that follows gets nothing.
    let calls = 0
    const limitSpy = vi.fn().mockImplementation(() => ({ select: () => ({ lean: () => Promise.resolve(calls++ === 0 ? rows : []) }) }))
    mockPostingFind.mockReturnValue({ sort: vi.fn().mockReturnValue({ limit: limitSpy }) })
    return limitSpy
  }

  it('collection disabled → skip; degraded breaker → skip', async () => {
    resetAll()
    mockGetConfig.mockResolvedValue({ ...CFG_ON, collectionEnabled: false })
    expect(await runVerdictSweeperHandler(step)).toEqual({ skipped: 'collection-disabled' })

    resetAll()
    mockRedis.get.mockImplementation((k: string) => Promise.resolve(k === 'jobs:llm:degraded' ? '1' : null))
    expect(await runVerdictSweeperHandler(step)).toEqual({ skipped: 'circuit-breaker-degraded' })
    expect(mockPostingFind).not.toHaveBeenCalled()
  })

  it('queries BOTH pending rows (attempts<5) and no-subdoc open rows, oldest-first, and enqueues in 40-id batches', async () => {
    resetAll()
    const rows = Array.from({ length: 45 }, (_, i) => ({ _id: `id${i}` }))
    sweepChain(rows)
    const r = await runVerdictSweeperHandler(step)
    expect(r).toMatchObject({ enqueued: 45, batches: 2 })
    const query = mockPostingFind.mock.calls[0][0]
    expect(query.$and[0].$or).toEqual([
      { status: 'open' },
      { status: 'closed', closedReason: 'llm-verdict' },
    ])
    expect(query.$and[1].$or).toEqual([
      { 'llmVerdict.status': 'pending', 'llmVerdict.attempts': { $lt: 5 } },
      { llmVerdict: { $exists: false }, status: 'open' },
    ])
    expect(query.$and).toHaveLength(2) // no opt-outs configured → no $nin clause
    expect(mockSend.mock.calls[0][0].name).toBe('jobs/verdict.requested')
    expect(mockSend.mock.calls[0][0].data.postingIds).toHaveLength(40)
    expect(mockSend.mock.calls[1][0].data.postingIds).toHaveLength(5)
  })

  it('epoch cutover: leftover limit backfills stale-epoch SCORED rows; current-epoch rows untouched (Codex #515)', async () => {
    resetAll()
    const limitSpies: Array<ReturnType<typeof vi.fn>> = []
    mockPostingFind.mockImplementation(() => {
      const limitSpy = vi.fn().mockReturnValue({ select: () => ({ lean: () => Promise.resolve(limitSpies.length === 1 ? [{ _id: 'pend1' }] : [{ _id: 'stale1' }, { _id: 'stale2' }]) }) })
      limitSpies.push(limitSpy)
      return { sort: vi.fn().mockReturnValue({ limit: limitSpy }) }
    })
    const r = await runVerdictSweeperHandler(step, { limit: 10 })
    expect(r).toMatchObject({ enqueued: 3 })
    // second query targets scored rows from a DIFFERENT epoch only
    const staleQuery = mockPostingFind.mock.calls[1][0]
    expect(staleQuery.$and[1]).toEqual({ 'llmVerdict.status': 'scored', 'llmVerdict.epoch': { $ne: 'gpt-5.6-luna:v1' } })
    // and consumes only the leftover limit (10 - 1 pending = 9)
    expect(limitSpies[1]).toHaveBeenCalledWith(9)
    expect(mockSend.mock.calls[0][0].data.postingIds).toEqual(['pend1', 'stale1', 'stale2'])
  })

  it('a scored row past the attempts cap still epoch-refreshes (cap is for pending failures)', async () => {
    resetAll()
    mockPostingFindById.mockReturnValue({ lean: () => Promise.resolve(posting({ llmVerdict: { status: 'scored', attempts: 5, verdictInputHash: 'stale-hash' } })) })
    const evaluateFn = vi.fn().mockResolvedValue(okOutcome())
    await runEvaluatePostingsHandler({ data: { postingIds: ['p1'] } }, step, { evaluateFn: evaluateFn as never })
    expect(evaluateFn).toHaveBeenCalledTimes(1)
  })

  it('opted-out sources are excluded IN THE QUERY — pinned pending rows cannot starve the sweep', async () => {
    resetAll()
    mockSourceFind.mockReturnValue({ select: () => ({ lean: () => Promise.resolve([{ sourceId: 'optout-src' }]) }) })
    sweepChain([])
    await runVerdictSweeperHandler(step)
    const query = mockPostingFind.mock.calls[0][0]
    expect(query.$and[2]).toEqual({ 'provenance.sourceId': { $nin: ['optout-src'] } })
  })

  it('≥80% budget softening HALVES the sweep limit', async () => {
    resetAll()
    const day = new Date().toISOString().slice(0, 10).replace(/-/g, '')
    mockRedis.get.mockImplementation((k: string) => Promise.resolve(k === `jobs:llm:verdicts:day:${day}` ? '750' : null)) // 750/900 ≈ 83%
    const limitSpy = sweepChain([])
    await runVerdictSweeperHandler(step)
    expect(limitSpy).toHaveBeenCalledWith(200) // 400 halved
  })
})
