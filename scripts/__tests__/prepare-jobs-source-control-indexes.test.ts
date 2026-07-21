import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  connectDB: vi.fn(),
  postingCreateIndex: vi.fn(),
  postingIndexes: vi.fn(),
  configCreateIndex: vi.fn(),
  configIndexes: vi.fn(),
  auditCreateIndex: vi.fn(),
  auditIndexes: vi.fn(),
}))

vi.mock('../../shared/db/connection', () => ({ connectDB: mocks.connectDB }))
vi.mock('../../shared/db/models', () => ({
  JobPosting: {
    collection: { createIndex: mocks.postingCreateIndex, indexes: mocks.postingIndexes },
  },
  JobSourceConfig: {
    collection: { createIndex: mocks.configCreateIndex, indexes: mocks.configIndexes },
  },
  JobSourceControlAudit: {
    collection: { createIndex: mocks.auditCreateIndex, indexes: mocks.auditIndexes },
  },
}))

import {
  prepareJobsSourceControlIndexes,
  sourceControlIndexPreparationModeOf,
} from '../prepare-jobs-source-control-indexes'

describe('Jobs source-control index preparation', () => {
  beforeEach(() => {
    vi.resetAllMocks()
    mocks.connectDB.mockResolvedValue(undefined)
    mocks.configCreateIndex.mockResolvedValue('sourceId_1')
    mocks.auditCreateIndex
      .mockResolvedValueOnce('operationId_1')
      .mockResolvedValueOnce('sourceId_1_revision_1')
    mocks.postingCreateIndex
      .mockResolvedValueOnce('sourceIds_1')
      .mockResolvedValueOnce('provenance.sourceId_1')
    mocks.configIndexes.mockResolvedValue([
      { name: 'sourceId_1', key: { sourceId: 1 }, unique: true },
    ])
    mocks.auditIndexes.mockResolvedValue([
      { name: 'operationId_1', key: { operationId: 1 }, unique: true },
      { name: 'sourceId_1_revision_1', key: { sourceId: 1, revision: 1 }, unique: true },
    ])
    mocks.postingIndexes.mockResolvedValue([
      { name: 'sourceIds_1', key: { sourceIds: 1 } },
      { name: 'provenance.sourceId_1', key: { 'provenance.sourceId': 1 } },
    ])
    vi.spyOn(console, 'log').mockImplementation(() => undefined)
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('is dry-run by default and rejects unknown flags', () => {
    expect(sourceControlIndexPreparationModeOf([])).toBe('dry-run')
    expect(sourceControlIndexPreparationModeOf(['--apply'])).toBe('apply')
    expect(() => sourceControlIndexPreparationModeOf(['--force'])).toThrow(
      'unknown argument: --force',
    )
  })

  it('does not connect or mutate indexes in dry-run mode', async () => {
    await prepareJobsSourceControlIndexes([])

    expect(mocks.connectDB).not.toHaveBeenCalled()
    expect(mocks.postingCreateIndex).not.toHaveBeenCalled()
    expect(mocks.configCreateIndex).not.toHaveBeenCalled()
    expect(mocks.auditCreateIndex).not.toHaveBeenCalled()
  })

  it('creates only the five enumerated indexes with schema automation disabled', async () => {
    await prepareJobsSourceControlIndexes(['--apply'])

    expect(mocks.connectDB).toHaveBeenCalledWith({ schemaInitialization: 'disabled' })
    expect(mocks.configCreateIndex).toHaveBeenCalledExactlyOnceWith(
      { sourceId: 1 },
      { name: 'sourceId_1', unique: true },
    )
    expect(mocks.auditCreateIndex).toHaveBeenNthCalledWith(
      1,
      { operationId: 1 },
      { name: 'operationId_1', unique: true },
    )
    expect(mocks.auditCreateIndex).toHaveBeenNthCalledWith(
      2,
      { sourceId: 1, revision: 1 },
      { name: 'sourceId_1_revision_1', unique: true },
    )
    expect(mocks.postingCreateIndex).toHaveBeenNthCalledWith(
      1,
      { sourceIds: 1 },
      { name: 'sourceIds_1' },
    )
    expect(mocks.postingCreateIndex).toHaveBeenNthCalledWith(
      2,
      { 'provenance.sourceId': 1 },
      { name: 'provenance.sourceId_1' },
    )
  })

  it('fails closed when an exact index is absent after creation', async () => {
    mocks.postingIndexes.mockResolvedValue([
      { name: 'sourceIds_1', key: { sourceIds: 1 } },
    ])

    await expect(prepareJobsSourceControlIndexes(['--apply'])).rejects.toThrow(
      'index verification failed for postings.provenance.sourceId_1',
    )
  })

  it.each([
    ['partial', { partialFilterExpression: { status: 'open' } }],
    ['sparse', { sparse: true }],
    ['hidden', { hidden: true }],
    ['collated', { collation: { locale: 'en' } }],
    ['TTL', { expireAfterSeconds: 60 }],
  ])('rejects a key-identical %s sourceIds index', async (_name, unsafeOption) => {
    mocks.postingIndexes.mockResolvedValue([
      { name: 'sourceIds_1', key: { sourceIds: 1 }, ...unsafeOption },
      { name: 'provenance.sourceId_1', key: { 'provenance.sourceId': 1 } },
    ])

    await expect(prepareJobsSourceControlIndexes(['--apply'])).rejects.toThrow(
      'index verification failed for postings.sourceIds_1',
    )
  })

  it('rejects a duplicate same-key index even when the named runtime index is safe', async () => {
    mocks.postingIndexes.mockResolvedValue([
      { name: 'sourceIds_1', key: { sourceIds: 1 } },
      { name: 'legacy_sourceIds_sparse', key: { sourceIds: 1 }, sparse: true },
      { name: 'provenance.sourceId_1', key: { 'provenance.sourceId': 1 } },
    ])

    await expect(prepareJobsSourceControlIndexes(['--apply'])).rejects.toThrow(
      'index verification failed for postings.sourceIds_1',
    )
  })

  it('rejects a safe same-key index with the wrong runtime name', async () => {
    mocks.postingIndexes.mockResolvedValue([
      { name: 'legacy_sourceIds', key: { sourceIds: 1 } },
      { name: 'provenance.sourceId_1', key: { 'provenance.sourceId': 1 } },
    ])

    await expect(prepareJobsSourceControlIndexes(['--apply'])).rejects.toThrow(
      'index verification failed for postings.sourceIds_1',
    )
  })

  it('rejects any TTL on permanent source-control audit evidence', async () => {
    mocks.auditIndexes.mockResolvedValue([
      { name: 'operationId_1', key: { operationId: 1 }, unique: true },
      { name: 'sourceId_1_revision_1', key: { sourceId: 1, revision: 1 }, unique: true },
      { name: 'createdAt_1', key: { createdAt: 1 }, expireAfterSeconds: 86_400 },
    ])

    await expect(prepareJobsSourceControlIndexes(['--apply'])).rejects.toThrow(
      'source-control audit collection has a TTL index',
    )
  })
})
