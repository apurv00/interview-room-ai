import { describe, it, expect, vi, beforeEach } from 'vitest'

const mockRedisGet = vi.fn()
const mockRedisSet = vi.fn()
const mockRedisDel = vi.fn()
const mockRedisEval = vi.fn()

vi.mock('@shared/redis', () => ({
  redis: {
    get: (...args: unknown[]) => mockRedisGet(...args),
    set: (...args: unknown[]) => mockRedisSet(...args),
    del: (...args: unknown[]) => mockRedisDel(...args),
    eval: (...args: unknown[]) => mockRedisEval(...args),
  },
}))

vi.mock('@shared/logger', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
  authLogger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}))

import {
  issueAuthTicket,
  redeemAuthTicket,
  __internals,
} from '@b2b/services/inviteTicketService'

const USER_ID = '507f1f77bcf86cd799439011'
const SESSION_ID = '507f1f77bcf86cd799439012'
const ORGANIZATION_ID = '507f1f77bcf86cd799439013'

describe('inviteTicketService', () => {
  beforeEach(() => {
    mockRedisGet.mockReset()
    mockRedisSet.mockReset()
    mockRedisDel.mockReset()
    mockRedisEval.mockReset()
  })

  describe('issueAuthTicket', () => {
    it('stores { userId, sessionId } under a 64-char hex ticket with the configured TTL', async () => {
      mockRedisSet.mockResolvedValue('OK')
      const ticket = await issueAuthTicket(USER_ID, SESSION_ID)
      expect(ticket).not.toBeNull()
      expect(ticket).toMatch(/^[0-9a-f]{64}$/)

      const [key, value, ex, ttl] = mockRedisSet.mock.calls[0]
      expect(key).toBe(`${__internals.TICKET_PREFIX}${ticket}`)
      expect(ex).toBe('EX')
      expect(ttl).toBe(__internals.TICKET_TTL_SECONDS)
      expect(JSON.parse(value as string)).toEqual({
        userId: USER_ID,
        sessionId: SESSION_ID,
      })
    })

    it('returns null when Redis errors (caller returns 503)', async () => {
      mockRedisSet.mockRejectedValue(new Error('redis down'))
      const ticket = await issueAuthTicket(USER_ID, SESSION_ID)
      expect(ticket).toBeNull()
    })

    it('binds a runtime ticket to its exact organization when provided', async () => {
      mockRedisSet.mockResolvedValue('OK')
      const ticket = await issueAuthTicket(USER_ID, SESSION_ID, ORGANIZATION_ID)

      const stored = JSON.parse(mockRedisSet.mock.calls[0][1] as string)
      expect(stored).toEqual({
        userId: USER_ID,
        sessionId: SESSION_ID,
        organizationId: ORGANIZATION_ID,
      })
      expect(ticket).toMatch(/^[0-9a-f]{64}$/)
    })

    it('generates a unique ticket per call', async () => {
      mockRedisSet.mockResolvedValue('OK')
      const a = await issueAuthTicket(USER_ID, SESSION_ID)
      const b = await issueAuthTicket(USER_ID, SESSION_ID)
      expect(a).not.toBe(b)
    })

  })

  describe('redeemAuthTicket', () => {
    it('atomically consumes the payload before returning it', async () => {
      mockRedisEval.mockResolvedValue(
        JSON.stringify({ userId: USER_ID, sessionId: SESSION_ID }),
      )
      const ticket = 'a'.repeat(64)
      const result = await redeemAuthTicket(ticket)
      expect(result).toEqual({ userId: USER_ID, sessionId: SESSION_ID })
      expect(mockRedisEval).toHaveBeenCalledWith(
        __internals.REDEEM_TICKET_SCRIPT,
        1,
        `${__internals.TICKET_PREFIX}${ticket}`,
      )
      expect(mockRedisGet).not.toHaveBeenCalled()
      expect(mockRedisDel).not.toHaveBeenCalled()
    })

    it('returns null for missing / already-redeemed tickets', async () => {
      mockRedisEval.mockResolvedValue(null)
      const result = await redeemAuthTicket('a'.repeat(64))
      expect(result).toBeNull()
    })

    it('allows exactly one winner across concurrent redemption attempts', async () => {
      let stored: string | null = JSON.stringify({
        userId: USER_ID,
        sessionId: SESSION_ID,
      })
      mockRedisEval.mockImplementation(async () => {
        const claimed = stored
        stored = null
        return claimed
      })

      const outcomes = await Promise.all([
        redeemAuthTicket('a'.repeat(64)),
        redeemAuthTicket('a'.repeat(64)),
      ])
      expect(outcomes.filter(Boolean)).toEqual([
        { userId: USER_ID, sessionId: SESSION_ID },
      ])
    })

    it('rejects malformed tickets without touching Redis', async () => {
      expect(await redeemAuthTicket('')).toBeNull()
      expect(await redeemAuthTicket('too-short')).toBeNull()
      expect(await redeemAuthTicket(null as unknown as string)).toBeNull()
      expect(mockRedisEval).not.toHaveBeenCalled()
    })

    it('returns null when the stored payload is malformed', async () => {
      mockRedisEval.mockResolvedValue(
        JSON.stringify({ userId: 'not-an-objectid', sessionId: SESSION_ID }),
      )
      const result = await redeemAuthTicket('a'.repeat(64))
      expect(result).toBeNull()
      expect(mockRedisEval).toHaveBeenCalledTimes(1)
    })

    it('rejects a malformed optional organization boundary', async () => {
      mockRedisEval.mockResolvedValue(JSON.stringify({
        userId: USER_ID,
        sessionId: SESSION_ID,
        organizationId: 'not-an-objectid',
      }))

      await expect(redeemAuthTicket('a'.repeat(64))).resolves.toBeNull()
      expect(mockRedisEval).toHaveBeenCalledTimes(1)
    })

    it('returns null when Redis throws', async () => {
      mockRedisEval.mockRejectedValue(new Error('redis down'))
      const result = await redeemAuthTicket('a'.repeat(64))
      expect(result).toBeNull()
    })
  })
})
