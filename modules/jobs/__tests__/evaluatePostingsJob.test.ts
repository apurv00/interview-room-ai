import { describe, it, expect, vi } from 'vitest'

const {
  mockSend, mockGetConfig, mockPostingFindById, mockPostingExists, mockPostingUpdateOne, mockPostingFind,
  mockSourceFind, mockCycleCreate, mockRedis, mockHasRestoredQualityDecision,
  mockRecordAutomaticQualityDecision, mockWithQualityDecisionTransaction,
  mockGetGovernedConfig, mockFenceSources, mockFenceConfig,
} = vi.hoisted(() => ({
  mockSend: vi.fn(),
  mockGetConfig: vi.fn(),
  mockPostingFindById: vi.fn(),
  mockPostingExists: vi.fn(),
  mockPostingUpdateOne: vi.fn(),
  mockPostingFind: vi.fn(),
  mockSourceFind: vi.fn(),
  mockCycleCreate: vi.fn(),
  mockHasRestoredQualityDecision: vi.fn(),
  mockRecordAutomaticQualityDecision: vi.fn(),
    mockWithQualityDecisionTransaction: vi.fn(),
    mockGetGovernedConfig: vi.fn(),
    mockFenceSources: vi.fn(),
    mockFenceConfig: vi.fn(),
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
  return {
    ...real,
    resolveModelWithAuthority: vi.fn().mockResolvedValue({
      resolved: {
        model: 'gpt-5.6-luna',
        provider: 'openai',
        maxTokens: 800,
        reasoningEffort: 'low',
        useToonInput: false,
      },
      source: 'L3-Mongo',
      authoritative: true,
    }),
    completion: vi.fn(),
  }
})
vi.mock('@shared/db/models', () => ({
  JOB_SOURCE_LINEAGE_UNKNOWN: '__legacy_unknown__',
  JobPosting: { findById: mockPostingFindById, exists: mockPostingExists, updateOne: mockPostingUpdateOne, find: mockPostingFind },
  JobSourceConfig: { find: mockSourceFind },
  JobIngestCycle: { create: mockCycleCreate },
  JobsVerdictConfig: { getConfig: mockGetConfig },
}))
vi.mock('../services/qualityDecisionService', () => ({
  fenceQualityDecisionSources: mockFenceSources,
  hasRestoredQualityDecision: mockHasRestoredQualityDecision,
  recordAutomaticQualityDecision: mockRecordAutomaticQualityDecision,
  withQualityDecisionTransaction: mockWithQualityDecisionTransaction,
}))
vi.mock('../services/verdictConfigControl', () => ({
  fenceJobsVerdictConfigRevision: mockFenceConfig,
  getJobsVerdictConfigSnapshot: mockGetGovernedConfig,
}))

import { runEvaluatePostingsHandler, runVerdictSweeperHandler } from '../jobs/evaluatePostingsJob'
import { resolveModelWithAuthority } from '@shared/services/modelRouter'
import { defaultVerdictRoute } from '../services/postingEvaluator'
import { verdictInputHash } from '../config/verdictPrompt'
import { PROMPT_VERSION, epochOf } from '../config/verdictSchema'
import { JOB_DOMAINS } from '../config/domains'

const DEFAULT_ROUTE = defaultVerdictRoute()
const DEFAULT_EPOCH = epochOf(DEFAULT_ROUTE)

// The CURRENT hash of the default posting() fixture as the worker computes it
// (empty body, greenhouse apply host, no salary, default execution epoch).
const FIXTURE_HASH = verdictInputHash({
  companyKey: 'phonepe', titleKey: 'backend engineer', locationKey: 'bengaluru',
  normalizedBody: '', applyHosts: ['boards.greenhouse.io'], salaryText: null,
  epoch: DEFAULT_EPOCH,
})

const step = { run: <T,>(_n: string, fn: () => Promise<T> | T) => Promise.resolve(fn()) }
const QUALITY_SESSION = { id: 'verdict-quality-session' }

const CFG_ON = {
  revision: 7, collectionEnabled: true, enforceEnabled: false, rankingEnabled: false,
  dailyVerdictCap: 900, dailyBudgetUsd: 2.5, monthlyBudgetUsd: 75,
  perCompanyDailyCap: 25, perSourceDailyCap: 500,
  inputUsdPerMTok: 0.5, outputUsdPerMTok: 2.0,
}

function completeSourceSubset(sourceIds: string[]) {
  return {
    $expr: {
      $setIsSubset: [
        { $cond: [{ $isArray: '$sourceIds' }, '$sourceIds', []] },
        sourceIds,
      ],
    },
  }
}

function posting(over: Record<string, unknown> = {}) {
  return {
    _id: 'p1', status: 'open', updatedAt: new Date('2026-07-14T00:00:00Z'),
    companyKey: 'phonepe', titleKey: 'backend engineer', locationKeys: ['bengaluru'],
    title: 'Backend Engineer', company: 'PhonePe', locations: ['Bengaluru'], isRemote: false,
    salaryText: null, jdCompressed: undefined,
    flags: { staffing: false, salaryConflict: false, shortJd: false, repost: false, repostCount: 0 },
    sourceIds: ['jsearch'],
    provenance: [{ sourceId: 'jsearch', externalId: 'x1', sourceKey: 'jsearch:x1', applyUrl: 'https://boards.greenhouse.io/x/1' }],
    llmVerdict: { status: 'pending', attempts: 0 },
    ...over,
  }
}

function postingQuery(value: unknown) {
  const query = {
    lean: () => Promise.resolve(value),
    session: vi.fn(),
  }
  query.session.mockReturnValue(query)
  return query
}

const OK_VERDICT = {
  verdict: 'fraud', reasonCodes: ['fee_fraud'], genuineness: 0.1, quality: 0.2, completeness: 0.4,
  domain: JOB_DOMAINS[0].id, domainConfidence: 0.9, seniority: 'fresher', fresherFriendly: true,
  geo: { locations: ['Pune'], workMode: 'onsite' },
}

function okOutcome(verdict = OK_VERDICT) {
  return { ok: true as const, verdict, model: 'gpt-5.6-luna', epoch: DEFAULT_EPOCH, inputHash: 'h1', inputTokens: 100, outputTokens: 50, costUsd: 0.001, cached: false }
}

function resetAll(): void {
  for (const m of [
    mockSend, mockGetConfig, mockPostingFindById, mockPostingExists, mockPostingUpdateOne,
    mockPostingFind, mockSourceFind, mockCycleCreate, mockHasRestoredQualityDecision,
    mockRecordAutomaticQualityDecision, mockWithQualityDecisionTransaction,
    mockGetGovernedConfig, mockFenceSources, mockFenceConfig,
  ]) m.mockReset()
  for (const m of Object.values(mockRedis)) (m as ReturnType<typeof vi.fn>).mockReset()
  mockGetConfig.mockResolvedValue({ ...CFG_ON })
  mockGetGovernedConfig.mockImplementation(() => mockGetConfig())
  mockFenceSources.mockResolvedValue(undefined)
  mockFenceConfig.mockResolvedValue(true)
  mockSourceFind.mockImplementation((filter: Record<string, unknown>) => ({
    select: () => ({
      lean: () => Promise.resolve(
        'sourceId' in filter
          ? [{
            sourceId: 'jsearch',
            health: 'active',
            llmVerdictOptOut: false,
            controlRevision: 2,
            operationalRevision: 5,
          }]
          : filter.llmVerdictOptOut === true
            ? []
            : [{
                sourceId: 'jsearch',
                health: 'active',
                llmVerdictOptOut: false,
              }]
      ),
    }),
  }))
  mockPostingExists.mockResolvedValue({ _id: 'p1' })
  mockPostingUpdateOne.mockResolvedValue({})
  mockCycleCreate.mockResolvedValue({})
  mockHasRestoredQualityDecision.mockResolvedValue(false)
  mockRecordAutomaticQualityDecision.mockResolvedValue({
    decisionKey: `quality:v1:${'b'.repeat(64)}`,
    inserted: true,
  })
  mockWithQualityDecisionTransaction.mockImplementation(
    (work: (session: unknown) => Promise<unknown>) => work(QUALITY_SESSION),
  )
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

  it('fails closed before posting access when the model route is non-authoritative', async () => {
    resetAll()
    vi.mocked(resolveModelWithAuthority).mockResolvedValueOnce({
      resolved: DEFAULT_ROUTE,
      source: 'cold-defaults-synthetic',
      authoritative: false,
    })

    await expect(runEvaluatePostingsHandler(
      { data: { postingIds: ['p1'] } },
      step,
    )).rejects.toThrow('authoritative Jobs verdict route is unavailable')
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
    expect(set.llmVerdict).toMatchObject({ status: 'scored', verdict: 'fraud', verdictInputHash: 'h1', epoch: DEFAULT_EPOCH, attempts: 1, disagreesWithRules: true })
    expect(set.status).toBeUndefined()
    expect(set.closedReason).toBeUndefined()
    expect(mockWithQualityDecisionTransaction).not.toHaveBeenCalled()
    expect(mockRecordAutomaticQualityDecision).not.toHaveBeenCalled()
  })

  it.each([
    [['optout-src'], []],
    [['__legacy_unknown__'], [{ sourceId: 'jsearch', externalId: 'x1', sourceKey: 'jsearch:x1' }]],
  ])('never sends opted-out or unknown durable lineage to the model', async (sourceIds, provenance) => {
    resetAll()
    mockSourceFind.mockReturnValue({ select: () => ({ lean: () => Promise.resolve([{ sourceId: 'optout-src' }]) }) })
    mockPostingFindById.mockReturnValue({ lean: () => Promise.resolve(posting({ sourceIds, provenance })) })
    const evaluateFn = vi.fn()

    const result = await runEvaluatePostingsHandler(
      { data: { postingIds: ['p1'] } },
      step,
      { evaluateFn: evaluateFn as never },
    )

    expect(result).toMatchObject({ evaluated: 0, scored: 0 })
    expect(mockCycleCreate.mock.calls[0][0].llm.skips).toMatchObject({ 'opted-out': 1 })
    expect(evaluateFn).not.toHaveBeenCalled()
  })

  it('blocks the provider and does not bump attempts when source authority changes before egress', async () => {
    resetAll()
    mockPostingFindById.mockReturnValue({ lean: () => Promise.resolve(posting()) })
    mockPostingExists.mockResolvedValue(null)
    mockSourceFind.mockImplementation((filter: Record<string, unknown>) => ({
      select: () => ({
        lean: () => Promise.resolve('sourceId' in filter
          ? [{ sourceId: 'jsearch', health: 'revoked', llmVerdictOptOut: false }]
          : []),
      }),
    }))
    const providerCall = vi.fn()
    const evaluateFn = vi.fn(async (_input, deps: { beforeModelCall?: () => Promise<boolean> }) => {
      if (!(await deps.beforeModelCall?.())) {
        return { ok: false, kind: 'authority', message: 'posting authority changed', inputHash: 'h', costUsd: 0 }
      }
      providerCall()
      return okOutcome()
    })

    const result = await runEvaluatePostingsHandler(
      { data: { postingIds: ['p1'] } },
      step,
      { evaluateFn: evaluateFn as never },
    )

    expect(providerCall).not.toHaveBeenCalled()
    expect(mockPostingUpdateOne).not.toHaveBeenCalled()
    expect(mockCycleCreate.mock.calls[0][0].llm.skips).toMatchObject({ 'authority-changed': 1 })
    expect(result).toMatchObject({ evaluated: 1, scored: 0, breakerTripped: false })
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

  it('commits the LLM close and revisioned evidence through the same quality transaction', async () => {
    resetAll()
    mockGetConfig.mockResolvedValue({ ...CFG_ON, revision: 12, enforceEnabled: true })
    mockPostingFindById.mockReturnValue({ lean: () => Promise.resolve(posting()) })

    const result = await runEvaluatePostingsHandler(
      { data: { postingIds: ['p1'] } },
      step,
      { evaluateFn: vi.fn().mockResolvedValue(okOutcome()) as never },
    )

    expect(result).toMatchObject({ scored: 1 })
    expect(mockWithQualityDecisionTransaction).toHaveBeenCalledOnce()
    expect(mockFenceConfig).toHaveBeenCalledWith(12, QUALITY_SESSION)
    expect(mockFenceSources).toHaveBeenCalledWith(
      [{ sourceId: 'jsearch', controlRevision: 2, operationalRevision: 5 }],
      QUALITY_SESSION,
      { requireVerdictEligibility: true },
    )
    expect(mockHasRestoredQualityDecision).toHaveBeenCalledWith(expect.objectContaining({
      domain: 'llm-verdict',
      action: 'close',
      subjectKey: 'p1',
      postingId: 'p1',
      inputHash: 'h1',
      policyRevision: `jobs-verdict:${PROMPT_VERSION}:reconcile-v1`,
      configRevision: 12,
      sourceRevisions: [{ sourceId: 'jsearch', controlRevision: 2, operationalRevision: 5 }],
    }), QUALITY_SESSION)
    expect(mockPostingUpdateOne.mock.calls[0][2]).toEqual({ session: QUALITY_SESSION })
    const closeSet = mockPostingUpdateOne.mock.calls[0][1].$set
    expect(closeSet).toMatchObject({ status: 'closed', closedReason: 'llm-verdict' })
    expect(mockRecordAutomaticQualityDecision).toHaveBeenCalledWith(expect.objectContaining({
      domain: 'llm-verdict',
      action: 'close',
      inputHash: 'h1',
      configRevision: 12,
      sourceRevisions: [{ sourceId: 'jsearch', controlRevision: 2, operationalRevision: 5 }],
      occurredAt: closeSet.closedAt,
      evidence: {
        kind: 'llm-verdict',
        verdict: 'fraud',
        reasonCodes: ['fee_fraud'],
        genuineness: 0.1,
        model: 'gpt-5.6-luna',
        promptVersion: PROMPT_VERSION,
        epoch: DEFAULT_EPOCH,
      },
    }), QUALITY_SESSION)
  })

  it('does not close when enforcement is disabled while the model call is in flight', async () => {
    resetAll()
    mockGetConfig
      .mockResolvedValueOnce({ ...CFG_ON, revision: 12, enforceEnabled: true })
      .mockResolvedValue({ ...CFG_ON, revision: 13, enforceEnabled: false })
    mockPostingFindById.mockReturnValue({ lean: () => Promise.resolve(posting()) })

    const result = await runEvaluatePostingsHandler(
      { data: { postingIds: ['p1'] } },
      step,
      { evaluateFn: vi.fn().mockResolvedValue(okOutcome()) as never },
    )

    expect(mockWithQualityDecisionTransaction).toHaveBeenCalledOnce()
    expect(mockGetGovernedConfig).toHaveBeenCalledWith(QUALITY_SESSION)
    expect(mockFenceConfig).not.toHaveBeenCalled()
    expect(mockFenceSources).not.toHaveBeenCalled()
    expect(mockPostingUpdateOne.mock.calls[0][1].$set).toMatchObject({
      llmVerdict: { status: 'scored', verdict: 'fraud' },
    })
    expect(mockPostingUpdateOne.mock.calls[0][1].$set.status).toBeUndefined()
    expect(mockRecordAutomaticQualityDecision).not.toHaveBeenCalled()
    expect(result).toMatchObject({ scored: 1 })
  })

  it('requeues instead of attributing enforcement to a different config revision', async () => {
    resetAll()
    mockGetConfig.mockResolvedValueOnce({ ...CFG_ON, revision: 12, enforceEnabled: true })
    mockGetGovernedConfig.mockResolvedValueOnce({ ...CFG_ON, revision: 13, enforceEnabled: true })
    mockPostingFindById.mockReturnValue({ lean: () => Promise.resolve(posting()) })

    const result = await runEvaluatePostingsHandler(
      { data: { postingIds: ['p1'] } },
      step,
      { evaluateFn: vi.fn().mockResolvedValue(okOutcome()) as never },
    )

    expect(mockFenceConfig).not.toHaveBeenCalled()
    expect(mockFenceSources).not.toHaveBeenCalled()
    expect(mockPostingUpdateOne).not.toHaveBeenCalled()
    expect(mockRecordAutomaticQualityDecision).not.toHaveBeenCalled()
    expect(mockCycleCreate.mock.calls.at(-1)![0].llm.skips).toMatchObject({ 'config-changed': 1 })
    expect(result).toMatchObject({ scored: 0 })
  })

  it('persists the score without serving changes when the config write fence is unavailable', async () => {
    resetAll()
    mockGetConfig.mockResolvedValue({ ...CFG_ON, revision: 12, enforceEnabled: true })
    mockFenceConfig.mockResolvedValue(false)
    mockPostingFindById.mockReturnValue({ lean: () => Promise.resolve(posting()) })

    const result = await runEvaluatePostingsHandler(
      { data: { postingIds: ['p1'] } },
      step,
      { evaluateFn: vi.fn().mockResolvedValue(okOutcome()) as never },
    )

    expect(result).toMatchObject({ scored: 1 })
    expect(mockPostingUpdateOne.mock.calls[0][1].$set).toMatchObject({
      llmVerdict: { status: 'scored', verdict: 'fraud' },
    })
    expect(mockPostingUpdateOne.mock.calls[0][1].$set.status).toBeUndefined()
    expect(mockFenceSources).not.toHaveBeenCalled()
    expect(mockRecordAutomaticQualityDecision).not.toHaveBeenCalled()
  })

  it('suppresses only the exact restored LLM close while still persisting its scored verdict', async () => {
    resetAll()
    mockGetConfig.mockResolvedValue({ ...CFG_ON, revision: 12, enforceEnabled: true })
    mockPostingFindById.mockReturnValue({ lean: () => Promise.resolve(posting()) })
    mockHasRestoredQualityDecision.mockResolvedValue(true)

    const result = await runEvaluatePostingsHandler(
      { data: { postingIds: ['p1'] } },
      step,
      { evaluateFn: vi.fn().mockResolvedValue(okOutcome()) as never },
    )

    const set = mockPostingUpdateOne.mock.calls[0][1].$set
    expect(set.llmVerdict).toMatchObject({ status: 'scored', verdict: 'fraud', verdictInputHash: 'h1' })
    expect(set.status).toBeUndefined()
    expect(set.closedReason).toBeUndefined()
    expect(mockPostingUpdateOne.mock.calls[0][2]).toEqual({ session: QUALITY_SESSION })
    expect(mockRecordAutomaticQualityDecision).not.toHaveBeenCalled()
    expect(result).toMatchObject({ scored: 1 })
    expect(mockCycleCreate.mock.calls.at(-1)![0].llm.softClosed).toBe(0)
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

  it('re-evaluates a same-model scored row after execution controls change', async () => {
    resetAll()
    const previousRoute = { ...DEFAULT_ROUTE, maxTokens: DEFAULT_ROUTE.maxTokens - 100 }
    const previousHash = verdictInputHash({
      companyKey: 'phonepe',
      titleKey: 'backend engineer',
      locationKey: 'bengaluru',
      normalizedBody: '',
      applyHosts: ['boards.greenhouse.io'],
      salaryText: null,
      epoch: epochOf(previousRoute),
    })
    mockPostingFindById.mockReturnValue({
      lean: () => Promise.resolve(posting({
        llmVerdict: {
          status: 'scored',
          attempts: 1,
          epoch: epochOf(previousRoute),
          verdictInputHash: previousHash,
        },
      })),
    })
    const evaluateFn = vi.fn().mockResolvedValue(okOutcome())

    await runEvaluatePostingsHandler(
      { data: { postingIds: ['p1'] } },
      step,
      { evaluateFn: evaluateFn as never },
    )

    expect(evaluateFn).toHaveBeenCalledOnce()
    expect(evaluateFn.mock.calls[0][1]).toMatchObject({ resolvedModel: DEFAULT_ROUTE })
  })

  it('uses the supported route price when the configured floor is stale', async () => {
    resetAll()
    mockPostingFindById.mockReturnValue({
      lean: () => Promise.resolve(posting()),
    })
    const evaluateFn = vi.fn().mockResolvedValue(okOutcome())

    await runEvaluatePostingsHandler(
      { data: { postingIds: ['p1'] } },
      step,
      { evaluateFn: evaluateFn as never },
    )

    expect(evaluateFn.mock.calls[0][1]).toMatchObject({
      pricing: { inputUsdPerMTok: 1, outputUsdPerMTok: 6 },
    })
  })

  it('covers the task-default fallback when a cheaper primary route is configured', async () => {
    resetAll()
    vi.mocked(resolveModelWithAuthority).mockResolvedValueOnce({
      resolved: { ...DEFAULT_ROUTE, model: 'gpt-5.4-mini' },
      source: 'L3-Mongo',
      authoritative: true,
    })
    mockPostingFindById.mockReturnValue({
      lean: () => Promise.resolve(posting()),
    })
    const evaluateFn = vi.fn().mockResolvedValue(okOutcome())

    await runEvaluatePostingsHandler(
      { data: { postingIds: ['p1'] } },
      step,
      { evaluateFn: evaluateFn as never },
    )

    expect(evaluateFn.mock.calls[0][1]).toMatchObject({
      pricing: { inputUsdPerMTok: 1, outputUsdPerMTok: 6 },
    })
  })

  it('blocks an unpriced legacy route before reading a posting or invoking the evaluator', async () => {
    resetAll()
    vi.mocked(resolveModelWithAuthority).mockResolvedValueOnce({
      resolved: { ...DEFAULT_ROUTE, model: 'unpriced-model' },
      source: 'L3-Mongo',
      authoritative: true,
    })
    const evaluateFn = vi.fn()

    await expect(runEvaluatePostingsHandler(
      { data: { postingIds: ['p1'] } },
      step,
      { evaluateFn: evaluateFn as never },
    )).rejects.toThrow('Jobs verdict pricing is unavailable for openai/unpriced-model')

    expect(mockPostingFindById).not.toHaveBeenCalled()
    expect(evaluateFn).not.toHaveBeenCalled()
  })

  it('blocks an unpriced legacy fallback before reading a posting or invoking the evaluator', async () => {
    resetAll()
    vi.mocked(resolveModelWithAuthority).mockResolvedValueOnce({
      resolved: {
        ...DEFAULT_ROUTE,
        fallbackModel: 'unpriced-fallback',
        fallbackProvider: 'openai',
      },
      source: 'L3-Mongo',
      authoritative: true,
    })
    const evaluateFn = vi.fn()

    await expect(runEvaluatePostingsHandler(
      { data: { postingIds: ['p1'] } },
      step,
      { evaluateFn: evaluateFn as never },
    )).rejects.toThrow('Jobs verdict pricing is unavailable for openai/unpriced-fallback')

    expect(mockPostingFindById).not.toHaveBeenCalled()
    expect(evaluateFn).not.toHaveBeenCalled()
  })

  it('verdict writes are freshness-guarded: a mid-flight merge supersedes the result (Codex #515)', async () => {
    resetAll()
    const doc = posting()
    mockPostingFindById.mockReturnValue({ lean: () => Promise.resolve(doc) })
    mockPostingUpdateOne.mockResolvedValue({ matchedCount: 0 }) // merge bumped updatedAt mid-flight
    const r = await runEvaluatePostingsHandler({ data: { postingIds: ['p1'] } }, step, { evaluateFn: vi.fn().mockResolvedValue(okOutcome()) as never })
    // filter carries the optimistic-concurrency token...
    expect(mockPostingUpdateOne.mock.calls[0][0]).toEqual({ _id: 'p1', updatedAt: doc.updatedAt, status: 'open' })
    // ...and a superseded write is NOT counted as scored
    expect(r).toMatchObject({ evaluated: 1, scored: 0 })
    expect(mockCycleCreate.mock.calls.at(-1)![0].llm.scored).toBe(0)
  })

  it('an exact-input safety verdict upgrades a normal archive that won the close race', async () => {
    resetAll()
    mockGetConfig.mockResolvedValue({ ...CFG_ON, enforceEnabled: true })
    const initial = posting()
    const archived = posting({
      status: 'closed',
      closedReason: 'board-poll-miss',
      updatedAt: new Date('2026-07-20T01:00:00Z'),
    })
    mockPostingFindById
      .mockReturnValueOnce(postingQuery(initial))
      .mockReturnValueOnce(postingQuery(archived))
    mockPostingUpdateOne
      .mockResolvedValueOnce({ matchedCount: 0 })
      .mockResolvedValueOnce({ matchedCount: 1 })

    const r = await runEvaluatePostingsHandler(
      { data: { postingIds: ['p1'] } },
      step,
      { evaluateFn: vi.fn().mockResolvedValue({ ...okOutcome(), inputHash: FIXTURE_HASH }) as never },
    )

    expect(mockPostingUpdateOne).toHaveBeenCalledTimes(2)
    expect(mockPostingUpdateOne.mock.calls[1][0]).toEqual({
      _id: 'p1',
      updatedAt: archived.updatedAt,
      status: 'closed',
      closedReason: 'board-poll-miss',
    })
    expect(mockPostingUpdateOne.mock.calls[1][1]).toMatchObject({
      $set: { status: 'closed', closedReason: 'llm-verdict' },
      $unset: { purgeAt: 1 },
    })
    expect(r).toMatchObject({ evaluated: 1, scored: 1 })
  })

  it('eventually restricts a pending normal archive after both initial safety CAS writes lose to benign pin updates', async () => {
    resetAll()
    mockGetConfig.mockResolvedValue({ ...CFG_ON, enforceEnabled: true })
    const initial = posting()
    const firstArchive = posting({
      status: 'closed',
      closedReason: 'aged-out',
      updatedAt: new Date('2026-07-20T01:00:00Z'),
    })
    const retryArchive = posting({
      status: 'closed',
      closedReason: 'aged-out',
      updatedAt: new Date('2026-07-20T02:00:00Z'),
    })
    mockPostingFindById
      .mockReturnValueOnce(postingQuery(initial))
      .mockReturnValueOnce(postingQuery(firstArchive))
      .mockReturnValueOnce(postingQuery(retryArchive))
    mockPostingUpdateOne
      .mockResolvedValueOnce({ matchedCount: 0 })
      .mockResolvedValueOnce({ matchedCount: 0 })
      .mockResolvedValueOnce({ matchedCount: 1 })
    const evaluateFn = vi.fn().mockResolvedValue({ ...okOutcome(), inputHash: FIXTURE_HASH })

    expect(await runEvaluatePostingsHandler(
      { data: { postingIds: ['p1'] } },
      step,
      { evaluateFn: evaluateFn as never },
    )).toMatchObject({ evaluated: 1, scored: 0 })
    expect(await runEvaluatePostingsHandler(
      { data: { postingIds: ['p1'] } },
      step,
      { evaluateFn: evaluateFn as never },
    )).toMatchObject({ evaluated: 1, scored: 1 })

    expect(mockPostingUpdateOne.mock.calls[2][0]).toEqual({
      _id: 'p1',
      updatedAt: retryArchive.updatedAt,
      status: 'closed',
      closedReason: 'aged-out',
    })
    expect(mockPostingUpdateOne.mock.calls[2][1]).toMatchObject({
      $set: { status: 'closed', closedReason: 'llm-verdict' },
      $unset: { purgeAt: 1 },
    })
  })

  it('eventually restricts a normal archive with no verdict after both safety CAS writes lose', async () => {
    resetAll()
    mockGetConfig.mockResolvedValue({ ...CFG_ON, enforceEnabled: true })
    const initial = posting({ llmVerdict: undefined })
    const firstArchive = posting({
      status: 'closed',
      closedReason: 'valid-through-expired',
      llmVerdict: undefined,
      updatedAt: new Date('2026-07-20T01:00:00Z'),
    })
    const retryArchive = posting({
      status: 'closed',
      closedReason: 'valid-through-expired',
      llmVerdict: undefined,
      updatedAt: new Date('2026-07-20T02:00:00Z'),
    })
    mockPostingFindById
      .mockReturnValueOnce(postingQuery(initial))
      .mockReturnValueOnce(postingQuery(firstArchive))
      .mockReturnValueOnce(postingQuery(retryArchive))
    mockPostingUpdateOne
      .mockResolvedValueOnce({ matchedCount: 0 })
      .mockResolvedValueOnce({ matchedCount: 0 })
      .mockResolvedValueOnce({ matchedCount: 1 })
    const evaluateFn = vi.fn().mockResolvedValue({ ...okOutcome(), inputHash: FIXTURE_HASH })

    expect(await runEvaluatePostingsHandler(
      { data: { postingIds: ['p1'] } },
      step,
      { evaluateFn: evaluateFn as never },
    )).toMatchObject({ evaluated: 1, scored: 0 })
    expect(await runEvaluatePostingsHandler(
      { data: { postingIds: ['p1'] } },
      step,
      { evaluateFn: evaluateFn as never },
    )).toMatchObject({ evaluated: 1, scored: 1 })

    expect(mockPostingUpdateOne.mock.calls[2][0]).toEqual({
      _id: 'p1',
      updatedAt: retryArchive.updatedAt,
      status: 'closed',
      closedReason: 'valid-through-expired',
    })
    expect(mockPostingUpdateOne.mock.calls[2][1]).toMatchObject({
      $set: { status: 'closed', closedReason: 'llm-verdict' },
      $unset: { purgeAt: 1 },
    })
  })

  it('does not upgrade a raced archive when the verdict inputs changed', async () => {
    resetAll()
    mockGetConfig.mockResolvedValue({ ...CFG_ON, enforceEnabled: true })
    mockPostingFindById
      .mockReturnValueOnce(postingQuery(posting()))
      .mockReturnValueOnce(postingQuery(posting({
        status: 'closed',
        closedReason: 'dead-apply-link',
        titleKey: 'changed title',
        updatedAt: new Date('2026-07-20T01:00:00Z'),
      })))
    mockPostingUpdateOne.mockResolvedValueOnce({ matchedCount: 0 })

    const r = await runEvaluatePostingsHandler(
      { data: { postingIds: ['p1'] } },
      step,
      { evaluateFn: vi.fn().mockResolvedValue({ ...okOutcome(), inputHash: FIXTURE_HASH }) as never },
    )

    expect(mockPostingUpdateOne).toHaveBeenCalledTimes(1)
    expect(r).toMatchObject({ evaluated: 1, scored: 0 })
  })

  it('never overwrites source-revoked when a legal close wins the verdict race', async () => {
    resetAll()
    mockGetConfig.mockResolvedValue({ ...CFG_ON, enforceEnabled: true })
    mockPostingFindById
      .mockReturnValueOnce(postingQuery(posting()))
      .mockReturnValueOnce(postingQuery(posting({
        status: 'closed',
        closedReason: 'source-revoked',
        updatedAt: new Date('2026-07-20T01:00:00Z'),
      })))
    mockPostingUpdateOne.mockResolvedValueOnce({ matchedCount: 0 })

    const r = await runEvaluatePostingsHandler(
      { data: { postingIds: ['p1'] } },
      step,
      { evaluateFn: vi.fn().mockResolvedValue({ ...okOutcome(), inputHash: FIXTURE_HASH }) as never },
    )

    expect(mockPostingUpdateOne).toHaveBeenCalledTimes(1)
    expect(r).toMatchObject({ evaluated: 1, scored: 0 })
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
    expect(update.$unset).toEqual({ closedReason: 1, closedAt: 1, purgeAt: 1 })
    // ...but a still-fraud verdict keeps the tombstone closed
    resetAll()
    mockGetConfig.mockResolvedValue({ ...CFG_ON, enforceEnabled: true })
    mockPostingFindById.mockReturnValue({ lean: () => Promise.resolve(posting({ status: 'closed', closedReason: 'llm-verdict', llmVerdict: { status: 'pending', attempts: 1 } })) })
    await runEvaluatePostingsHandler({ data: { postingIds: ['p1'] } }, step, { evaluateFn: vi.fn().mockResolvedValue(okOutcome()) as never })
    const update2 = mockPostingUpdateOne.mock.calls[0][1]
    const set2 = update2.$set
    expect(set2.status).toBe('closed')
    expect(update2.$unset).toEqual({ purgeAt: 1 })
  })

  it('restricted closed rows stay ineligible', async () => {
    resetAll()
    mockPostingFindById.mockReturnValue({ lean: () => Promise.resolve(posting({ status: 'closed', closedReason: 'source-revoked' })) })
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
    // …but it IS visible (2026-07-16 stall: requested-40/scored-0 cycles
    // were undiagnosable because budget skips counted NOTHING).
    expect(mockCycleCreate.mock.calls.at(-1)![0].llm.skips).toMatchObject({ 'budget:daily-95pct': 1 })
  })

  it('skip REASONS are counted per label — the cycle row names why rows did not score', async () => {
    resetAll()
    // p-closed = ineligible; p-capped = attempts cap.
    mockPostingFindById.mockImplementation((id: string) => ({
      lean: () => Promise.resolve(
        id === 'p-closed'
          ? posting({ _id: id, status: 'closed', closedReason: 'source-revoked' })
          : posting({ _id: id, llmVerdict: { status: 'pending', attempts: 5 } })
      ),
    }))
    await runEvaluatePostingsHandler(
      { data: { postingIds: ['p-closed', 'p-capped'] } }, step,
      { evaluateFn: vi.fn() as never }
    )
    const skips = mockCycleCreate.mock.calls.at(-1)![0].llm.skips
    expect(skips).toMatchObject({ ineligible: 1, 'attempts-cap': 1 })
  })

  it('Codex #545 r2: a memoized pre-deploy step output WITHOUT skips still merges (deploy-boundary replay)', async () => {
    resetAll()
    // A step runner replaying a persisted old-shape output: strip skips.
    const replayStep = {
      run: async <T,>(name: string, fn: () => Promise<T> | T): Promise<T> => {
        const out = await fn()
        if (name.startsWith('evaluate-') && out && typeof out === 'object' && 'counters' in (out as object)) {
          delete ((out as { counters: Record<string, unknown> }).counters as Record<string, unknown>).skips
        }
        return out
      },
    }
    mockPostingFindById.mockReturnValue({ lean: () => Promise.resolve(posting()) })
    const r = await runEvaluatePostingsHandler(
      { data: { postingIds: ['p1'] } }, replayStep, { evaluateFn: vi.fn().mockResolvedValue(okOutcome()) as never }
    )
    expect(r).toMatchObject({ scored: 1 }) // run FINISHES; no throw pre-write-cycle
    expect(mockCycleCreate).toHaveBeenCalled()
  })

  it('Codex #545: a sweeper-level budget denial writes a diagnosable skip cycle row', async () => {
    resetAll()
    mockRedis.get.mockImplementation((k: string) => Promise.resolve(k === 'jobs:llm:degraded' ? '1' : null))
    const r = await runVerdictSweeperHandler(step)
    expect(r).toMatchObject({ skipped: 'circuit-breaker-degraded' })
    const row = mockCycleCreate.mock.calls.at(-1)![0]
    expect(row.kind).toBe('llm-verdict')
    expect(row.llm.skips).toMatchObject({ 'sweeper:circuit-breaker-degraded': 1 })
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
    const resolvedModel = { ...DEFAULT_ROUTE, maxTokens: 1600 }
    vi.mocked(resolveModelWithAuthority).mockResolvedValueOnce({
      resolved: resolvedModel,
      source: 'L3-Mongo',
      authoritative: true,
    })
    mockPostingFindById.mockReturnValue({ lean: () => Promise.resolve(posting()) })
    await runEvaluatePostingsHandler({ data: { postingIds: ['p1'] } }, step, { evaluateFn: vi.fn().mockResolvedValue(okOutcome()) as never })
    expect(mockCycleCreate.mock.calls[0][0].llm.epoch).toBe(epochOf(resolvedModel))
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

  it('queries pending and eligible no-subdoc rows, oldest-first, and enqueues in 40-id batches', async () => {
    resetAll()
    const rows = Array.from({ length: 45 }, (_, i) => ({ _id: `id${i}` }))
    sweepChain(rows)
    const r = await runVerdictSweeperHandler(step)
    expect(r).toMatchObject({ enqueued: 45, batches: 2 })
    const query = mockPostingFind.mock.calls[0][0]
    expect(query.$and[0].$or).toEqual([
      { status: 'open' },
      { status: 'closed', closedReason: 'llm-verdict' },
      {
        status: 'closed',
        closedReason: { $in: ['board-poll-miss', 'valid-through-expired', 'aged-out', 'dead-apply-link'] },
        $or: [
          { 'llmVerdict.status': 'pending' },
          { llmVerdict: { $exists: false } },
        ],
      },
    ])
    expect(query.$and[1].$or).toEqual([
      { 'llmVerdict.status': 'pending', 'llmVerdict.attempts': { $lt: 5 } },
      { llmVerdict: { $exists: false } },
    ])
    expect(query.$and[2]).toEqual({ 'sourceIds.0': { $exists: true } })
    expect(query.$and[3]).toEqual({ sourceIds: { $nin: ['__legacy_unknown__'] } })
    expect(query.$and[4]).toEqual(completeSourceSubset(['jsearch']))
    expect(query.$and).toHaveLength(5)
    expect(mockSend.mock.calls[0][0].name).toBe('jobs/verdict.requested')
    expect(mockSend.mock.calls[0][0].data.postingIds).toHaveLength(40)
    expect(mockSend.mock.calls[1][0].data.postingIds).toHaveLength(5)
  })

  it('epoch cutover: leftover limit backfills stale-epoch SCORED rows; current-epoch rows untouched (Codex #515)', async () => {
    resetAll()
    const resolvedModel = { ...DEFAULT_ROUTE, maxTokens: DEFAULT_ROUTE.maxTokens + 800 }
    vi.mocked(resolveModelWithAuthority).mockResolvedValueOnce({
      resolved: resolvedModel,
      source: 'L3-Mongo',
      authoritative: true,
    })
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
    expect(staleQuery.$and[1]).toEqual({ 'llmVerdict.status': 'scored', 'llmVerdict.epoch': { $ne: epochOf(resolvedModel) } })
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
    mockSourceFind.mockReturnValue({
      select: () => ({
        lean: () => Promise.resolve([{
          sourceId: 'optout-src',
          health: 'active',
          llmVerdictOptOut: true,
        }]),
      }),
    })
    sweepChain([])
    await runVerdictSweeperHandler(step)
    const query = mockPostingFind.mock.calls[0][0]
    expect(query.$and[2]).toEqual({ 'sourceIds.0': { $exists: true } })
    expect(query.$and[3]).toEqual({
      sourceIds: { $nin: ['__legacy_unknown__', 'optout-src'] },
    })
    expect(query.$and[4]).toEqual(completeSourceSubset([]))
    expect(query.$and[5]).toEqual({ 'provenance.sourceId': { $nin: ['optout-src'] } })

    const staleQuery = mockPostingFind.mock.calls[1][0]
    expect(staleQuery.$and.slice(2)).toEqual(query.$and.slice(2))
  })

  it('complete-source allow-set excludes missing/revoked lineage while preserving paused sources', async () => {
    resetAll()
    mockSourceFind.mockReturnValue({
      select: () => ({
        lean: () => Promise.resolve([
          { sourceId: 'active-src', health: 'active', llmVerdictOptOut: false },
          { sourceId: 'paused-src', enabled: false, health: 'active', llmVerdictOptOut: false },
          { sourceId: 'revoked-src', health: 'revoked', llmVerdictOptOut: false },
          { sourceId: 'optout-src', health: 'active', llmVerdictOptOut: true },
        ]),
      }),
    })
    sweepChain([{ _id: 'later-eligible' }])

    const result = await runVerdictSweeperHandler(step, { limit: 10 })

    expect(result).toMatchObject({ enqueued: 1 })
    const query = mockPostingFind.mock.calls[0][0]
    expect(query.$and[2]).toEqual({ 'sourceIds.0': { $exists: true } })
    expect(query.$and[3]).toEqual({
      sourceIds: { $nin: ['__legacy_unknown__', 'optout-src'] },
    })
    // A posting carrying even one missing/revoked/opted-out source fails this
    // complete-set check and cannot occupy the oldest-first result window.
    expect(query.$and[4]).toEqual(completeSourceSubset(['active-src', 'paused-src']))
    expect(mockSend.mock.calls[0][0].data.postingIds).toEqual(['later-eligible'])
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
