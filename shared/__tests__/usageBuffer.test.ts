import { describe, it, expect, vi, beforeEach } from 'vitest'

// ─── Mocks ──────────────────────────────────────────────────────────────────

const mockRedisRpush = vi.fn()
const mockRedisExpire = vi.fn()
const mockRedisLrange = vi.fn()
const mockRedisDel = vi.fn()

vi.mock('@shared/redis', () => ({
  redis: {
    rpush: (...args: unknown[]) => mockRedisRpush(...args),
    expire: (...args: unknown[]) => mockRedisExpire(...args),
    lrange: (...args: unknown[]) => mockRedisLrange(...args),
    del: (...args: unknown[]) => mockRedisDel(...args),
  },
}))

vi.mock('@shared/logger', () => ({
  logger: { error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn() },
  aiLogger: { error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn() },
}))

vi.mock('@shared/db/connection', () => ({
  connectDB: vi.fn().mockResolvedValue(undefined),
}))

const mockInsertMany = vi.fn()
const mockCreate = vi.fn()

vi.mock('@shared/db/models/UsageRecord', () => ({
  UsageRecord: {
    insertMany: (...args: unknown[]) => mockInsertMany(...args),
    create: (...args: unknown[]) => mockCreate(...args),
  },
}))

// ─── Imports (after mocks) ──────────────────────────────────────────────────

import { bufferUsage, flushUsageBuffer, type UsageRecordData } from '@shared/services/usageBuffer'
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

// ─── Tests ──────────────────────────────────────────────────────────────────

describe('usageBuffer', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockRedisRpush.mockResolvedValue(1)
    mockRedisExpire.mockResolvedValue(1)
    mockRedisLrange.mockResolvedValue([])
    mockRedisDel.mockResolvedValue(1)
    mockInsertMany.mockResolvedValue([])
    mockCreate.mockResolvedValue({})
  })

  describe('bufferUsage', () => {
    it('pushes serialised record to Redis list with correct key', async () => {
      const record = makeRecord()
      await bufferUsage('sess-1', record)

      expect(mockRedisRpush).toHaveBeenCalledWith('usage:buf:sess-1', JSON.stringify(record))
    })

    it('refreshes TTL on every push', async () => {
      await bufferUsage('sess-1', makeRecord())

      expect(mockRedisExpire).toHaveBeenCalledWith('usage:buf:sess-1', expect.any(Number))
    })

    it('throws on Redis error so callers can fall back', async () => {
      mockRedisRpush.mockRejectedValue(new Error('redis down'))

      await expect(bufferUsage('sess-1', makeRecord())).rejects.toThrow('redis down')
    })
  })

  describe('flushUsageBuffer', () => {
    it('is a no-op when the buffer is empty', async () => {
      mockRedisLrange.mockResolvedValue([])

      await flushUsageBuffer('sess-empty')

      expect(mockRedisDel).not.toHaveBeenCalled()
      expect(mockInsertMany).not.toHaveBeenCalled()
    })

    it('reads the full list, deletes the key, then calls insertMany', async () => {
      const record = makeRecord()
      mockRedisLrange.mockResolvedValue([JSON.stringify(record)])

      await flushUsageBuffer('sess-2')

      expect(mockRedisLrange).toHaveBeenCalledWith('usage:buf:sess-2', 0, -1)
      expect(mockRedisDel).toHaveBeenCalledWith('usage:buf:sess-2')
      expect(mockInsertMany).toHaveBeenCalledWith([record], { ordered: false })
    })

    it('flushes all buffered records in one insertMany call', async () => {
      const records = [makeRecord({ type: 'api_call_question' }), makeRecord({ type: 'api_call_evaluate' })]
      mockRedisLrange.mockResolvedValue(records.map((r) => JSON.stringify(r)))

      await flushUsageBuffer('sess-3')

      expect(mockInsertMany).toHaveBeenCalledWith(records, { ordered: false })
    })

    it('swallows Redis lrange errors gracefully', async () => {
      mockRedisLrange.mockRejectedValue(new Error('redis down'))

      await expect(flushUsageBuffer('sess-4')).resolves.toBeUndefined()
      expect(mockInsertMany).not.toHaveBeenCalled()
    })

    it('swallows insertMany errors gracefully', async () => {
      mockRedisLrange.mockResolvedValue([JSON.stringify(makeRecord())])
      mockInsertMany.mockRejectedValue(new Error('mongo down'))

      await expect(flushUsageBuffer('sess-5')).resolves.toBeUndefined()
    })
  })
})

describe('trackUsage', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockRedisRpush.mockResolvedValue(1)
    mockRedisExpire.mockResolvedValue(1)
    mockCreate.mockResolvedValue({})
  })

  const makeUser = () => ({
    id: 'user-abc',
    role: 'candidate' as const,
    organizationId: undefined,
  })

  it('buffers the record when sessionId is present', async () => {
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

    expect(mockRedisRpush).toHaveBeenCalledWith('usage:buf:sess-buf-1', expect.any(String))
    // Should not fall through to direct insert
    expect(mockCreate).not.toHaveBeenCalled()
  })

  it('falls back to direct insert when sessionId is absent', async () => {
    await trackUsage({
      user: makeUser(),
      type: 'api_call_question',
      inputTokens: 100,
      outputTokens: 200,
      modelUsed: 'claude-sonnet-4-6',
      durationMs: 500,
      success: true,
    })

    // No sessionId → no buffering
    expect(mockRedisRpush).not.toHaveBeenCalled()
    // Falls through to direct Mongo insert
    expect(mockCreate).toHaveBeenCalledOnce()
  })

  it('falls back to direct insert when buffer throws', async () => {
    mockRedisRpush.mockRejectedValue(new Error('redis down'))

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

    // Should have tried Redis first
    expect(mockRedisRpush).toHaveBeenCalledOnce()
    // Then fallen back to direct insert
    expect(mockCreate).toHaveBeenCalledOnce()
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

    expect(mockRedisRpush).not.toHaveBeenCalled()
    expect(mockCreate).not.toHaveBeenCalled()
  })
})
