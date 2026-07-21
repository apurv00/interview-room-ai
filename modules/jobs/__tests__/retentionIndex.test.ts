import { beforeEach, describe, expect, it, vi } from 'vitest'

const { mockIndexes, mockCreateIndex, mockCountDocuments } = vi.hoisted(() => ({
  mockIndexes: vi.fn(),
  mockCreateIndex: vi.fn(),
  mockCountDocuments: vi.fn(),
}))

vi.mock('@shared/db/models', () => ({
  JobPosting: {
    countDocuments: mockCountDocuments,
    collection: {
      indexes: mockIndexes,
      createIndex: mockCreateIndex,
    },
  },
}))

import {
  assertRetentionTtlIndex,
  prepareRetentionTtlIndex,
  retentionTtlIndexStatusOf,
} from '../services/retentionIndex'

const exact = { name: 'purgeAt_1', key: { purgeAt: 1 }, expireAfterSeconds: 0 }

beforeEach(() => {
  vi.clearAllMocks()
})

describe('Jobs retention TTL deployment gate', () => {
  it('accepts exactly one whole-collection absolute TTL index', () => {
    expect(retentionTtlIndexStatusOf([
      { name: '_id_', key: { _id: 1 } },
      exact,
    ])).toEqual({ ready: true, matchingName: 'purgeAt_1', keyIdentical: [exact] })
  })

  it('reports retained purgeAt rows even when the exact index already exists', async () => {
    mockIndexes.mockResolvedValue([{ name: '_id_', key: { _id: 1 } }, exact])
    mockCountDocuments.mockResolvedValue(2)

    await expect(prepareRetentionTtlIndex(false)).resolves.toEqual({
      ready: true,
      matchingName: 'purgeAt_1',
      keyIdentical: [exact],
      purgeAtRows: 2,
    })
    expect(mockCreateIndex).not.toHaveBeenCalled()
  })

  it.each([
    { label: 'missing', indexes: [] },
    { label: 'non-TTL', indexes: [{ name: 'purgeAt_1', key: { purgeAt: 1 } }] },
    { label: 'wrong TTL', indexes: [{ name: 'purgeAt_1', key: { purgeAt: 1 }, expireAfterSeconds: 60 }] },
    { label: 'sparse', indexes: [{ name: 'purgeAt_1', key: { purgeAt: 1 }, expireAfterSeconds: 0, sparse: true }] },
    { label: 'partial', indexes: [{ name: 'purgeAt_1', key: { purgeAt: 1 }, expireAfterSeconds: 0, partialFilterExpression: { status: 'closed' } }] },
    { label: 'unique', indexes: [{ name: 'purgeAt_1', key: { purgeAt: 1 }, expireAfterSeconds: 0, unique: true }] },
    { label: 'duplicate', indexes: [exact, { name: 'duplicate', key: { purgeAt: 1 }, expireAfterSeconds: 0 }] },
  ])('rejects $label key-identical variants', ({ indexes }) => {
    expect(() => assertRetentionTtlIndex(indexes)).toThrow(/require exactly one/)
  })

  it('creates a missing index only in explicit apply mode and re-verifies it', async () => {
    mockIndexes
      .mockResolvedValueOnce([{ name: '_id_', key: { _id: 1 } }])
      .mockResolvedValueOnce([{ name: '_id_', key: { _id: 1 } }, exact])
    mockCountDocuments.mockResolvedValue(0)
    mockCreateIndex.mockResolvedValue('purgeAt_1')

    await expect(prepareRetentionTtlIndex(true)).resolves.toEqual({
      ready: true,
      matchingName: 'purgeAt_1',
      keyIdentical: [exact],
      purgeAtRows: 0,
    })
    expect(mockCountDocuments).toHaveBeenCalledWith({ purgeAt: { $exists: true } })
    expect(mockCreateIndex).toHaveBeenCalledWith(
      { purgeAt: 1 },
      { name: 'purgeAt_1', expireAfterSeconds: 0 },
    )
  })

  it('never replaces an incompatible deployed index', async () => {
    mockIndexes.mockResolvedValue([
      { name: 'purgeAt_1', key: { purgeAt: 1 }, expireAfterSeconds: 3600 },
    ])

    await expect(prepareRetentionTtlIndex(true)).rejects.toThrow(/incompatible/)
    expect(mockCreateIndex).not.toHaveBeenCalled()
  })

  it('reports the purgeAt row count while keeping a missing-index dry-run read-only', async () => {
    mockIndexes.mockResolvedValue([{ name: '_id_', key: { _id: 1 } }])
    mockCountDocuments.mockResolvedValue(7)

    await expect(prepareRetentionTtlIndex(false)).resolves.toEqual({
      ready: false,
      matchingName: undefined,
      keyIdentical: [],
      purgeAtRows: 7,
    })
    expect(mockCountDocuments).toHaveBeenCalledWith({ purgeAt: { $exists: true } })
    expect(mockCreateIndex).not.toHaveBeenCalled()
  })

  it('refuses apply while any posting still carries purgeAt', async () => {
    mockIndexes.mockResolvedValue([{ name: '_id_', key: { _id: 1 } }])
    mockCountDocuments.mockResolvedValue(3)

    await expect(prepareRetentionTtlIndex(true)).rejects.toThrow(
      /Refusing to create Jobs retention TTL index while 3 posting\(s\) still carry purgeAt/,
    )
    expect(mockCreateIndex).not.toHaveBeenCalled()
    expect(mockIndexes).toHaveBeenCalledTimes(1)
  })
})
