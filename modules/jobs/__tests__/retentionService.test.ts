import { beforeEach, describe, expect, it, vi } from 'vitest'

const {
  mockConnectDB,
  mockApplicationDistinct,
  mockPostingCount,
  mockPostingUpdateMany,
  mockPostingIndexes,
  mockSourceFind,
  mockSourceSelect,
  mockSourceLean,
  mockLoggerInfo,
  mockLoggerWarn,
  mockLoggerError,
} = vi.hoisted(() => ({
  mockConnectDB: vi.fn(),
  mockApplicationDistinct: vi.fn(),
  mockPostingCount: vi.fn(),
  mockPostingUpdateMany: vi.fn(),
  mockPostingIndexes: vi.fn(),
  mockSourceFind: vi.fn(),
  mockSourceSelect: vi.fn(),
  mockSourceLean: vi.fn(),
  mockLoggerInfo: vi.fn(),
  mockLoggerWarn: vi.fn(),
  mockLoggerError: vi.fn(),
}))

vi.mock('@shared/db/connection', () => ({ connectDB: mockConnectDB }))
vi.mock('@shared/db/models', () => ({
  JobApplication: { distinct: mockApplicationDistinct },
  JobPosting: {
    countDocuments: mockPostingCount,
    updateMany: mockPostingUpdateMany,
    collection: { indexes: mockPostingIndexes },
  },
  JobSourceConfig: { find: mockSourceFind },
}))
vi.mock('@shared/logger', () => ({
  logger: {
    info: mockLoggerInfo,
    warn: mockLoggerWarn,
    error: mockLoggerError,
  },
}))

import {
  JOB_POSTING_AGE_OUT_MS,
  JOB_POSTING_PURGE_DELAY_MS,
  agedOutPostingFilter,
  jobsCorpusCapacityStateOf,
  legacyCanonicalFreshnessExpression,
  runJobsRetentionSweep,
  tombstoneSlimmingFilter,
  validThroughExpiryFilter,
} from '../services/retentionService'

const NOW = new Date('2026-07-21T12:00:00.000Z')
const STALE_BEFORE = new Date(NOW.getTime() - JOB_POSTING_AGE_OUT_MS)
const AGEABLE_SOURCE_IDS = ['feed-source', 'public-api-source']
const LEGACY_FRESHNESS_EXPRESSION = {
  $ifNull: [
    {
      $reduce: {
        input: {
          $cond: [
            { $isArray: '$provenance' },
            '$provenance',
            [],
          ],
        },
        initialValue: null,
        in: {
          $cond: [
            { $eq: [{ $type: '$$this.lastSeenAt' }, 'date'] },
            { $max: ['$$value', '$$this.lastSeenAt'] },
            '$$value',
          ],
        },
      },
    },
    {
      $cond: [
        { $eq: [{ $type: '$createdAt' }, 'date'] },
        '$createdAt',
        NOW,
      ],
    },
  ],
}
const CANONICAL_FRESHNESS_EXPRESSION = {
  $cond: [
    { $eq: [{ $type: '$lastSeenAt' }, 'date'] },
    '$lastSeenAt',
    LEGACY_FRESHNESS_EXPRESSION,
  ],
}
const PURGEABLE_NORMAL_ARCHIVE = {
  status: 'closed',
  userReferenced: { $ne: true },
  closedReason: {
    $in: [
      'board-poll-miss',
      'valid-through-expired',
      'aged-out',
      'dead-apply-link',
    ],
  },
}
const DATED_PURGE_TARGET = {
  $dateAdd: { startDate: '$closedAt', unit: 'day', amount: 7 },
}

beforeEach(() => {
  vi.clearAllMocks()
  mockConnectDB.mockResolvedValue(undefined)
  mockApplicationDistinct.mockResolvedValue([])
  mockPostingIndexes.mockResolvedValue([
    { name: '_id_', key: { _id: 1 } },
    { name: 'purgeAt_1', key: { purgeAt: 1 }, expireAfterSeconds: 0 },
  ])
  mockSourceFind.mockReturnValue({ select: mockSourceSelect })
  mockSourceSelect.mockReturnValue({ lean: mockSourceLean })
  mockSourceLean.mockResolvedValue(AGEABLE_SOURCE_IDS.map((sourceId) => ({ sourceId })))
  mockPostingUpdateMany.mockResolvedValue({ modifiedCount: 0 })
})

describe('Jobs retention lifecycle filters', () => {
  it('uses provenance freshness, then createdAt, then now for legacy rows', () => {
    expect(legacyCanonicalFreshnessExpression(NOW)).toEqual(LEGACY_FRESHNESS_EXPRESSION)
  })

  it('keeps valid-through and age-out precedence explicit across configured lineage', () => {
    expect(validThroughExpiryFilter(NOW)).toEqual({
      status: 'open',
      validThrough: { $lte: NOW },
      $expr: {
        $lte: [
          CANONICAL_FRESHNESS_EXPRESSION,
          '$validThrough',
        ],
      },
    })

    const filter = agedOutPostingFilter(NOW, AGEABLE_SOURCE_IDS)
    expect(filter).toEqual({
      status: 'open',
      $and: [
        {
          $or: [
            { sourceIds: { $in: AGEABLE_SOURCE_IDS } },
            { 'provenance.sourceId': { $in: AGEABLE_SOURCE_IDS } },
          ],
        },
        {
          $or: [
            { validThrough: null },
            { validThrough: { $gt: NOW } },
            {
              $expr: {
                $gt: [
                  CANONICAL_FRESHNESS_EXPRESSION,
                  '$validThrough',
                ],
              },
            },
          ],
        },
        {
          $or: [
            { lastSeenAt: { $lt: STALE_BEFORE } },
            {
              $expr: {
                $and: [
                  { $ne: [{ $type: '$lastSeenAt' }, 'date'] },
                  {
                    $lt: [
                      LEGACY_FRESHNESS_EXPRESSION,
                      STALE_BEFORE,
                    ],
                  },
                ],
              },
            },
          ],
        },
      ],
    })
  })

  it('keeps pending fraud tombstone derivatives eligible for slimming', () => {
    expect(tombstoneSlimmingFilter()).toEqual({
      status: 'closed',
      closedReason: 'llm-verdict',
      $or: [
        { jdDisplayCompressed: { $exists: true } },
        { parsedJD: { $exists: true } },
        { parsedJDHash: { $exists: true } },
        { parsedJDRoleVersion: { $exists: true } },
      ],
    })
  })

  it('classifies warning and hard-stop boundaries exactly', () => {
    expect(jobsCorpusCapacityStateOf(19_999)).toBe('ok')
    expect(jobsCorpusCapacityStateOf(20_000)).toBe('warning')
    expect(jobsCorpusCapacityStateOf(24_999)).toBe('warning')
    expect(jobsCorpusCapacityStateOf(25_000)).toBe('hard-stop')
  })
})

describe('runJobsRetentionSweep', () => {
  it('is physically read-only in dry-run while reporting every due action', async () => {
    mockApplicationDistinct.mockResolvedValue(['owned-1'])
    mockPostingCount
      .mockResolvedValueOnce(1) // owner contradictions
      .mockResolvedValueOnce(4) // missing canonical freshness
      .mockResolvedValueOnce(2) // validThrough
      .mockResolvedValueOnce(3) // agedOut
      .mockResolvedValueOnce(1) // tombstones to slim
      .mockResolvedValueOnce(2) // stale non-purgeable TTL
      .mockResolvedValueOnce(2) // dated archives missing/malformed/wrong TTL
      .mockResolvedValueOnce(3) // undated archives needing a fresh TTL clock
      .mockResolvedValueOnce(20_000) // retained
      .mockResolvedValueOnce(4) // ownerPinned
      .mockResolvedValueOnce(5) // purgeScheduled
      .mockResolvedValueOnce(6) // restrictedTombstones

    const report = await runJobsRetentionSweep({ dryRun: true, now: NOW })

    expect(mockConnectDB).toHaveBeenCalledWith({ schemaInitialization: 'disabled' })
    expect(mockSourceFind).toHaveBeenCalledWith({
      kind: { $in: ['aggregator-api', 'sitemap-jsonld', 'public-api'] },
    })
    expect(mockSourceSelect).toHaveBeenCalledWith('sourceId')
    expect(mockSourceLean).toHaveBeenCalledOnce()
    expect(mockPostingUpdateMany).not.toHaveBeenCalled()
    expect(report).toEqual({
      dryRun: true,
      at: NOW.toISOString(),
      ownerPins: { applicationOwned: 1, contradictions: 1, repaired: 0 },
      freshness: { missingCanonicalFreshness: 4, backfilled: 0 },
      closures: {
        validThroughEligible: 2,
        validThroughClosed: 0,
        agedOutEligible: 3,
        agedOutClosed: 0,
      },
      tombstones: { eligibleToSlim: 1, slimmed: 0 },
      ttl: {
        indexReady: true,
        indexName: 'purgeAt_1',
        staleNonPurgeable: 2,
        staleCleared: 0,
        normalArchivesEligible: 5,
        normalArchivesScheduled: 0,
      },
      corpus: {
        retained: 20_000,
        ownerPinned: 4,
        purgeScheduled: 5,
        restrictedTombstones: 6,
        warnAt: 20_000,
        hardStopAt: 25_000,
        state: 'warning',
      },
    })
    expect(mockLoggerWarn).toHaveBeenCalledOnce()
  })

  it('heals owners, preserves pinned bodies, schedules unowned TTL, and slims tombstones', async () => {
    mockApplicationDistinct.mockResolvedValue(['owned-1'])
    mockPostingCount
      .mockResolvedValueOnce(1) // owner contradictions
      .mockResolvedValueOnce(1) // missing canonical freshness
      .mockResolvedValueOnce(2) // validThrough
      .mockResolvedValueOnce(1) // agedOut
      .mockResolvedValueOnce(1) // tombstones to slim
      .mockResolvedValueOnce(3) // stale non-purgeable TTL
      .mockResolvedValueOnce(1) // dated archive with missing/malformed/wrong TTL
      .mockResolvedValueOnce(1) // undated archive needing a fresh TTL clock
      .mockResolvedValueOnce(25_000) // retained
      .mockResolvedValueOnce(5) // ownerPinned
      .mockResolvedValueOnce(2) // purgeScheduled
      .mockResolvedValueOnce(10) // restrictedTombstones
    mockPostingUpdateMany
      .mockResolvedValueOnce({ modifiedCount: 1 }) // owner heal
      .mockResolvedValueOnce({ modifiedCount: 1 }) // freshness backfill
      .mockResolvedValueOnce({ modifiedCount: 2 }) // valid close
      .mockResolvedValueOnce({ modifiedCount: 1 }) // aged close
      .mockResolvedValueOnce({ modifiedCount: 1 }) // tombstone slim
      .mockResolvedValueOnce({ modifiedCount: 3 }) // stale TTL clear
      .mockResolvedValueOnce({ modifiedCount: 1 }) // dated TTL schedule
      .mockResolvedValueOnce({ modifiedCount: 1 }) // undated TTL schedule

    const report = await runJobsRetentionSweep({ now: NOW })

    expect(mockConnectDB).toHaveBeenCalledWith({})
    expect(report.ownerPins).toEqual({ applicationOwned: 1, contradictions: 1, repaired: 1 })
    expect(report.freshness).toEqual({ missingCanonicalFreshness: 1, backfilled: 1 })
    expect(report.closures).toEqual({
      validThroughEligible: 2,
      validThroughClosed: 2,
      agedOutEligible: 1,
      agedOutClosed: 1,
    })
    expect(report.tombstones).toEqual({ eligibleToSlim: 1, slimmed: 1 })
    expect(report.ttl).toEqual({
      indexReady: true,
      indexName: 'purgeAt_1',
      staleNonPurgeable: 3,
      staleCleared: 3,
      normalArchivesEligible: 2,
      normalArchivesScheduled: 2,
    })
    expect(report.corpus.state).toBe('hard-stop')

    const ownerHeal = mockPostingUpdateMany.mock.calls[0]
    expect(ownerHeal[1]).toEqual({
      $set: { userReferenced: true },
      $unset: { purgeAt: 1 },
    })

    const freshnessBackfill = mockPostingUpdateMany.mock.calls[1]
    expect(freshnessBackfill[0]).toEqual({
      status: 'open',
      $expr: { $ne: [{ $type: '$lastSeenAt' }, 'date'] },
    })
    expect(freshnessBackfill[1]).toEqual([{
      $set: { lastSeenAt: LEGACY_FRESHNESS_EXPRESSION },
    }])

    const validClose = mockPostingUpdateMany.mock.calls[2]
    expect(validClose[0]).toEqual(expect.objectContaining({ status: 'open' }))
    expect(validClose[1]).toEqual({
      $set: {
        status: 'closed',
        closedReason: 'valid-through-expired',
        closedAt: NOW,
      },
      $unset: { purgeAt: 1 },
    })

    const agedClose = mockPostingUpdateMany.mock.calls[3]
    expect(agedClose[0]).toEqual(agedOutPostingFilter(NOW, AGEABLE_SOURCE_IDS))
    expect(agedClose[1]).toEqual(expect.objectContaining({
      $set: expect.objectContaining({ closedReason: 'aged-out' }),
    }))

    const tombstoneSlim = mockPostingUpdateMany.mock.calls[4]
    expect(tombstoneSlim[1]).toEqual({
      $unset: {
        jdDisplayCompressed: 1,
        parsedJD: 1,
        parsedJDHash: 1,
        parsedJDRoleVersion: 1,
      },
    })
    expect(tombstoneSlim[1].$unset).not.toHaveProperty('jdCompressed')

    const staleTtlCount = mockPostingCount.mock.calls[5]
    expect(staleTtlCount[0]).toEqual({
      purgeAt: { $exists: true },
      $nor: [PURGEABLE_NORMAL_ARCHIVE],
    })

    const datedTtlCount = mockPostingCount.mock.calls[6]
    expect(datedTtlCount[0]).toEqual({
      ...PURGEABLE_NORMAL_ARCHIVE,
      closedAt: { $type: 'date' },
      $or: [
        { purgeAt: { $exists: false } },
        { $expr: { $ne: ['$purgeAt', DATED_PURGE_TARGET] } },
      ],
    })

    const undatedTtlCount = mockPostingCount.mock.calls[7]
    expect(undatedTtlCount[0]).toEqual({
      ...PURGEABLE_NORMAL_ARCHIVE,
      closedAt: { $not: { $type: 'date' } },
    })

    const datedTtl = mockPostingUpdateMany.mock.calls[6]
    expect(datedTtl[0]).toEqual(datedTtlCount[0])
    expect(datedTtl[1]).toEqual([{
      $set: {
        purgeAt: {
          ...DATED_PURGE_TARGET,
        },
      },
    }])
    const undatedTtl = mockPostingUpdateMany.mock.calls[7]
    expect(undatedTtl[0]).toEqual(undatedTtlCount[0])
    expect(undatedTtl[1]).toEqual({
      $set: {
        closedAt: NOW,
        purgeAt: new Date(NOW.getTime() + JOB_POSTING_PURGE_DELAY_MS),
      },
    })
    expect(mockLoggerError).toHaveBeenCalledOnce()
  })

  it('is idempotent once no lifecycle predicates remain eligible', async () => {
    mockPostingCount
      .mockResolvedValueOnce(0) // canonical freshness
      .mockResolvedValueOnce(0) // validThrough
      .mockResolvedValueOnce(0) // agedOut
      .mockResolvedValueOnce(0) // tombstones to slim
      .mockResolvedValueOnce(0) // stale non-purgeable TTL
      .mockResolvedValueOnce(0) // dated archives needing TTL reconciliation
      .mockResolvedValueOnce(0) // undated archives needing TTL reconciliation
      .mockResolvedValueOnce(19_999) // retained
      .mockResolvedValueOnce(8) // ownerPinned
      .mockResolvedValueOnce(0) // purgeScheduled
      .mockResolvedValueOnce(3) // restrictedTombstones

    const report = await runJobsRetentionSweep({ now: NOW })

    expect(mockPostingUpdateMany).not.toHaveBeenCalled()
    expect(report.closures).toEqual({
      validThroughEligible: 0,
      validThroughClosed: 0,
      agedOutEligible: 0,
      agedOutClosed: 0,
    })
    expect(report.tombstones).toEqual({ eligibleToSlim: 0, slimmed: 0 })
    expect(report.ttl).toEqual(expect.objectContaining({
      staleNonPurgeable: 0,
      staleCleared: 0,
      normalArchivesEligible: 0,
      normalArchivesScheduled: 0,
    }))
    expect(report.corpus.state).toBe('ok')
    expect(mockLoggerInfo).toHaveBeenCalledOnce()
  })
})
