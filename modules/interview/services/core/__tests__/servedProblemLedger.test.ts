/**
 * PR "served-problem ledger" — ledger service.
 *
 * The ledger is the server-authoritative record of served coding/system-design
 * problems. Its contract: reads NEVER throw (exclusion must never block problem
 * delivery — degrade to []), writes NEVER throw (recording must never break
 * interview start) and are idempotent ($setOnInsert against the unique
 * {userId, kind, problemId} index), and the union helper preserves
 * most-recent-first ordering so downstream prompt caps keep fresh exclusions.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'

const mocks = vi.hoisted(() => ({
  connectDB: vi.fn(),
  find: vi.fn(),
  updateOne: vi.fn(),
  warn: vi.fn(),
}))

vi.mock('@shared/db/connection', () => ({ connectDB: mocks.connectDB }))
vi.mock('@shared/db/models/ServedProblem', () => ({
  ServedProblem: { find: mocks.find, updateOne: mocks.updateOne },
}))
vi.mock('@shared/logger', () => ({
  aiLogger: { warn: mocks.warn, info: vi.fn(), error: vi.fn() },
}))

import {
  getServedProblemIds,
  recordServedProblem,
  unionMostRecentFirst,
} from '../servedProblemLedger'

const chainResolving = (rows: unknown) => ({
  sort: vi.fn().mockReturnThis(),
  limit: vi.fn().mockReturnThis(),
  select: vi.fn().mockReturnThis(),
  lean: vi.fn().mockResolvedValue(rows),
})

beforeEach(() => {
  vi.clearAllMocks()
  mocks.connectDB.mockResolvedValue(undefined)
  mocks.updateOne.mockResolvedValue({ acknowledged: true })
})

describe('getServedProblemIds', () => {
  it('returns problemIds in query order and filters empties', async () => {
    mocks.find.mockReturnValue(chainResolving([
      { problemId: 'two-sum' },
      { problemId: '' },
      { problemId: 'ai-generated-123' },
    ]))
    const ids = await getServedProblemIds('user-1', 'coding')
    expect(ids).toEqual(['two-sum', 'ai-generated-123'])
    expect(mocks.find).toHaveBeenCalledWith({ userId: 'user-1', kind: 'coding' })
  })

  it('degrades to [] when the read fails (never throws)', async () => {
    mocks.find.mockImplementation(() => { throw new Error('mongo down') })
    await expect(getServedProblemIds('user-1', 'system-design')).resolves.toEqual([])
    expect(mocks.warn).toHaveBeenCalled()
  })
})

describe('recordServedProblem', () => {
  it('upserts against the unique key: immutable fields on insert, servedAt bumped on every record', async () => {
    await recordServedProblem({
      userId: 'user-1',
      kind: 'coding',
      problemId: 'ai-gen-9',
      title: 'Rate Limiter',
      domain: 'backend',
      difficulty: 'medium',
      source: 'ai',
      problemBody: { id: 'ai-gen-9' },
    })
    expect(mocks.updateOne).toHaveBeenCalledTimes(1)
    const [filter, update, opts] = mocks.updateOne.mock.calls[0]
    expect(filter).toEqual({ userId: 'user-1', kind: 'coding', problemId: 'ai-gen-9' })
    expect(update.$setOnInsert).toMatchObject({
      title: 'Rate Limiter',
      domain: 'backend',
      difficulty: 'medium',
      source: 'ai',
      problemBody: { id: 'ai-gen-9' },
    })
    // servedAt lives in $set, NOT $setOnInsert: an exhausted-pool repeat must
    // refresh recency so least-recently-served rotation actually rotates
    // (Codex P2 on PR #485).
    expect(update.$set.servedAt).toBeInstanceOf(Date)
    expect(update.$setOnInsert.servedAt).toBeUndefined()
    expect(opts).toEqual({ upsert: true })
  })

  it('clamps the title to 200 chars', async () => {
    await recordServedProblem({
      userId: 'user-1',
      kind: 'coding',
      problemId: 'p',
      title: 'x'.repeat(500),
      source: 'static',
    })
    expect(mocks.updateOne.mock.calls[0][1].$setOnInsert.title).toHaveLength(200)
  })

  it('swallows write failures (never throws)', async () => {
    mocks.updateOne.mockRejectedValue(new Error('E11000-ish'))
    await expect(recordServedProblem({
      userId: 'user-1',
      kind: 'system-design',
      problemId: 'p',
      source: 'static',
    })).resolves.toBeUndefined()
    expect(mocks.warn).toHaveBeenCalled()
  })
})

describe('unionMostRecentFirst', () => {
  it('keeps primary order and appends unseen secondary ids', () => {
    expect(unionMostRecentFirst(['a', 'b'], ['c', 'a', 'd'])).toEqual(['a', 'b', 'c', 'd'])
  })

  it('dedupes within and across lists and drops falsy ids', () => {
    expect(unionMostRecentFirst(['a', '', 'a'], ['b', 'b'])).toEqual(['a', 'b'])
  })

  it('handles empty inputs', () => {
    expect(unionMostRecentFirst([], [])).toEqual([])
    expect(unionMostRecentFirst([], ['x'])).toEqual(['x'])
  })
})
