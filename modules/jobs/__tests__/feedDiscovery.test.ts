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
import { titleTokens } from '../services/identityResolver'

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
    personalizationScore: 0,
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

function evaluateMongoExpression(value: unknown, postingTokens: string[]): unknown {
  if (value === '$titleTokens') return postingTokens
  if (Array.isArray(value)) return value.map((item) => evaluateMongoExpression(item, postingTokens))
  if (!value || typeof value !== 'object') return value

  const entries = Object.entries(value as Record<string, unknown>)
  if (entries.length !== 1) throw new Error('unexpected experience expression')
  const [operator, rawArgument] = entries[0]
  const argument = rawArgument as unknown[]

  switch (operator) {
    case '$ifNull': {
      const candidate = evaluateMongoExpression(argument[0], postingTokens)
      return candidate == null
        ? evaluateMongoExpression(argument[1], postingTokens)
        : candidate
    }
    case '$setIntersection': {
      const [left, right] = evaluateMongoExpression(argument, postingTokens) as string[][]
      const rightSet = new Set(right)
      return Array.from(new Set(left.filter((item) => rightSet.has(item))))
    }
    case '$size':
      return (evaluateMongoExpression(rawArgument, postingTokens) as unknown[]).length
    case '$gt': {
      const [left, right] = evaluateMongoExpression(argument, postingTokens) as number[]
      return left > right
    }
    case '$setIsSubset': {
      const [left, right] = evaluateMongoExpression(argument, postingTokens) as string[][]
      const rightSet = new Set(right)
      return left.every((item) => rightSet.has(item))
    }
    case '$in': {
      const [candidate, list] = evaluateMongoExpression(argument, postingTokens) as [string, string[]]
      return list.includes(candidate)
    }
    case '$and':
      return (evaluateMongoExpression(argument, postingTokens) as unknown[]).every(Boolean)
    case '$or':
      return (evaluateMongoExpression(argument, postingTokens) as unknown[]).some(Boolean)
    case '$not':
      return !Boolean(evaluateMongoExpression(argument[0], postingTokens))
    default:
      throw new Error(`unexpected Mongo operator ${operator}`)
  }
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
    expect(JSON.stringify(pipeline[0].$match)).not.toContain('$expr')
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

  it('uses deterministic title intent and hard-filters experience before ranking', async () => {
    aggregateResult([], 0)

    await discoverFeed({ search: 'Backend Engineer', experience: 'senior' }, NOW)

    const baseMatch = (mockAggregate.mock.calls[0][0] as Array<Record<string, unknown>>)[0].$match
    expect(JSON.stringify(baseMatch)).toContain('$all')
    expect(JSON.stringify(baseMatch)).toContain('$expr')
    expect(JSON.stringify(baseMatch)).toContain('senior')
    expect(JSON.stringify(baseMatch)).not.toContain('$regex')
    const ranking = JSON.stringify(rowsFacetPipeline())
    expect(ranking).not.toContain('senior')
    expect(ranking).not.toContain('manager')
  })

  it.each([
    ['entry', 'Entry-Level Product Manager', true],
    ['entry', 'Junior Product Manager', true],
    ['entry', 'Senior Junior Product Manager', false],
    ['entry', 'Data Entry Operator', false],
    ['entry', 'Product Manager', false],
    ['mid', 'Mid-Level Product Manager', true],
    ['mid', 'Intermediate Product Manager', true],
    ['mid', 'Junior Product Manager', false],
    ['mid', 'Senior Product Manager', false],
    ['mid', 'Product Manager', false],
    ['senior', 'Senior Product Manager', true],
    ['senior', 'Staff Product Manager', true],
    ['senior', 'HR Recruiter Hiring Staff', false],
    ['senior', 'Tech Lead', true],
    ['senior', 'Senior Junior Product Manager', false],
    ['senior', 'Senior Mid-Level Product Manager', false],
    ['senior', 'Lead Generation Executive', false],
    ['senior', 'Product Manager', false],
  ] as const)(
    'filters %s titles exactly: %s → %s',
    async (experience, title, expected) => {
      aggregateResult([], 0)

      await discoverFeed({ experience }, NOW)

      const pipeline = mockAggregate.mock.calls[0][0] as Array<Record<string, unknown>>
      const clauses = pipeline[0].$match.$and as Array<Record<string, unknown>>
      const filter = clauses.find((clause) => '$expr' in clause)?.$expr
      expect(filter).toBeTruthy()
      expect(evaluateMongoExpression(filter, titleTokens(title))).toBe(expected)
    },
  )

  it('applies the same hard experience pool to Newest while preserving chronological sorting', async () => {
    aggregateResult([], 0)

    await discoverFeed({ experience: 'entry', sort: 'newest' }, NOW)

    const pipeline = mockAggregate.mock.calls[0][0] as Array<Record<string, unknown>>
    expect(JSON.stringify(pipeline[0].$match)).toContain('$expr')
    expect(pipeline[1]).toEqual({ $sort: { postedAt: -1, _id: -1 } })
    expect(rowsFacetPipeline().filter((stage) => '$sort' in stage)).toEqual(
      expect.arrayContaining([{ $sort: { sortPostedAt: -1, _id: -1 } }]),
    )
  })

  it('prioritizes generic target-role and resume evidence before the Best-match cap without hard-filtering', async () => {
    aggregateResult([], 22)

    await discoverFeed({
      roleDomain: 'backend',
      targetRole: 'Platform Engineer',
      skills: ['Kubernetes', 'SQL'],
    }, NOW, 20)

    const pipeline = mockAggregate.mock.calls[0][0] as Array<Record<string, unknown>>
    const baseMatch = JSON.stringify(pipeline[0].$match)
    expect(baseMatch).not.toContain('backend')
    expect(baseMatch).not.toContain('platform')
    expect(baseMatch).not.toContain('kubernetes')
    const facet = pipeline.find((stage) => '$facet' in stage)?.$facet as {
      rows: Array<Record<string, unknown>>
      metadata: Array<Record<string, unknown>>
    }
    expect(facet.metadata).toEqual([{ $count: 'total' }])

    const personalizationIndex = facet.rows.findIndex((stage) =>
      '$set' in stage &&
      JSON.stringify(stage.$set).includes('"personalizationScore"') &&
      JSON.stringify(stage.$set).includes('"kubernetes"'))
    const personalizationSortIndices = facet.rows.flatMap((stage, index) =>
      '$sort' in stage && (stage.$sort as Record<string, unknown>).personalizationScore === -1
        ? [index]
        : [])
    const capIndex = facet.rows.findIndex((stage) => stage.$limit === 400)
    expect(personalizationIndex).toBeGreaterThan(-1)
    expect(personalizationSortIndices).toHaveLength(2)
    expect(personalizationSortIndices[0]).toBeGreaterThan(personalizationIndex)
    expect(capIndex).toBeGreaterThan(personalizationSortIndices[0])
    expect(personalizationSortIndices[1]).toBeGreaterThan(capIndex)
  })

  it.each([
    ['custom target role', { targetRole: 'Customer Success Manager' }, 'customer'],
    ['resume skill', { skills: ['Kubernetes'] }, 'kubernetes'],
  ])('moves %s evidence into candidate ranking before the cap', async (_name, privateQuery, evidence) => {
    aggregateResult([], 22)

    await discoverFeed(privateQuery, NOW, 20)

    const pipeline = mockAggregate.mock.calls[0][0] as Array<Record<string, unknown>>
    expect(JSON.stringify(pipeline[0].$match)).not.toContain(evidence)
    const rows = rowsFacetPipeline()
    const scoreIndex = rows.findIndex((stage) =>
      '$set' in stage && JSON.stringify(stage.$set).includes(evidence))
    const capIndex = rows.findIndex((stage) => stage.$limit === 400)
    expect(scoreIndex).toBeGreaterThan(-1)
    expect(scoreIndex).toBeLessThan(capIndex)
  })

  it('counts each normalized full resume skill once using visible title evidence', async () => {
    aggregateResult([], 22)

    await discoverFeed({
      skills: [' Product Management ', 'SQL', 'product management'],
    }, NOW, 20)

    const scoreStage = rowsFacetPipeline().find((stage) =>
      '$set' in stage && 'personalizationScore' in (stage.$set as Record<string, unknown>))
    const score = (scoreStage?.$set as { personalizationScore?: {
      $add?: Array<Record<string, unknown>>
    } })?.personalizationScore
    const skillTerm = score?.$add?.[2] as {
      $multiply?: [{ $min?: [{ $add?: unknown[] }, number] }, number]
    } | undefined
    const perSkill = skillTerm?.$multiply?.[0].$min?.[0].$add
    expect(perSkill).toHaveLength(2)
    expect(JSON.stringify(perSkill)).toContain('product management')
    expect(JSON.stringify(perSkill)).toContain('$indexOfCP')
  })

  it('authenticates and query-binds cursors before any database work', async () => {
    const privateQuery = {
      roleDomain: 'backend',
      targetRole: 'Platform Engineer',
      skills: ['Kubernetes'],
    }
    aggregateResult([row(0, { personalizationScore: 168, domain: 'backend' }), row(1)], 2)
    const first = await discoverFeed(privateQuery, NOW, 1)
    const token = first.nextCursor!
    const parts = token.split('.')
    expect(parts).toHaveLength(3)
    expect(() => JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8'))).toThrow()
    expect(parts.map((part) => Buffer.from(part, 'base64url').toString('utf8')).join(' '))
      .not.toMatch(/backend|platform|kubernetes|168/i)
    const forgedCiphertext = `${parts[1][0] === 'A' ? 'B' : 'A'}${parts[1].slice(1)}`
    const forgedToken = [parts[0], forgedCiphertext, parts[2]].join('.')

    await expect(discoverFeed({ ...privateQuery, cursor: forgedToken }, NOW, 1))
      .rejects.toBeInstanceOf(InvalidFeedCursorError)
    await expect(discoverFeed({ ...privateQuery, cursor: token, search: 'different query' }, NOW, 1))
      .rejects.toBeInstanceOf(InvalidFeedCursorError)
    await expect(discoverFeed({ cursor: token }, NOW, 1))
      .rejects.toBeInstanceOf(InvalidFeedCursorError)
    await expect(discoverFeed({ ...privateQuery, cursor: token, targetRole: 'Program Manager' }, NOW, 1))
      .rejects.toBeInstanceOf(InvalidFeedCursorError)
    await expect(discoverFeed({ ...privateQuery, cursor: token, skills: ['SQL'] }, NOW, 1))
      .rejects.toBeInstanceOf(InvalidFeedCursorError)
    await expect(discoverFeed({ ...privateQuery, cursor: token, roleDomain: 'frontend' }, NOW, 1))
      .rejects.toBeInstanceOf(InvalidFeedCursorError)
    await expect(discoverFeed({ ...privateQuery, cursor: token }, new Date(NOW.getTime() + 7 * 60 * 60_000), 1))
      .rejects.toBeInstanceOf(InvalidFeedCursorError)
    expect(mockAggregate).toHaveBeenCalledTimes(1)
  })

  it('accepts a private cursor with the same signals and compares personalization first', async () => {
    const privateQuery = {
      roleDomain: 'backend',
      targetRole: 'Platform Engineer',
      skills: ['SQL', 'Kubernetes'],
    }
    const firstRow = row(0, { personalizationScore: 176 })
    const secondRow = row(1, { personalizationScore: 60 })
    aggregateResult([firstRow, secondRow], 2)
    const first = await discoverFeed(privateQuery, NOW, 1)

    aggregateResult([secondRow], 2)
    const next = await discoverFeed({
      ...privateQuery,
      skills: ['Kubernetes', 'SQL'],
      cursor: first.nextCursor,
    }, NOW, 1)

    expect(next.rows.map((posting) => posting._id)).toEqual([secondRow._id])
    const cursorStage = rowsFacetPipeline().find((stage) => '$match' in stage)
    const alternatives = (cursorStage?.$match as { $or?: Array<Record<string, unknown>> })?.$or
    expect(alternatives?.[0]).toHaveProperty('personalizationScore')
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

    const page = await discoverFeed({
      sort: 'newest',
      roleDomain: 'pm',
      targetRole: 'Product Manager',
      skills: ['SQL'],
    }, NOW, Number.NaN)

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
    expect(serialized).not.toContain('"pm"')
    expect(serialized).not.toContain('"product"')
    expect(serialized).not.toContain('"sql"')
    expect(rowsPipeline.filter((stage) => '$sort' in stage)).toEqual(
      expect.arrayContaining([{ $sort: { sortPostedAt: -1, _id: -1 } }]),
    )
  })

  it('keeps Newest cursors reusable when private target and resume signals change', async () => {
    const firstRow = row(0)
    const secondRow = row(1)
    aggregateResult([firstRow, secondRow], 2)
    const first = await discoverFeed({
      sort: 'newest',
      roleDomain: 'backend',
      targetRole: 'Platform Engineer',
      skills: ['Kubernetes'],
    }, NOW, 1)

    aggregateResult([secondRow], 2)
    const next = await discoverFeed({
      sort: 'newest',
      cursor: first.nextCursor,
      roleDomain: 'sales',
      targetRole: 'Sales Executive',
      skills: ['CRM'],
    }, NOW, 1)

    expect(next.rows.map((posting) => posting._id)).toEqual([secondRow._id])
  })

  it.each(['', 'too-short'])('refuses a weak production cursor secret before database work', async (secret) => {
    vi.stubEnv('NODE_ENV', 'production')
    vi.stubEnv('NEXTAUTH_SECRET', secret)

    await expect(discoverFeed({}, NOW, 20)).rejects.toThrow(/NEXTAUTH_SECRET/)
    expect(mockAggregate).not.toHaveBeenCalled()
  })
})
