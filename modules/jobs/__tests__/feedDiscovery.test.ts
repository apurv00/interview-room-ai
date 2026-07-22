import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import mongoose from 'mongoose'

const { mockAggregate, mockOption } = vi.hoisted(() => ({
  mockAggregate: vi.fn(),
  mockOption: vi.fn(),
}))

vi.mock('@shared/db/models', () => ({
  JobPosting: {
    aggregate: mockAggregate,
  },
}))

import { discoverFeed, InvalidFeedCursorError } from '../services/feedDiscovery'

const NOW = new Date('2026-07-22T06:30:00.000Z')

function row(index: number, over: Record<string, unknown> = {}) {
  const postedAt = new Date(NOW.getTime() - index * 60_000)
  return {
    _id: new mongoose.Types.ObjectId(),
    title: `Backend Engineer ${index}`,
    titleTokens: ['backend', 'engineer'],
    company: 'Acme',
    companyKey: 'acme',
    locations: ['Bengaluru'],
    locationKeys: ['bengaluru'],
    isRemote: index % 2 === 0,
    domain: 'backend',
    postedAt,
    provenance: [],
    flags: {},
    confidentialCompany: false,
    discoveryScore: 100 - index,
    sortPostedAt: postedAt,
    locationPreferenceMatched: false,
    ...over,
  }
}

function aggregateResult(rows: unknown[], total = rows.length) {
  mockOption.mockResolvedValueOnce([{ rows, metadata: [{ total }] }])
}

function rowsFacetPipeline(): Array<Record<string, unknown>> {
  const pipeline = mockAggregate.mock.calls.at(-1)?.[0] as Array<Record<string, unknown>>
  const facet = pipeline.find((stage) => '$facet' in stage)?.$facet as {
    rows: Array<Record<string, unknown>>
  } | undefined
  if (!facet) throw new Error('feed discovery pipeline has no facet')
  return facet.rows
}

beforeEach(() => {
  vi.stubEnv('NEXTAUTH_SECRET', 'test-secret-longer-than-sixteen-characters')
  mockAggregate.mockReset().mockReturnValue({ option: mockOption })
  mockOption.mockReset()
})

afterEach(() => {
  vi.unstubAllEnvs()
})

describe('database-backed Jobs discovery', () => {
  it('keeps exact count independent from the disclosed top-400 result window', async () => {
    aggregateResult(Array.from({ length: 21 }, (_, index) => row(index)), 912)

    const page = await discoverFeed({}, NOW, 20)

    expect(page.rows).toHaveLength(20)
    expect(page).toMatchObject({
      total: 912,
      accessibleTotal: 400,
      resultCap: 400,
      capped: true,
      hasNext: true,
      hasPrevious: false,
    })
    expect(page.nextCursor).toContain('.')
    const pipeline = mockAggregate.mock.calls[0][0]
    expect(pipeline[0]).toMatchObject({ $match: { status: 'open' } })
    const facet = pipeline.find((stage: Record<string, unknown>) => '$facet' in stage)?.$facet as {
      metadata: Array<Record<string, unknown>>
    } | undefined
    expect(facet?.metadata).toEqual([{ $count: 'total' }])
    expect(JSON.stringify(facet?.metadata)).not.toContain('discoveryScore')
    expect(rowsFacetPipeline()).toEqual(expect.arrayContaining([{ $limit: 400 }, { $limit: 21 }]))
    expect(mockOption).toHaveBeenCalledWith({ maxTimeMS: 3_000 })
  })

  it('normalizes location as a score-only preference while keeping factual filters hard', async () => {
    aggregateResult([], 0)

    await discoverFeed({
      location: ' Bangalore ',
      remote: 'remote',
      company: ' Acme ',
      freshness: '7d',
    }, NOW)

    const pipeline = mockAggregate.mock.calls[0][0]
    const baseMatch = pipeline[0].$match
    expect(baseMatch).toMatchObject({
      status: 'open',
      isRemote: true,
      postedAt: {
        $gte: new Date('2026-07-15T06:30:00.000Z'),
        $lte: NOW,
      },
    })
    expect(JSON.stringify(baseMatch)).not.toContain('locationKeys')
    expect(JSON.stringify(rowsFacetPipeline())).toContain('bengaluru')
    expect(JSON.stringify(baseMatch)).toContain('companyKey')
    expect(JSON.stringify(baseMatch)).not.toContain('$regex')
  })

  it('uses deterministic title intent without an unindexed regex scan', async () => {
    aggregateResult([], 0)

    await discoverFeed({ search: 'Backend Engineer', experience: 'senior' }, NOW)

    const baseMatch = (mockAggregate.mock.calls[0][0] as Array<Record<string, unknown>>)[0].$match
    expect(JSON.stringify(baseMatch)).toContain('$all')
    expect(JSON.stringify(baseMatch)).not.toContain('$regex')
    const ranking = JSON.stringify(rowsFacetPipeline())
    expect(ranking).toContain('senior')
    expect(ranking).not.toContain('manager')
  })

  it('authenticates and query-binds cursors before any database work', async () => {
    aggregateResult([row(0), row(1)], 2)
    const first = await discoverFeed({}, NOW, 1)
    const token = first.nextCursor!
    const [payload, signature] = token.split('.')
    const forgedSignature = `${signature[0] === 'A' ? 'B' : 'A'}${signature.slice(1)}`

    await expect(discoverFeed({ cursor: `${payload}.${forgedSignature}` }, NOW, 1))
      .rejects.toBeInstanceOf(InvalidFeedCursorError)
    await expect(discoverFeed({ cursor: token, search: 'different query' }, NOW, 1))
      .rejects.toBeInstanceOf(InvalidFeedCursorError)
    await expect(discoverFeed({ cursor: token }, new Date(NOW.getTime() + 7 * 60 * 60_000), 1))
      .rejects.toBeInstanceOf(InvalidFeedCursorError)
    expect(mockAggregate).toHaveBeenCalledTimes(1)
  })

  it('places cursor comparison after the global top-400 window and supports Previous', async () => {
    const firstRow = row(0)
    const secondRow = row(1)
    const thirdRow = row(2)
    aggregateResult([firstRow, secondRow, thirdRow], 3)
    const first = await discoverFeed({}, NOW, 2)

    aggregateResult([secondRow, firstRow], 3)
    const previous = await discoverFeed({ cursor: first.nextCursor, direction: 'before' }, NOW, 2)

    const rowsPipeline = rowsFacetPipeline()
    const capIndex = rowsPipeline.findIndex((stage) => stage.$limit === 400)
    const cursorIndex = rowsPipeline.findIndex((stage) => '$match' in stage)
    expect(capIndex).toBeGreaterThan(-1)
    expect(cursorIndex).toBeGreaterThan(capIndex)
    expect(JSON.stringify(rowsPipeline[cursorIndex])).toContain('$gt')
    expect(previous.rows.map((posting) => posting._id)).toEqual([firstRow._id, secondRow._id])
    expect(previous.hasNext).toBe(true)
  })

  it('returns the incoming cursor as an escape path when live closures empty a page', async () => {
    aggregateResult([row(0), row(1)], 2)
    const first = await discoverFeed({}, NOW, 1)

    aggregateResult([], 1)
    const emptyAfter = await discoverFeed({ cursor: first.nextCursor, direction: 'after' }, NOW, 1)
    expect(emptyAfter).toMatchObject({
      rows: [],
      hasPrevious: true,
      hasNext: false,
      previousCursor: first.nextCursor,
    })

    aggregateResult([], 1)
    const emptyBefore = await discoverFeed({ cursor: first.nextCursor, direction: 'before' }, NOW, 1)
    expect(emptyBefore).toMatchObject({
      rows: [],
      hasPrevious: false,
      hasNext: true,
      nextCursor: first.nextCursor,
    })
  })

  it('clamps invalid page size and quarantines future dates before the indexed newest window', async () => {
    aggregateResult([], 0)

    const page = await discoverFeed({ sort: 'newest' }, NOW, Number.NaN)

    expect(page.pageSize).toBe(20)
    const pipeline = mockAggregate.mock.calls.at(-1)?.[0] as Array<Record<string, unknown>>
    const baseMatch = JSON.stringify(pipeline[0].$match)
    expect(baseMatch).toContain('postedAt')
    expect(baseMatch).toContain('$type')
    expect(baseMatch).toContain('$lte')
    expect(pipeline[1]).toEqual({ $sort: { postedAt: -1, _id: -1 } })
    const rowsPipeline = rowsFacetPipeline()
    expect(rowsPipeline).toEqual(expect.arrayContaining([{ $limit: 21 }]))
    const serialized = JSON.stringify(rowsPipeline)
    expect(serialized).toContain('$lte')
    expect(serialized).toContain('1970-01-01T00:00:00.000Z')
  })

  it.each(['', 'too-short'])('refuses a weak production cursor secret before database work', async (secret) => {
    vi.stubEnv('NODE_ENV', 'production')
    vi.stubEnv('NEXTAUTH_SECRET', secret)

    await expect(discoverFeed({}, NOW, 20)).rejects.toThrow(/NEXTAUTH_SECRET/)
    expect(mockAggregate).not.toHaveBeenCalled()
  })
})
