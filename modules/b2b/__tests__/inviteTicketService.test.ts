import { describe, it, expect, vi, beforeEach } from 'vitest'

const mockRedisGet = vi.fn()
const mockRedisSet = vi.fn()
const mockRedisDel = vi.fn()

vi.mock('@shared/redis', () => ({
  redis: {
    get: (...args: unknown[]) => mockRedisGet(...args),
    set: (...args: unknown[]) => mockRedisSet(...args),
    del: (...args: unknown[]) => mockRedisDel(...args),
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

describe('inviteTicketService', () => {
  beforeEach(() => {
    mockRedisGet.mockReset()
    mockRedisSet.mockReset()
    mockRedisDel.mockReset()
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

    it('generates a unique ticket per call', async () => {
      mockRedisSet.mockResolvedValue('OK')
      const a = await issueAuthTicket(USER_ID, SESSION_ID)
      const b = await issueAuthTicket(USER_ID, SESSION_ID)
      expect(a).not.toBe(b)
    })
  })

  describe('redeemAuthTicket', () => {
    it('returns the payload and DELs the key before returning (single-use)', async () => {
      mockRedisGet.mockResolvedValue(
        JSON.stringify({ userId: USER_ID, sessionId: SESSION_ID }),
      )
      mockRedisDel.mockResolvedValue(1)
      const ticket = 'a'.repeat(64)
      const result = await redeemAuthTicket(ticket)
      expect(result).toEqual({ userId: USER_ID, sessionId: SESSION_ID })
      // DEL MUST run — single-use is the security property. If this
      // regresses, replay attacks become possible.
      expect(mockRedisDel).toHaveBeenCalledWith(`${__internals.TICKET_PREFIX}${ticket}`)
    })

    it('returns null for missing / already-redeemed tickets', async () => {
      mockRedisGet.mockResolvedValue(null)
      const result = await redeemAuthTicket('a'.repeat(64))
      expect(result).toBeNull()
      // Nothing to delete when the key is already gone.
      expect(mockRedisDel).not.toHaveBeenCalled()
    })

    it('rejects malformed tickets without touching Redis', async () => {
      expect(await redeemAuthTicket('')).toBeNull()
      expect(await redeemAuthTicket('too-short')).toBeNull()
      expect(await redeemAuthTicket(null as unknown as string)).toBeNull()
      expect(mockRedisGet).not.toHaveBeenCalled()
    })

    it('returns null when the stored payload is malformed', async () => {
      mockRedisGet.mockResolvedValue(
        JSON.stringify({ userId: 'not-an-objectid', sessionId: SESSION_ID }),
      )
      mockRedisDel.mockResolvedValue(1)
      const result = await redeemAuthTicket('a'.repeat(64))
      expect(result).toBeNull()
      // DEL still runs because we delete before parsing — important for
      // single-use, even in the malformed-payload branch.
      expect(mockRedisDel).toHaveBeenCalled()
    })

    it('returns null when Redis throws', async () => {
      mockRedisGet.mockRejectedValue(new Error('redis down'))
      const result = await redeemAuthTicket('a'.repeat(64))
      expect(result).toBeNull()
    })
  })
})
