import { createHash } from 'crypto'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const mockRedisGet = vi.fn()
const mockRedisSet = vi.fn()
const mockRedisDel = vi.fn()
const mockRedisIncr = vi.fn()
const mockRedisExpire = vi.fn()

vi.mock('@shared/redis', () => ({
  redis: {
    get: (...args: unknown[]) => mockRedisGet(...args),
    set: (...args: unknown[]) => mockRedisSet(...args),
    del: (...args: unknown[]) => mockRedisDel(...args),
    incr: (...args: unknown[]) => mockRedisIncr(...args),
    expire: (...args: unknown[]) => mockRedisExpire(...args),
  },
}))

vi.mock('@shared/logger', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
  authLogger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}))

import { __internals, issueOtp, verifyOtp } from '@shared/auth/mailboxOtp'

const SCOPE = '507f1f77bcf86cd799439011'
const EMAIL = 'candidate@example.com'

function hashCode(code: string) {
  return createHash('sha256').update(code).digest('hex')
}

describe('mailboxOtp', () => {
  beforeEach(() => {
    mockRedisGet.mockReset()
    mockRedisSet.mockReset()
    mockRedisDel.mockReset()
    mockRedisIncr.mockReset()
    mockRedisExpire.mockReset()
  })

  describe('issueOtp', () => {
    it('generates a 6-digit code and preserves the otp:invite key protocol', async () => {
      mockRedisSet.mockResolvedValue('OK')
      const result = await issueOtp(SCOPE, EMAIL)
      expect(result).not.toBeNull()
      expect(result!.code).toMatch(/^\d{6}$/)

      const [key, value, ex, ttl] = mockRedisSet.mock.calls[0]
      expect(key).toBe(`otp:invite:${SCOPE}`)
      expect(ex).toBe('EX')
      expect(ttl).toBe(__internals.OTP_TTL_SECONDS)
      const record = JSON.parse(value as string)
      expect(record.codeHash).toBe(hashCode(result!.code))
      expect(record.email).toBe(EMAIL)
      expect(typeof record.issuedAt).toBe('number')
    })

    it('lowercases the email before storing', async () => {
      mockRedisSet.mockResolvedValue('OK')
      await issueOtp(SCOPE, 'Mixed@Case.Com')
      const record = JSON.parse(mockRedisSet.mock.calls[0][1] as string)
      expect(record.email).toBe('mixed@case.com')
    })

    it('returns null when Redis SET throws', async () => {
      mockRedisSet.mockRejectedValue(new Error('redis down'))
      await expect(issueOtp(SCOPE, EMAIL)).resolves.toBeNull()
    })

    it('does not reset the attempts counter on issuance', async () => {
      mockRedisSet.mockResolvedValue('OK')
      await issueOtp(SCOPE, EMAIL)
      expect(mockRedisSet).toHaveBeenCalledTimes(1)
      expect(mockRedisDel).not.toHaveBeenCalled()
    })
  })

  describe('verifyOtp', () => {
    function seedOtp(code: string, email = EMAIL) {
      const record = JSON.stringify({
        codeHash: hashCode(code),
        email: email.toLowerCase(),
        issuedAt: Date.now(),
      })
      mockRedisGet.mockImplementation(async (key: string) => {
        if (key === `otp:invite:${SCOPE}`) return record
        if (key === `otp:invite:attempts:${SCOPE}`) return null
        return null
      })
    }

    it('returns ok:true and deletes both keys on match', async () => {
      seedOtp('123456')
      mockRedisDel.mockResolvedValue(1)
      await expect(verifyOtp(SCOPE, EMAIL, '123456')).resolves.toEqual({ ok: true })
      expect(mockRedisDel).toHaveBeenCalledWith(`otp:invite:${SCOPE}`)
      expect(mockRedisDel).toHaveBeenCalledWith(`otp:invite:attempts:${SCOPE}`)
    })

    it('returns mismatch and increments attempts when code is wrong', async () => {
      seedOtp('123456')
      mockRedisIncr.mockResolvedValue(1)
      await expect(verifyOtp(SCOPE, EMAIL, '999999')).resolves.toEqual({
        ok: false,
        reason: 'mismatch',
      })
      expect(mockRedisIncr).toHaveBeenCalledWith(`otp:invite:attempts:${SCOPE}`)
      expect(mockRedisExpire).toHaveBeenCalledWith(
        `otp:invite:attempts:${SCOPE}`,
        __internals.ATTEMPT_WINDOW_SECONDS,
      )
    })

    it('does not re-set the attempts TTL on subsequent failures', async () => {
      seedOtp('123456')
      mockRedisIncr.mockResolvedValue(2)
      await verifyOtp(SCOPE, EMAIL, '999999')
      expect(mockRedisExpire).not.toHaveBeenCalled()
    })

    it('returns mismatch when the email does not match', async () => {
      seedOtp('123456', 'other@example.com')
      mockRedisIncr.mockResolvedValue(1)
      await expect(verifyOtp(SCOPE, EMAIL, '123456')).resolves.toEqual({
        ok: false,
        reason: 'mismatch',
      })
      expect(mockRedisIncr).toHaveBeenCalled()
    })

    it('returns no_otp when Redis has no record for the scope', async () => {
      mockRedisGet.mockResolvedValue(null)
      mockRedisIncr.mockResolvedValue(1)
      await expect(verifyOtp(SCOPE, EMAIL, '123456')).resolves.toEqual({
        ok: false,
        reason: 'no_otp',
      })
    })

    it('returns locked after MAX_ATTEMPTS without reading the OTP record', async () => {
      mockRedisGet.mockImplementation(async (key: string) => {
        if (key === `otp:invite:attempts:${SCOPE}`) {
          return String(__internals.MAX_ATTEMPTS)
        }
        return null
      })
      await expect(verifyOtp(SCOPE, EMAIL, '123456')).resolves.toEqual({
        ok: false,
        reason: 'locked',
      })
      expect(mockRedisGet).toHaveBeenCalledTimes(1)
    })

    it('returns redis_error when Redis throws', async () => {
      mockRedisGet.mockRejectedValue(new Error('redis down'))
      await expect(verifyOtp(SCOPE, EMAIL, '123456')).resolves.toEqual({
        ok: false,
        reason: 'redis_error',
      })
    })

    it('is case-insensitive on the email match', async () => {
      seedOtp('123456', 'candidate@example.com')
      mockRedisDel.mockResolvedValue(1)
      await expect(
        verifyOtp(SCOPE, 'CANDIDATE@EXAMPLE.COM', '123456'),
      ).resolves.toEqual({ ok: true })
    })
  })
})
