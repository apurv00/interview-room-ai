import { describe, it, expect, vi, beforeEach } from 'vitest'

// ─── Mocks ───────────────────────────────────────────────────────────

const mockRedisSet = vi.fn()
const mockRedisEval = vi.fn()

vi.mock('@shared/redis', () => ({
  redis: {
    set: (...args: unknown[]) => mockRedisSet(...args),
    eval: (...args: unknown[]) => mockRedisEval(...args),
  },
}))

vi.mock('@shared/logger', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
  aiLogger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}))

import { acquireFeedbackLock, releaseFeedbackLock } from '@shared/services/feedbackLock'

const SESSION_ID = '507f1f77bcf86cd799439011'

// ─── Tests ───────────────────────────────────────────────────────────

describe('feedbackLock', () => {
  beforeEach(() => {
    mockRedisSet.mockReset()
    mockRedisEval.mockReset()
  })

  describe('acquireFeedbackLock', () => {
    it('returns an acquired lock when SETNX succeeds', async () => {
      mockRedisSet.mockResolvedValue('OK')

      const lock = await acquireFeedbackLock(SESSION_ID)

      expect(lock).not.toBeNull()
      expect(lock?.acquired).toBe(true)
      expect(lock?.lockKey).toBe(`feedback:lock:${SESSION_ID}`)
      expect(typeof lock?.lockValue).toBe('string')
      expect(lock?.lockValue.length).toBeGreaterThan(16)
    })

    it('returns null when another caller already holds the lock', async () => {
      mockRedisSet.mockResolvedValue(null) // SETNX returns null on contention

      const lock = await acquireFeedbackLock(SESSION_ID)

      expect(lock).toBeNull()
    })

    it('calls SET with NX, PX, and the configured TTL', async () => {
      mockRedisSet.mockResolvedValue('OK')

      await acquireFeedbackLock(SESSION_ID, 60_000)

      expect(mockRedisSet).toHaveBeenCalledTimes(1)
      const call = mockRedisSet.mock.calls[0]
      expect(call[0]).toBe(`feedback:lock:${SESSION_ID}`)
      expect(typeof call[1]).toBe('string') // lockValue
      expect(call[2]).toBe('PX')
      expect(call[3]).toBe(60_000)
      expect(call[4]).toBe('NX')
    })

    it('returns a fail-open handle when Redis errors (not null)', async () => {
      mockRedisSet.mockRejectedValue(new Error('redis down'))

      const lock = await acquireFeedbackLock(SESSION_ID)

      // Not null — legacy-compatible fail-open; caller proceeds as today.
      expect(lock).not.toBeNull()
      expect(lock?.acquired).toBe(false)
    })

    it('generates a unique lockValue per acquisition', async () => {
      mockRedisSet.mockResolvedValue('OK')

      const a = await acquireFeedbackLock(SESSION_ID)
      const b = await acquireFeedbackLock(SESSION_ID)

      expect(a?.lockValue).not.toBe(b?.lockValue)
    })
  })

  describe('releaseFeedbackLock', () => {
    it('runs Lua CAS DEL when lock was acquired', async () => {
      mockRedisEval.mockResolvedValue(1)

      await releaseFeedbackLock({
        lockKey: 'feedback:lock:abc',
        lockValue: 'xyz',
        acquired: true,
      })

      expect(mockRedisEval).toHaveBeenCalledTimes(1)
      const call = mockRedisEval.mock.calls[0]
      // 1st arg is the script, 2nd is numKeys (1), 3rd is KEYS[1], 4th is ARGV[1]
      expect(typeof call[0]).toBe('string')
      expect(call[0]).toContain('redis.call("del", KEYS[1])')
      expect(call[1]).toBe(1)
      expect(call[2]).toBe('feedback:lock:abc')
      expect(call[3]).toBe('xyz')
    })

    it('is a no-op when acquired is false (fail-open path)', async () => {
      await releaseFeedbackLock({
        lockKey: 'feedback:lock:abc',
        lockValue: 'xyz',
        acquired: false,
      })

      expect(mockRedisEval).not.toHaveBeenCalled()
    })

    it('swallows Redis errors — lock auto-expires on TTL', async () => {
      mockRedisEval.mockRejectedValue(new Error('redis down'))

      await expect(
        releaseFeedbackLock({
          lockKey: 'feedback:lock:abc',
          lockValue: 'xyz',
          acquired: true,
        })
      ).resolves.toBeUndefined()
    })
  })
})
