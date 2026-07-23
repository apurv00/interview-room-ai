import { describe, it, expect, vi } from 'vitest'
import { gzipSync } from 'zlib'

const {
  mockFindById,
  mockPostingExists,
  mockUpdateOne,
  mockParse,
  mockGetActiveCatalog,
  mockAppExists,
  mockIsJobsAccountActive,
  mockRedisSet,
  mockRedisEval,
} = vi.hoisted(() => ({
  mockFindById: vi.fn(),
  mockPostingExists: vi.fn(),
  mockUpdateOne: vi.fn(),
  mockParse: vi.fn(),
  mockGetActiveCatalog: vi.fn(),
  mockAppExists: vi.fn(),
  mockIsJobsAccountActive: vi.fn(),
  mockRedisSet: vi.fn(),
  mockRedisEval: vi.fn(),
}))
vi.mock('@shared/db/models', () => ({
  JobPosting: { findById: mockFindById, exists: mockPostingExists, updateOne: mockUpdateOne },
  JobApplication: { exists: mockAppExists },
}))
vi.mock('@interview', () => ({
  parseJobDescription: mockParse,
  getActiveInterviewDomainCatalog: mockGetActiveCatalog,
}))
vi.mock('@shared/services/jobsAccountFence', () => ({
  isJobsAccountActive: mockIsJobsAccountActive,
}))
vi.mock('@shared/redis', () => ({
  redis: { set: mockRedisSet, eval: mockRedisEval },
}))
vi.mock('@shared/logger', () => ({
  logger: { warn: vi.fn() },
}))

import { getOrParseXray, xrayHashOf } from '../services/xrayService'

const JD = 'Build and operate distributed payment services at scale. Must have Node.js.'
const USER_ID = '507f1f77bcf86cd799439010'
const EXTRACTED = { company: 'PhonePe', role: 'Backend Engineer', inferredDomain: 'backend', requirements: [{ id: 'req_1', category: 'technical', requirement: 'Node.js', importance: 'must-have', targetCompetencies: [] }], keyThemes: ['payments'] }
const PARSED = { rawText: JD, ...EXTRACTED } // what the parser returns; rawText must never persist
const ACTIVE_CATALOG = {
  slugs: ['backend', 'frontend', 'general', 'mobile'],
  slugSet: new Set(['backend', 'frontend', 'general', 'mobile']),
  inferenceSlugSet: new Set(['backend', 'frontend', 'general', 'mobile']),
  revision: 'jd-role-v2:test',
  authoritative: true,
  source: 'cms' as const,
}

function chain(doc: unknown) {
  mockFindById.mockReturnValue({ select: () => ({ lean: () => Promise.resolve(doc) }) })
}

function reset() {
  for (const m of [
    mockFindById,
    mockPostingExists,
    mockUpdateOne,
    mockParse,
    mockGetActiveCatalog,
    mockAppExists,
    mockIsJobsAccountActive,
    mockRedisSet,
    mockRedisEval,
  ]) m.mockReset()
  mockPostingExists.mockResolvedValue({ _id: 'j1' })
  mockUpdateOne.mockResolvedValue({ modifiedCount: 1 })
  mockParse.mockResolvedValue(PARSED)
  mockGetActiveCatalog.mockResolvedValue(ACTIVE_CATALOG)
  mockAppExists.mockResolvedValue(null)
  mockIsJobsAccountActive.mockResolvedValue(true)
  mockRedisSet.mockResolvedValue('OK')
  mockRedisEval.mockResolvedValue(1)
}

describe('getOrParseXray (ONE parse per posting, keyed by jdHash)', () => {
  it('first view parses via the interview parser and persists {parsedJD, parsedJDHash}', async () => {
    reset()
    const compressed = gzipSync(Buffer.from(JD))
    chain({ _id: 'j1', status: 'open', jdCompressed: compressed })
    const r = await getOrParseXray('j1')
    expect(r).toEqual({ parsed: EXTRACTED, cached: false })
    expect(mockParse).toHaveBeenCalledWith(JD, ACTIVE_CATALOG, expect.any(Function))
    const [filter, update] = mockUpdateOne.mock.calls[0]
    expect(filter).toEqual({
      _id: 'j1',
      status: 'open',
      jdCompressed: compressed,
      $or: [
        { parsedJDHash: { $ne: xrayHashOf(JD) } },
        { parsedJD: { $exists: false } },
        { parsedJD: null },
      ],
    })
    // rawText NEVER persists — it would duplicate the JD uncompressed and
    // outlive jdCompressed on retention-slimmed rows (Codex #518)
    expect(update.$set.parsedJD).toEqual(EXTRACTED)
    expect(update.$set.parsedJD.rawText).toBeUndefined()
    expect(update.$set.parsedJDHash).toBe(xrayHashOf(JD))
    expect(update.$set.parsedJDRoleVersion).toBe(ACTIVE_CATALOG.revision)
  })

  it('rechecks the cache snapshot after lock acquisition and never parses a winner written in the gap', async () => {
    reset()
    const compressed = gzipSync(Buffer.from(JD))
    mockFindById
      .mockReturnValueOnce({
        select: () => ({ lean: () => Promise.resolve({
          _id: 'j1',
          status: 'open',
          jdCompressed: compressed,
          parsedJD: null,
          parsedJDHash: xrayHashOf(JD),
          parsedJDRoleVersion: ACTIVE_CATALOG.revision,
        }) }),
      })
      .mockReturnValueOnce({
        select: () => ({ lean: () => Promise.resolve({
          _id: 'j1',
          status: 'open',
          jdCompressed: compressed,
          parsedJD: EXTRACTED,
          parsedJDHash: xrayHashOf(JD),
          parsedJDRoleVersion: ACTIVE_CATALOG.revision,
        }) }),
      })
    mockPostingExists
      .mockResolvedValueOnce({ _id: 'j1' })
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce({ _id: 'j1' })

    expect(await getOrParseXray('j1')).toEqual({ parsed: EXTRACTED, cached: true })
    expect(mockParse).not.toHaveBeenCalled()
    expect(mockUpdateOne).not.toHaveBeenCalled()
  })

  it('single-flights concurrent cold requests so only one invokes the parser', async () => {
    reset()
    vi.useFakeTimers()
    try {
      const compressed = gzipSync(Buffer.from(JD))
      let current = { _id: 'j1', status: 'open', jdCompressed: compressed } as Record<string, unknown>
      mockFindById.mockImplementation(() => ({
        select: () => ({ lean: () => Promise.resolve(current) }),
      }))
      mockUpdateOne.mockImplementation(async (_filter, update) => {
        current = { ...current, ...update.$set }
        return { modifiedCount: 1 }
      })

      let lockOwner: string | null = null
      let lockExpiresAt = 0
      let markContended!: () => void
      const contended = new Promise<void>((resolve) => { markContended = resolve })
      mockRedisSet.mockImplementation(async (
        _key: string,
        lockValue: string,
        _px: string,
        ttlMs: number,
      ) => {
        if (lockOwner && lockExpiresAt > Date.now()) {
          markContended()
          return null
        }
        lockOwner = lockValue
        lockExpiresAt = Date.now() + ttlMs
        return 'OK'
      })
      mockRedisEval.mockImplementation(async (
        script: string,
        _keyCount: number,
        _lockKey: string,
        lockValue: string,
        ttlMs?: number,
      ) => {
        if (lockOwner !== lockValue) return 0
        if (script.includes('pexpire')) {
          lockExpiresAt = Date.now() + Number(ttlMs)
          return 1
        }
        lockOwner = null
        lockExpiresAt = 0
        return 1
      })

      let markParseStarted!: () => void
      const parseStarted = new Promise<void>((resolve) => { markParseStarted = resolve })
      let releaseParse!: (value: typeof PARSED) => void
      mockParse.mockImplementationOnce(() => {
        markParseStarted()
        return new Promise((resolve) => { releaseParse = resolve })
      })

      const first = getOrParseXray('j1')
      await parseStarted
      await vi.advanceTimersByTimeAsync(150_000)

      const second = getOrParseXray('j1')
      await contended
      expect(mockParse).toHaveBeenCalledOnce()
      expect(mockRedisEval.mock.calls.some(([script]) => String(script).includes('pexpire'))).toBe(true)

      releaseParse(PARSED)
      const firstResult = await first
      await vi.advanceTimersByTimeAsync(500)
      const secondResult = await second

      expect(firstResult).toEqual({ parsed: EXTRACTED, cached: false })
      expect(secondResult).toEqual({ parsed: EXTRACTED, cached: true })
      expect(mockParse).toHaveBeenCalledOnce()
    } finally {
      vi.useRealTimers()
    }
  })

  it('fails closed with a retryable result when Redis cannot enforce single-flight', async () => {
    reset()
    chain({ _id: 'j1', status: 'open', jdCompressed: gzipSync(Buffer.from(JD)) })
    mockRedisSet.mockRejectedValueOnce(new Error('redis unavailable'))

    expect(await getOrParseXray('j1')).toEqual({
      parsed: {
        company: '',
        role: '',
        inferredDomain: '',
        requirements: [],
        keyThemes: [],
      },
      cached: false,
      retryable: true,
    })
    expect(mockParse).not.toHaveBeenCalled()
    expect(mockUpdateOne).not.toHaveBeenCalled()
    expect(mockRedisEval).not.toHaveBeenCalled()
  })

  it('rechecks the exact live JD after catalog work and blocks parsing after revocation', async () => {
    reset()
    const compressed = gzipSync(Buffer.from(JD))
    chain({ _id: 'j1', status: 'open', jdCompressed: compressed })
    mockPostingExists.mockResolvedValue(null)

    expect(await getOrParseXray('j1')).toBeNull()
    expect(mockPostingExists).toHaveBeenCalledWith({
      _id: 'j1',
      status: 'open',
      jdCompressed: compressed,
    })
    expect(mockParse).not.toHaveBeenCalled()
    expect(mockUpdateOne).not.toHaveBeenCalled()
  })

  it('returns null instead of a 500 when revocation denies the parser at the provider boundary', async () => {
    reset()
    const compressed = gzipSync(Buffer.from(JD))
    mockFindById
      .mockReturnValueOnce({
        select: () => ({ lean: () => Promise.resolve({
          _id: 'j1', status: 'open', jdCompressed: compressed,
        }) }),
      })
      .mockReturnValueOnce({
        select: () => ({ lean: () => Promise.resolve({
          _id: 'j1', status: 'closed', closedReason: 'source-revoked', jdCompressed: compressed,
        }) }),
      })
    mockParse.mockRejectedValueOnce(Object.assign(
      new Error('model provider precondition failed'),
      { name: 'ModelProviderPreconditionError' },
    ))

    expect(await getOrParseXray('j1')).toBeNull()
    expect(mockParse).toHaveBeenCalledOnce()
    expect(mockUpdateOne).not.toHaveBeenCalled()
  })

  it('releases its own lock before the bounded provider-precondition retry', async () => {
    reset()
    chain({ _id: 'j1', status: 'open', jdCompressed: gzipSync(Buffer.from(JD)) })
    mockParse
      .mockRejectedValueOnce(Object.assign(
        new Error('transient provider precondition'),
        { name: 'ModelProviderPreconditionError' },
      ))
      .mockResolvedValueOnce(PARSED)

    expect(await getOrParseXray('j1')).toEqual({ parsed: EXTRACTED, cached: false })
    expect(mockParse).toHaveBeenCalledTimes(2)
    expect(mockRedisSet).toHaveBeenCalledTimes(2)
    expect(mockRedisEval).toHaveBeenCalledTimes(2)
  })

  it('checks account authority at the provider preflight and never sends JD text for an inactive user', async () => {
    reset()
    const compressed = gzipSync(Buffer.from(JD))
    chain({ _id: 'j1', status: 'open', jdCompressed: compressed })
    mockIsJobsAccountActive.mockResolvedValue(false)

    expect(await getOrParseXray('j1', USER_ID)).toBeNull()

    expect(mockPostingExists).toHaveBeenCalledWith({
      _id: 'j1',
      status: 'open',
      jdCompressed: compressed,
    })
    expect(mockIsJobsAccountActive).toHaveBeenCalledWith(USER_ID)
    expect(mockParse).not.toHaveBeenCalled()
    expect(mockUpdateOne).not.toHaveBeenCalled()
  })

  it('rechecks the account inside the parser provider callback and preserves user authority on retry', async () => {
    reset()
    chain({ _id: 'j1', status: 'open', jdCompressed: gzipSync(Buffer.from(JD)) })
    mockIsJobsAccountActive
      .mockResolvedValueOnce(true)
      .mockResolvedValue(false)
    mockParse.mockImplementation(async (
      _rawText: string,
      _catalog: unknown,
      authorizeProvider: () => Promise<boolean>,
    ) => {
      if (!(await authorizeProvider())) {
        throw Object.assign(new Error('model provider precondition failed'), {
          name: 'ModelProviderPreconditionError',
        })
      }
      return PARSED
    })

    expect(await getOrParseXray('j1', USER_ID)).toBeNull()

    expect(mockParse).toHaveBeenCalledOnce()
    expect(mockIsJobsAccountActive.mock.calls.every(([userId]) => userId === USER_ID)).toBe(true)
    expect(mockUpdateOne).not.toHaveBeenCalled()
  })

  it('does not persist parser output when the account becomes inactive before the provider returns', async () => {
    reset()
    chain({ _id: 'j1', status: 'open', jdCompressed: gzipSync(Buffer.from(JD)) })
    mockIsJobsAccountActive
      .mockResolvedValueOnce(true)
      .mockResolvedValueOnce(false)

    expect(await getOrParseXray('j1', USER_ID)).toBeNull()

    expect(mockParse).toHaveBeenCalledOnce()
    expect(mockIsJobsAccountActive).toHaveBeenNthCalledWith(1, USER_ID)
    expect(mockIsJobsAccountActive).toHaveBeenNthCalledWith(2, USER_ID)
    expect(mockUpdateOne).not.toHaveBeenCalled()
  })

  it('preserves userId through a JD-version retry so deletion can stop the recursive parse', async () => {
    reset()
    const changedJd = `${JD} Current version requires Kotlin.`
    const initialCompressed = gzipSync(Buffer.from(JD))
    const changedCompressed = gzipSync(Buffer.from(changedJd))
    mockFindById
      .mockReturnValueOnce({
        select: () => ({ lean: () => Promise.resolve({
          _id: 'j1', status: 'open', jdCompressed: initialCompressed,
        }) }),
      })
      .mockReturnValueOnce({
        select: () => ({ lean: () => Promise.resolve({
          _id: 'j1', status: 'open', jdCompressed: changedCompressed,
        }) }),
      })
      .mockReturnValueOnce({
        select: () => ({ lean: () => Promise.resolve({
          _id: 'j1', status: 'open', jdCompressed: changedCompressed,
        }) }),
      })
    mockUpdateOne.mockResolvedValueOnce({ modifiedCount: 0 })
    mockIsJobsAccountActive
      .mockResolvedValueOnce(true)
      .mockResolvedValueOnce(true)
      .mockResolvedValueOnce(false)

    expect(await getOrParseXray('j1', USER_ID)).toBeNull()

    expect(mockParse).toHaveBeenCalledOnce()
    expect(mockUpdateOne).toHaveBeenCalledOnce()
    expect(mockIsJobsAccountActive).toHaveBeenCalledTimes(3)
    expect(mockIsJobsAccountActive.mock.calls.every(([userId]) => userId === USER_ID)).toBe(true)
  })

  it('does not swallow an ordinary unexpected parser exception', async () => {
    reset()
    const unexpected = new Error('unexpected parser defect')
    chain({ _id: 'j1', status: 'open', jdCompressed: gzipSync(Buffer.from(JD)) })
    mockParse.mockRejectedValueOnce(unexpected)

    await expect(getOrParseXray('j1')).rejects.toBe(unexpected)
    expect(mockUpdateOne).not.toHaveBeenCalled()
    expect(mockRedisEval).toHaveBeenCalledOnce()

    mockParse.mockResolvedValueOnce(PARSED)
    expect(await getOrParseXray('j1')).toEqual({ parsed: EXTRACTED, cached: false })
    expect(mockParse).toHaveBeenCalledTimes(2)
  })

  it('cache hit on matching hash: NO second parse, no write — the parser never runs twice for one JD', async () => {
    reset()
    chain({ _id: 'j1', status: 'open', jdCompressed: gzipSync(Buffer.from(JD)), parsedJD: EXTRACTED, parsedJDHash: xrayHashOf(JD), parsedJDRoleVersion: ACTIVE_CATALOG.revision })
    const r = await getOrParseXray('j1')
    expect(r).toEqual({ parsed: EXTRACTED, cached: true })
    expect(mockParse).not.toHaveBeenCalled()
    expect(mockUpdateOne).not.toHaveBeenCalled()
  })

  it('does not return a live cached X-ray when revocation wins during catalog lookup', async () => {
    reset()
    chain({
      _id: 'j1', status: 'open', jdCompressed: gzipSync(Buffer.from(JD)),
      parsedJD: EXTRACTED, parsedJDHash: xrayHashOf(JD),
      parsedJDRoleVersion: ACTIVE_CATALOG.revision,
    })
    mockPostingExists.mockResolvedValue(null)

    expect(await getOrParseXray('j1')).toBeNull()
    expect(mockGetActiveCatalog).toHaveBeenCalledOnce()
    expect(mockParse).not.toHaveBeenCalled()
  })

  it('refreshes a legacy role revision without replacing evidence-bound requirement ids', async () => {
    reset()
    const stableParse = {
      ...EXTRACTED,
      inferredDomain: 'frontend',
      requirements: [{ ...EXTRACTED.requirements[0], id: 'stable_req' }],
    }
    mockParse.mockResolvedValue({
      ...PARSED,
      inferredDomain: 'mobile',
      requirements: [{ ...PARSED.requirements[0], id: 'new_model_req' }],
    })
    const compressed = gzipSync(Buffer.from(JD))
    chain({
      _id: 'j1',
      status: 'open',
      jdCompressed: compressed,
      parsedJD: stableParse,
      parsedJDHash: xrayHashOf(JD),
      // Missing parsedJDRoleVersion: legacy 11-slug inference prompt.
    })

    expect(await getOrParseXray('j1')).toEqual({
      parsed: { ...stableParse, inferredDomain: 'mobile' },
      cached: false,
    })
    expect(mockUpdateOne).toHaveBeenCalledWith(
      {
        _id: 'j1',
        status: 'open',
        jdCompressed: compressed,
        parsedJDHash: xrayHashOf(JD),
        parsedJDRoleVersion: { $exists: false },
      },
      {
        $set: {
          'parsedJD.inferredDomain': 'mobile',
          parsedJDRoleVersion: ACTIVE_CATALOG.revision,
        },
      },
    )
    const update = mockUpdateOne.mock.calls[0][1]
    expect(update.$set.parsedJD).toBeUndefined()
    expect(update.$set['parsedJD.inferredDomain']).toBe('mobile')
  })

  it('does not spend a role-refresh parse when an explicit posting domain already decides Practice', async () => {
    reset()
    chain({
      _id: 'j1',
      domain: 'backend',
      status: 'open',
      jdCompressed: gzipSync(Buffer.from(JD)),
      parsedJD: EXTRACTED,
      parsedJDHash: xrayHashOf(JD),
      parsedJDRoleVersion: 'jd-role-v1:legacy',
    })

    expect(await getOrParseXray('j1')).toEqual({ parsed: EXTRACTED, cached: true })
    expect(mockParse).not.toHaveBeenCalled()
    expect(mockUpdateOne).not.toHaveBeenCalled()
  })

  it('serves stable evidence without parsing or overwriting roles during a CMS outage', async () => {
    reset()
    const stableCustomRole = { ...EXTRACTED, inferredDomain: 'custom-quant-role' }
    mockGetActiveCatalog.mockResolvedValue({
      ...ACTIVE_CATALOG,
      authoritative: false,
      source: 'seed-fallback',
      fallbackReason: 'unavailable',
    })
    chain({
      _id: 'j1',
      status: 'open',
      jdCompressed: gzipSync(Buffer.from(JD)),
      parsedJD: stableCustomRole,
      parsedJDHash: xrayHashOf(JD),
      parsedJDRoleVersion: 'jd-role-v2:custom-catalog',
    })

    expect(await getOrParseXray('j1')).toEqual({
      parsed: stableCustomRole,
      cached: true,
      retryable: true,
    })
    expect(mockParse).not.toHaveBeenCalled()
    expect(mockUpdateOne).not.toHaveBeenCalled()
  })

  it('may cache new evidence during a CMS outage but never its fallback-derived role revision', async () => {
    reset()
    mockGetActiveCatalog.mockResolvedValue({
      ...ACTIVE_CATALOG,
      authoritative: false,
      source: 'seed-fallback',
      fallbackReason: 'unavailable',
    })
    chain({ _id: 'j1', status: 'open', jdCompressed: gzipSync(Buffer.from(JD)) })

    expect(await getOrParseXray('j1')).toEqual({
      parsed: { ...EXTRACTED, inferredDomain: '' },
      cached: false,
      retryable: true,
    })
    const update = mockUpdateOne.mock.calls[0][1]
    expect(update.$set.parsedJD).toEqual({ ...EXTRACTED, inferredDomain: '' })
    expect(update.$set.parsedJDRoleVersion).toBeUndefined()
    expect(update.$unset).toEqual({ parsedJDRoleVersion: 1 })
  })

  it('prevents a slow catalog-A refresh from overwriting a newer catalog-B winner', async () => {
    reset()
    const compressed = gzipSync(Buffer.from(JD))
    const catalogA = {
      ...ACTIVE_CATALOG,
      revision: 'jd-role-v2:catalog-a',
      slugs: ['frontend'],
      slugSet: new Set(['frontend']),
      inferenceSlugSet: new Set(['frontend']),
    }
    const catalogB = {
      ...ACTIVE_CATALOG,
      revision: 'jd-role-v2:catalog-b',
      slugs: ['mobile'],
      slugSet: new Set(['mobile']),
      inferenceSlugSet: new Set(['mobile']),
    }
    let current = {
      _id: 'j1',
      status: 'open',
      jdCompressed: compressed,
      parsedJD: EXTRACTED,
      parsedJDHash: xrayHashOf(JD),
      parsedJDRoleVersion: 'jd-role-v1:legacy',
    }
    mockFindById.mockImplementation(() => ({
      select: () => ({ lean: () => Promise.resolve(current) }),
    }))
    mockGetActiveCatalog
      .mockResolvedValueOnce(catalogA)
      .mockResolvedValueOnce(catalogB)
      .mockResolvedValue(catalogB)

    let releaseCatalogA!: (value: typeof PARSED) => void
    let markCatalogAStarted!: () => void
    const catalogAStarted = new Promise<void>((resolve) => { markCatalogAStarted = resolve })
    mockParse
      .mockImplementationOnce(() => {
        markCatalogAStarted()
        return new Promise((resolve) => { releaseCatalogA = resolve })
      })
      .mockResolvedValueOnce({ ...PARSED, inferredDomain: 'mobile' })
    mockUpdateOne.mockImplementation((_filter, update) => {
      const revision = update.$set.parsedJDRoleVersion as string
      if (revision === catalogB.revision) {
        current = {
          ...current,
          parsedJD: { ...EXTRACTED, inferredDomain: 'mobile' },
          parsedJDRoleVersion: catalogB.revision,
        }
        return Promise.resolve({ modifiedCount: 1 })
      }
      return Promise.resolve({ modifiedCount: 0 })
    })

    const requestA = getOrParseXray('j1')
    await catalogAStarted
    const requestB = getOrParseXray('j1')
    expect(await requestB).toEqual({
      parsed: { ...EXTRACTED, inferredDomain: 'mobile' },
      cached: false,
    })
    releaseCatalogA({ ...PARSED, inferredDomain: 'frontend' })

    expect(await requestA).toEqual({
      parsed: { ...EXTRACTED, inferredDomain: 'mobile' },
      cached: true,
    })
    const catalogAWrite = mockUpdateOne.mock.calls.find(([, update]) => (
      update.$set.parsedJDRoleVersion === catalogA.revision
    ))
    expect(catalogAWrite?.[0].parsedJDRoleVersion).toBe('jd-role-v1:legacy')
  })

  it('a merged-in longer JD changes the hash → re-parse (stale X-ray never served)', async () => {
    reset()
    chain({ _id: 'j1', status: 'open', jdCompressed: gzipSync(Buffer.from(JD + ' Plus Kafka experience.')), parsedJD: EXTRACTED, parsedJDHash: xrayHashOf(JD) })
    const r = await getOrParseXray('j1')
    expect(r!.cached).toBe(false)
    expect(mockParse).toHaveBeenCalledTimes(1)
  })

  it('returns the persisted first-write winner when a concurrent parser loses the cache race', async () => {
    reset()
    const LOSING_PARSE = {
      ...PARSED,
      inferredDomain: 'frontend',
      requirements: [{ ...PARSED.requirements[0], id: 'losing_req' }],
    }
    const WINNING_PARSE = {
      ...EXTRACTED,
      inferredDomain: 'backend',
      requirements: [{ ...EXTRACTED.requirements[0], id: 'winning_req' }],
    }
    mockParse.mockResolvedValue(LOSING_PARSE)
    mockUpdateOne.mockResolvedValue({ modifiedCount: 0 })
    mockFindById
      .mockReturnValueOnce({
        select: () => ({ lean: () => Promise.resolve({
          _id: 'j1',
          status: 'open',
          jdCompressed: gzipSync(Buffer.from(JD)),
        }) }),
      })
      .mockReturnValueOnce({
        select: () => ({ lean: () => Promise.resolve({
          _id: 'j1',
          status: 'open',
          jdCompressed: gzipSync(Buffer.from(JD)),
          parsedJD: WINNING_PARSE,
          parsedJDHash: xrayHashOf(JD),
          parsedJDRoleVersion: ACTIVE_CATALOG.revision,
        }) }),
      })

    expect(await getOrParseXray('j1')).toEqual({
      parsed: WINNING_PARSE,
      cached: true,
    })
  })

  it('does not return a reconcile winner when revocation lands during the final catalog lookup', async () => {
    reset()
    const compressed = gzipSync(Buffer.from(JD))
    mockUpdateOne.mockResolvedValue({ modifiedCount: 0 })
    mockPostingExists
      .mockResolvedValueOnce({ _id: 'j1' }) // parser boundary
      .mockResolvedValueOnce({ _id: 'j1' }) // exact snapshot after lock acquisition
      .mockResolvedValueOnce(null) // exact snapshot after reconcile catalog
    mockFindById
      .mockReturnValueOnce({
        select: () => ({ lean: () => Promise.resolve({
          _id: 'j1', status: 'open', jdCompressed: compressed,
        }) }),
      })
      .mockReturnValueOnce({
        select: () => ({ lean: () => Promise.resolve({
          _id: 'j1', status: 'open', jdCompressed: compressed,
          parsedJD: EXTRACTED,
          parsedJDHash: xrayHashOf(JD),
          parsedJDRoleVersion: ACTIVE_CATALOG.revision,
        }) }),
      })

    expect(await getOrParseXray('j1')).toBeNull()
    expect(mockPostingExists).toHaveBeenCalledTimes(3)
  })

  it('returns null when the posting closes while parsing', async () => {
    reset()
    const compressed = gzipSync(Buffer.from(JD))
    mockUpdateOne.mockResolvedValue({ modifiedCount: 0 })
    mockFindById
      .mockReturnValueOnce({
        select: () => ({ lean: () => Promise.resolve({
          _id: 'j1', status: 'open', jdCompressed: compressed,
        }) }),
      })
      .mockReturnValueOnce({
        select: () => ({ lean: () => Promise.resolve({
          _id: 'j1', status: 'closed', jdCompressed: compressed,
        }) }),
      })

    expect(await getOrParseXray('j1')).toBeNull()
  })

  it('retries once against the current JD when the body changes while parsing', async () => {
    reset()
    const changedJd = `${JD} Current version requires Kotlin.`
    const initialCompressed = gzipSync(Buffer.from(JD))
    const changedCompressed = gzipSync(Buffer.from(changedJd))
    const parsedFor = (rawText: string) => ({
      ...PARSED,
      rawText,
      inferredDomain: rawText === changedJd ? 'mobile' : 'backend',
      requirements: [{
        ...PARSED.requirements[0],
        id: rawText === changedJd ? 'current_req' : 'stale_req',
      }],
    })
    mockParse.mockImplementation((rawText: string) => Promise.resolve(parsedFor(rawText)))
    mockUpdateOne
      .mockResolvedValueOnce({ modifiedCount: 0 })
      .mockResolvedValueOnce({ modifiedCount: 1 })
    mockFindById
      .mockReturnValueOnce({
        select: () => ({ lean: () => Promise.resolve({
          _id: 'j1', status: 'open', jdCompressed: initialCompressed,
        }) }),
      })
      .mockReturnValueOnce({
        select: () => ({ lean: () => Promise.resolve({
          _id: 'j1', status: 'open', jdCompressed: changedCompressed,
        }) }),
      })
      .mockReturnValueOnce({
        select: () => ({ lean: () => Promise.resolve({
          _id: 'j1', status: 'open', jdCompressed: changedCompressed,
        }) }),
      })

    expect(await getOrParseXray('j1')).toEqual({
      parsed: {
        ...EXTRACTED,
        inferredDomain: 'mobile',
        requirements: [{ ...EXTRACTED.requirements[0], id: 'current_req' }],
      },
      cached: false,
    })
    expect(mockParse.mock.calls.map(([rawText]) => rawText)).toEqual([JD, changedJd])
  })

  it('SHORT JDs still cache — the repost hash floor must never cause per-view re-parses', async () => {
    reset()
    const shortJd = 'Tiny JD.' // < 100 chars: bodyHashOf would return null here
    chain({ _id: 'j1', status: 'open', jdCompressed: gzipSync(Buffer.from(shortJd)), parsedJD: EXTRACTED, parsedJDHash: xrayHashOf(shortJd), parsedJDRoleVersion: ACTIVE_CATALOG.revision })
    const r = await getOrParseXray('j1')
    expect(r!.cached).toBe(true)
    expect(mockParse).not.toHaveBeenCalled()
  })

  it('an all-empty fallback parse is served but NEVER cached — a later view retries (Codex #518)', async () => {
    reset()
    mockParse.mockResolvedValue({ rawText: JD, company: '', role: '', inferredDomain: '', requirements: [], keyThemes: [] })
    chain({ _id: 'j1', status: 'open', jdCompressed: gzipSync(Buffer.from(JD)) })
    const r = await getOrParseXray('j1')
    expect(r!.cached).toBe(false)
    expect(r!.retryable).toBe(true)
    expect(mockUpdateOne).not.toHaveBeenCalled() // nothing pinned to the hash
    // the next view gets a fresh attempt
    chain({ _id: 'j1', status: 'open', jdCompressed: gzipSync(Buffer.from(JD)) })
    await getOrParseXray('j1')
    expect(mockParse).toHaveBeenCalledTimes(2)
  })

  it('prefers a persisted same-hash winner over a concurrent empty fallback', async () => {
    reset()
    const compressed = gzipSync(Buffer.from(JD))
    mockParse.mockResolvedValue({
      rawText: JD,
      company: '',
      role: '',
      inferredDomain: '',
      requirements: [],
      keyThemes: [],
    })
    mockFindById
      .mockReturnValueOnce({
        select: () => ({ lean: () => Promise.resolve({
          _id: 'j1', status: 'open', jdCompressed: compressed,
        }) }),
      })
      .mockReturnValueOnce({
        select: () => ({ lean: () => Promise.resolve({
          _id: 'j1',
          status: 'open',
          jdCompressed: compressed,
          parsedJD: EXTRACTED,
          parsedJDHash: xrayHashOf(JD),
          parsedJDRoleVersion: ACTIVE_CATALOG.revision,
        }) }),
      })

    expect(await getOrParseXray('j1')).toEqual({ parsed: EXTRACTED, cached: true })
  })

  it('prefers same-hash persisted evidence even when its role revision is still retryable', async () => {
    reset()
    const compressed = gzipSync(Buffer.from(JD))
    const evidenceWinner = { ...EXTRACTED, inferredDomain: '' }
    mockParse.mockResolvedValue({
      rawText: JD,
      company: '',
      role: '',
      inferredDomain: '',
      requirements: [],
      keyThemes: [],
    })
    mockFindById
      .mockReturnValueOnce({
        select: () => ({ lean: () => Promise.resolve({
          _id: 'j1', status: 'open', jdCompressed: compressed,
        }) }),
      })
      .mockReturnValueOnce({
        select: () => ({ lean: () => Promise.resolve({
          _id: 'j1',
          status: 'open',
          jdCompressed: compressed,
          parsedJD: evidenceWinner,
          parsedJDHash: xrayHashOf(JD),
          // No role revision: the evidence winner could not infer a role.
        }) }),
      })

    expect(await getOrParseXray('j1')).toEqual({
      parsed: evidenceWinner,
      cached: true,
      retryable: true,
    })
  })

  it('closed X-rays remain unavailable without owner proof', async () => {
    reset()
    chain({ _id: 'j1', status: 'closed', closedReason: 'aged-out', jdCompressed: gzipSync(Buffer.from(JD)), parsedJD: EXTRACTED, parsedJDHash: xrayHashOf(JD) })
    expect(await getOrParseXray('j1')).toBeNull()
    expect(mockParse).not.toHaveBeenCalled()
  })

  it('serves only an exact cached X-ray to a normal archive owner without parser or write work', async () => {
    reset()
    mockAppExists.mockResolvedValue({ _id: 'app1' })
    chain({
      _id: 'j1', status: 'closed', closedReason: 'aged-out',
      jdCompressed: gzipSync(Buffer.from(JD)), parsedJD: EXTRACTED, parsedJDHash: xrayHashOf(JD),
      parsedJDRoleVersion: 'jd-role-v2:previous-catalog',
    })

    expect(await getOrParseXray('j1', 'u1')).toEqual({ parsed: EXTRACTED, cached: true })
    expect(mockAppExists).toHaveBeenCalledWith({ userId: 'u1', jobPostingId: 'j1' })
    expect(mockGetActiveCatalog).not.toHaveBeenCalled()
    expect(mockParse).not.toHaveBeenCalled()
    expect(mockUpdateOne).not.toHaveBeenCalled()
  })

  it('does not return archived cached evidence when revocation wins during owner proof', async () => {
    reset()
    mockAppExists.mockResolvedValue({ _id: 'app1' })
    mockPostingExists.mockResolvedValue(null)
    chain({
      _id: 'j1', status: 'closed', closedReason: 'aged-out',
      jdCompressed: gzipSync(Buffer.from(JD)), parsedJD: EXTRACTED,
      parsedJDHash: xrayHashOf(JD),
    })

    expect(await getOrParseXray('j1', 'u1')).toBeNull()
    expect(mockAppExists).toHaveBeenCalledTimes(2)
    expect(mockParse).not.toHaveBeenCalled()
  })

  it('does not return archived cached evidence when ownership disappears mid-read', async () => {
    reset()
    mockAppExists
      .mockResolvedValueOnce({ _id: 'app1' })
      .mockResolvedValueOnce(null)
    chain({
      _id: 'j1', status: 'closed', closedReason: 'aged-out',
      jdCompressed: gzipSync(Buffer.from(JD)), parsedJD: EXTRACTED,
      parsedJDHash: xrayHashOf(JD),
    })

    expect(await getOrParseXray('j1', 'u1')).toBeNull()
    expect(mockAppExists).toHaveBeenCalledTimes(2)
    expect(mockParse).not.toHaveBeenCalled()
  })

  it('never parses a cache miss or serves a restricted closed X-ray', async () => {
    reset()
    mockAppExists.mockResolvedValue({ _id: 'app1' })
    chain({ _id: 'j1', status: 'closed', closedReason: 'aged-out', jdCompressed: gzipSync(Buffer.from(JD)) })
    expect(await getOrParseXray('j1', 'u1')).toBeNull()

    reset()
    mockAppExists.mockResolvedValue({ _id: 'app1' })
    chain({
      _id: 'j1', status: 'closed', closedReason: 'source-revoked',
      jdCompressed: gzipSync(Buffer.from(JD)), parsedJD: EXTRACTED, parsedJDHash: xrayHashOf(JD),
    })
    expect(await getOrParseXray('j1', 'u1')).toBeNull()
    expect(mockAppExists).not.toHaveBeenCalled()
    expect(mockParse).not.toHaveBeenCalled()
    expect(mockUpdateOne).not.toHaveBeenCalled()
  })

  it('missing posting or empty/corrupt JD → null (route 404s; nothing to parse)', async () => {
    reset()
    chain(null)
    expect(await getOrParseXray('gone')).toBeNull()
    reset()
    chain({ _id: 'j1', status: 'open', jdCompressed: undefined })
    expect(await getOrParseXray('j1')).toBeNull()
    expect(mockParse).not.toHaveBeenCalled()
  })
})
