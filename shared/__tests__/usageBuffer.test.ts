import { describe, it, expect, vi, beforeEach } from 'vitest'

// ─── Mocks ──────────────────────────────────────────────────────────────────

const mockRedisEval = vi.fn()
const mockRedisLrange = vi.fn()
const mockRedisDel = vi.fn()

vi.mock('@shared/redis', () => ({
  redis: {
    eval: (...args: unknown[]) => mockRedisEval(...args),
    lrange: (...args: unknown[]) => mockRedisLrange(...args),
    del: (...args: unknown[]) => mockRedisDel(...args),
  },
}))

const mockLoggerWarn = vi.fn()
const mockAiLoggerError = vi.fn()

vi.mock('@shared/logger', () => ({
  logger: { error: vi.fn(), warn: (...args: unknown[]) => mockLoggerWarn(...args), info: vi.fn(), debug: vi.fn() },
  aiLogger: { error: (...args: unknown[]) => mockAiLoggerError(...args), warn: vi.fn(), info: vi.fn(), debug: vi.fn() },
}))

const mockConnectDB = vi.fn()

vi.mock('@shared/db/connection', () => ({
  connectDB: (...args: unknown[]) => mockConnectDB(...args),
}))

const mockInsertMany = vi.fn()
const mockCreate = vi.fn()

vi.mock('@shared/db/models/UsageRecord', () => ({
  UsageRecord: {
    insertMany: (...args: unknown[]) => mockInsertMany(...args),
    create: (...args: unknown[]) => mockCreate(...args),
  },
}))

const MockJobsAccountInactiveError = vi.hoisted(() => class extends Error {
  constructor() {
    super('Jobs account is not active')
    this.name = 'JobsAccountInactiveError'
  }
})

const mockMongoSession = { id: 'jobs-fence-session' }
const mockWithActiveJobsAccountWrite = vi.fn()

vi.mock('@shared/services/jobsAccountFence', () => ({
  JobsAccountInactiveError: MockJobsAccountInactiveError,
  withActiveJobsAccountWrite: (...args: unknown[]) => mockWithActiveJobsAccountWrite(...args),
}))

// ─── Imports (after mocks) ──────────────────────────────────────────────────

import {
  bufferUsage,
  flushUsageBuffer,
  tombstoneAccountUsageBuffers,
  type UsageRecordData,
} from '@shared/services/usageBuffer'
import { trackUsage } from '@shared/services/usageTracking'

// ─── Helpers ────────────────────────────────────────────────────────────────

function makeRecord(overrides: Partial<UsageRecordData> = {}): UsageRecordData {
  return {
    userId: 'user-abc',
    type: 'api_call_question',
    sessionId: 'sess-xyz',
    inputTokens: 100,
    outputTokens: 200,
    modelUsed: 'claude-sonnet-4-6',
    costUsd: 0.0015,
    durationMs: 1200,
    success: true,
    ...overrides,
  }
}

function allowActiveAccountWrites() {
  mockWithActiveJobsAccountWrite.mockImplementation(
    async (_userId: string, work: (session: unknown) => unknown) => work(mockMongoSession),
  )
}

// ─── Tests ──────────────────────────────────────────────────────────────────

describe('usageBuffer', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockRedisEval.mockResolvedValue(1)
    mockRedisLrange.mockResolvedValue([])
    mockRedisDel.mockResolvedValue(1)
    mockConnectDB.mockResolvedValue(undefined)
    mockInsertMany.mockResolvedValue([])
    mockCreate.mockResolvedValue({})
    allowActiveAccountWrites()
  })

  describe('bufferUsage', () => {
    it('atomically checks the account tombstone, appends, and indexes the buffer', async () => {
      const record = makeRecord()

      await expect(bufferUsage('sess-1', record)).resolves.toBe(true)

      expect(mockRedisEval).toHaveBeenCalledWith(
        expect.stringContaining("redis.call('SADD', KEYS[3], KEYS[1])"),
        3,
        'usage:buf:sess-1',
        'usage:account-deleting:user-abc',
        'usage:user-buffers:user-abc',
        JSON.stringify(record),
        86400,
      )
      const script = String(mockRedisEval.mock.calls[0][0])
      expect(script.indexOf("redis.call('EXISTS', KEYS[2])")).toBeLessThan(
        script.indexOf("redis.call('RPUSH', KEYS[1], ARGV[1])"),
      )
      expect(script).toContain("redis.call('EXPIRE', KEYS[3], ARGV[2])")
    })

    it('returns false when the deletion tombstone rejects the append', async () => {
      mockRedisEval.mockResolvedValue(0)

      await expect(bufferUsage('sess-1', makeRecord())).resolves.toBe(false)
    })

    it('throws on Redis error so callers can use the durable Mongo fallback', async () => {
      mockRedisEval.mockRejectedValue(new Error('redis down'))

      await expect(bufferUsage('sess-1', makeRecord())).rejects.toThrow('redis down')
    })
  })

  describe('tombstoneAccountUsageBuffers', () => {
    it('sets the account tombstone before deleting indexed and legacy session buffers', async () => {
      await tombstoneAccountUsageBuffers('user-abc', ['sess-1', 'sess-2', 'sess-1'])

      expect(mockRedisEval).toHaveBeenCalledWith(
        expect.stringContaining("local indexed = redis.call('SMEMBERS', KEYS[2])"),
        4,
        'usage:account-deleting:user-abc',
        'usage:user-buffers:user-abc',
        'usage:buf:sess-1',
        'usage:buf:sess-2',
        691200,
      )
      const script = String(mockRedisEval.mock.calls[0][0])
      expect(script.indexOf("redis.call('SET', KEYS[1], '1', 'EX', ARGV[1])")).toBeLessThan(
        script.indexOf("redis.call('SMEMBERS', KEYS[2])"),
      )
      expect(script).toContain("redis.call('DEL', bufferKey)")
      expect(script).toContain("redis.call('DEL', KEYS[i])")
      expect(script).toContain("redis.call('DEL', KEYS[2])")
    })

    it('still establishes the account tombstone and clears the index with no known sessions', async () => {
      await tombstoneAccountUsageBuffers('user-empty', [])

      expect(mockRedisEval).toHaveBeenCalledWith(
        expect.any(String),
        2,
        'usage:account-deleting:user-empty',
        'usage:user-buffers:user-empty',
        691200,
      )
    })

    it('propagates Redis failure because account deletion treats this as mandatory', async () => {
      mockRedisEval.mockRejectedValue(new Error('redis unavailable'))

      await expect(tombstoneAccountUsageBuffers('user-abc', ['sess-1']))
        .rejects.toThrow('redis unavailable')
    })
  })

  describe('flushUsageBuffer', () => {
    it('is a no-op when the buffer is empty', async () => {
      await flushUsageBuffer('sess-empty')

      expect(mockRedisDel).not.toHaveBeenCalled()
      expect(mockConnectDB).not.toHaveBeenCalled()
      expect(mockInsertMany).not.toHaveBeenCalled()
    })

    it('deletes the Redis key and writes through the durable account transaction fence', async () => {
      const record = makeRecord()
      mockRedisLrange.mockResolvedValue([JSON.stringify(record)])

      await flushUsageBuffer('sess-2')

      expect(mockRedisLrange).toHaveBeenCalledWith('usage:buf:sess-2', 0, -1)
      expect(mockRedisDel).toHaveBeenCalledWith('usage:buf:sess-2')
      expect(mockRedisEval).toHaveBeenCalledWith(
        expect.stringContaining("return redis.call('SREM', KEYS[2], KEYS[1])"),
        2,
        'usage:buf:sess-2',
        'usage:user-buffers:user-abc',
      )
      const cleanupScript = String(mockRedisEval.mock.calls[0][0])
      expect(cleanupScript.indexOf("redis.call('EXISTS', KEYS[1])")).toBeLessThan(
        cleanupScript.indexOf("redis.call('SREM', KEYS[2], KEYS[1])"),
      )
      expect(mockWithActiveJobsAccountWrite).toHaveBeenCalledWith('user-abc', expect.any(Function))
      expect(mockInsertMany).toHaveBeenCalledWith(
        [record],
        { ordered: false, session: mockMongoSession },
      )
    })

    it('flushes records for one account in one fenced insertMany call', async () => {
      const records = [
        makeRecord({ type: 'api_call_question' }),
        makeRecord({ type: 'api_call_evaluate' }),
      ]
      mockRedisLrange.mockResolvedValue(records.map((record) => JSON.stringify(record)))

      await flushUsageBuffer('sess-3')

      expect(mockWithActiveJobsAccountWrite).toHaveBeenCalledTimes(1)
      expect(mockInsertMany).toHaveBeenCalledWith(
        records,
        { ordered: false, session: mockMongoSession },
      )
    })

    it('defensively groups a mixed legacy buffer by user and fences each account separately', async () => {
      const firstUserRecords = [
        makeRecord({ type: 'api_call_question' }),
        makeRecord({ type: 'api_call_evaluate' }),
      ]
      const secondUserRecord = makeRecord({ userId: 'user-other', type: 'api_call_feedback' })
      mockRedisLrange.mockResolvedValue([
        JSON.stringify(firstUserRecords[0]),
        JSON.stringify(secondUserRecord),
        JSON.stringify(firstUserRecords[1]),
      ])

      await flushUsageBuffer('legacy-mixed')

      expect(mockWithActiveJobsAccountWrite).toHaveBeenNthCalledWith(
        1,
        'user-abc',
        expect.any(Function),
      )
      expect(mockRedisEval).toHaveBeenNthCalledWith(
        1,
        expect.stringContaining("redis.call('SREM', KEYS[2], KEYS[1])"),
        2,
        'usage:buf:legacy-mixed',
        'usage:user-buffers:user-abc',
      )
      expect(mockRedisEval).toHaveBeenNthCalledWith(
        2,
        expect.stringContaining("redis.call('SREM', KEYS[2], KEYS[1])"),
        2,
        'usage:buf:legacy-mixed',
        'usage:user-buffers:user-other',
      )
      expect(mockWithActiveJobsAccountWrite).toHaveBeenNthCalledWith(
        2,
        'user-other',
        expect.any(Function),
      )
      expect(mockInsertMany).toHaveBeenNthCalledWith(
        1,
        firstUserRecords,
        { ordered: false, session: mockMongoSession },
      )
      expect(mockInsertMany).toHaveBeenNthCalledWith(
        2,
        [secondUserRecord],
        { ordered: false, session: mockMongoSession },
      )
    })

    it('drops a buffered group when the durable fence reports an inactive account', async () => {
      mockRedisLrange.mockResolvedValue([JSON.stringify(makeRecord())])
      mockWithActiveJobsAccountWrite.mockRejectedValue(new MockJobsAccountInactiveError())

      await expect(flushUsageBuffer('sess-deleting')).resolves.toBeUndefined()

      expect(mockInsertMany).not.toHaveBeenCalled()
      expect(mockLoggerWarn).not.toHaveBeenCalled()
    })

    it('keeps flushing when race-safe user-index cleanup fails', async () => {
      const record = makeRecord()
      mockRedisLrange.mockResolvedValue([JSON.stringify(record)])
      mockRedisEval.mockRejectedValueOnce(new Error('index cleanup unavailable'))

      await expect(flushUsageBuffer('sess-index-failure')).resolves.toBeUndefined()

      expect(mockRedisDel).toHaveBeenCalledWith('usage:buf:sess-index-failure')
      expect(mockWithActiveJobsAccountWrite).toHaveBeenCalledWith('user-abc', expect.any(Function))
      expect(mockInsertMany).toHaveBeenCalledWith(
        [record],
        { ordered: false, session: mockMongoSession },
      )
      expect(mockLoggerWarn).toHaveBeenCalledWith(
        expect.objectContaining({ sessionId: 'sess-index-failure' }),
        'flushUsageBuffer: user index cleanup failed',
      )
    })

    it('swallows Redis read errors without attempting Mongo', async () => {
      mockRedisLrange.mockRejectedValue(new Error('redis down'))

      await expect(flushUsageBuffer('sess-4')).resolves.toBeUndefined()
      expect(mockConnectDB).not.toHaveBeenCalled()
      expect(mockInsertMany).not.toHaveBeenCalled()
    })

    it('swallows insertMany errors after the Redis buffer has been consumed', async () => {
      mockRedisLrange.mockResolvedValue([JSON.stringify(makeRecord())])
      mockInsertMany.mockRejectedValue(new Error('mongo down'))

      await expect(flushUsageBuffer('sess-5')).resolves.toBeUndefined()

      expect(mockRedisDel).toHaveBeenCalledWith('usage:buf:sess-5')
      expect(mockLoggerWarn).toHaveBeenCalledOnce()
    })
  })
})

describe('trackUsage', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockRedisEval.mockResolvedValue(1)
    mockRedisLrange.mockResolvedValue([])
    mockRedisDel.mockResolvedValue(1)
    mockConnectDB.mockResolvedValue(undefined)
    mockCreate.mockResolvedValue({})
    allowActiveAccountWrites()
  })

  const makeUser = () => ({
    id: 'user-abc',
    role: 'candidate' as const,
    organizationId: undefined,
  })

  it('uses only the atomic Redis hot path when a session buffer accepts the record', async () => {
    await trackUsage({
      user: makeUser(),
      type: 'api_call_question',
      sessionId: 'sess-buf-1',
      inputTokens: 100,
      outputTokens: 200,
      modelUsed: 'claude-sonnet-4-6',
      durationMs: 500,
      success: true,
    })

    expect(mockRedisEval).toHaveBeenCalledWith(
      expect.stringContaining("redis.call('EXISTS', KEYS[2])"),
      3,
      'usage:buf:sess-buf-1',
      'usage:account-deleting:user-abc',
      'usage:user-buffers:user-abc',
      expect.any(String),
      86400,
    )
    expect(mockConnectDB).not.toHaveBeenCalled()
    expect(mockWithActiveJobsAccountWrite).not.toHaveBeenCalled()
    expect(mockCreate).not.toHaveBeenCalled()
  })

  it('drops a tombstone-rejected record without falling through to Mongo', async () => {
    mockRedisEval.mockResolvedValue(0)

    await trackUsage({
      user: makeUser(),
      type: 'api_call_question',
      sessionId: 'sess-deleting',
      inputTokens: 100,
      outputTokens: 200,
      modelUsed: 'claude-sonnet-4-6',
      durationMs: 500,
      success: true,
    })

    expect(mockRedisEval).toHaveBeenCalledOnce()
    expect(mockConnectDB).not.toHaveBeenCalled()
    expect(mockWithActiveJobsAccountWrite).not.toHaveBeenCalled()
    expect(mockCreate).not.toHaveBeenCalled()
  })

  it('uses the durable transaction fence when sessionId is absent', async () => {
    await trackUsage({
      user: makeUser(),
      type: 'api_call_question',
      inputTokens: 100,
      outputTokens: 200,
      modelUsed: 'claude-sonnet-4-6',
      durationMs: 500,
      success: true,
    })

    expect(mockRedisEval).not.toHaveBeenCalled()
    expect(mockConnectDB).toHaveBeenCalledOnce()
    expect(mockWithActiveJobsAccountWrite).toHaveBeenCalledWith('user-abc', expect.any(Function))
    expect(mockCreate).toHaveBeenCalledWith(
      [expect.objectContaining({ userId: 'user-abc', type: 'api_call_question' })],
      { session: mockMongoSession },
    )
  })

  it('falls back from a Redis failure to the durable transaction fence', async () => {
    mockRedisEval.mockRejectedValue(new Error('redis down'))

    await trackUsage({
      user: makeUser(),
      type: 'api_call_question',
      sessionId: 'sess-fallback',
      inputTokens: 100,
      outputTokens: 200,
      modelUsed: 'claude-sonnet-4-6',
      durationMs: 500,
      success: true,
    })

    expect(mockRedisEval).toHaveBeenCalledOnce()
    expect(mockConnectDB).toHaveBeenCalledOnce()
    expect(mockWithActiveJobsAccountWrite).toHaveBeenCalledWith('user-abc', expect.any(Function))
    expect(mockCreate).toHaveBeenCalledOnce()
  })

  it('silently drops a direct write rejected by the durable account fence', async () => {
    mockWithActiveJobsAccountWrite.mockRejectedValue(new MockJobsAccountInactiveError())

    await expect(trackUsage({
      user: makeUser(),
      type: 'api_call_question',
      inputTokens: 100,
      outputTokens: 200,
      modelUsed: 'claude-sonnet-4-6',
      durationMs: 500,
      success: true,
    })).resolves.toBeUndefined()

    expect(mockCreate).not.toHaveBeenCalled()
    expect(mockAiLoggerError).not.toHaveBeenCalled()
  })

  it('skips anonymous users entirely', async () => {
    await trackUsage({
      user: { id: 'anonymous', role: 'candidate' as const },
      type: 'api_call_question',
      sessionId: 'sess-anon',
      inputTokens: 0,
      outputTokens: 0,
      modelUsed: 'unknown',
      durationMs: 0,
      success: false,
    })

    expect(mockRedisEval).not.toHaveBeenCalled()
    expect(mockConnectDB).not.toHaveBeenCalled()
    expect(mockWithActiveJobsAccountWrite).not.toHaveBeenCalled()
    expect(mockCreate).not.toHaveBeenCalled()
  })
})
