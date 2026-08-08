import mongoose, { type ClientSession } from 'mongoose'
import { describe, expect, it, vi } from 'vitest'
import type { BillingConfigView } from '../services/billingConfigService'
import {
  consumePaidInterviewUnlockForLaunchInSession,
  paidInterviewLaunchProviderMode,
  type PaidInterviewLaunchStore,
} from '../services/paidInterviewLaunchService'

const userId = new mongoose.Types.ObjectId()
const otherUserId = new mongoose.Types.ObjectId()
const firstSessionId = new mongoose.Types.ObjectId()
const secondSessionId = new mongoose.Types.ObjectId()
const unlockId = new mongoose.Types.ObjectId()
const now = new Date('2026-08-07T12:00:00.000Z')
const validUntil = new Date('2026-09-06T12:00:00.000Z')

const transaction = {
  inTransaction: () => true,
} as ClientSession

function mutableStore(owner = userId): PaidInterviewLaunchStore {
  let state: 'available' | 'consumed' = 'available'
  let consumedSessionId: mongoose.Types.ObjectId | undefined
  let consumedAt: Date | undefined

  return {
    async findConsumed(input) {
      if (
        state !== 'consumed' ||
        !owner.equals(input.userId) ||
        !consumedSessionId?.equals(input.sessionId) ||
        !consumedAt
      ) return null
      return {
        id: unlockId,
        userId: owner,
        providerMode: 'live',
        status: 'consumed',
        maxDurationMinutes: 30,
        validUntil,
        reservedSessionId: consumedSessionId,
        consumedSessionId,
        reservedAt: consumedAt,
        consumedAt,
      }
    },
    async claimAvailable(input) {
      if (
        state !== 'available' ||
        !owner.equals(input.userId) ||
        input.providerMode !== 'live'
      ) return null
      // The real store performs this transition with one findOneAndUpdate.
      // Mutating synchronously here gives parallel callers the same one-winner
      // behavior without requiring a database in the unit suite.
      state = 'consumed'
      consumedSessionId = input.sessionId
      consumedAt = input.now
      return {
        id: unlockId,
        userId: owner,
        providerMode: 'live',
        status: 'consumed',
        maxDurationMinutes: 30,
        validUntil,
        reservedSessionId: input.sessionId,
        consumedSessionId: input.sessionId,
        reservedAt: input.now,
        consumedAt: input.now,
      }
    },
  }
}

function input(
  sessionId = firstSessionId,
  selectedUserId = userId,
  durationMinutes = 30,
) {
  return {
    userId: selectedUserId.toHexString(),
    sessionId: sessionId.toHexString(),
    providerMode: 'live' as const,
    durationMinutes,
    now,
  }
}

describe('paid interview launch consumption', () => {
  it('does not authorize an interview when no captured unlock exists', async () => {
    const store: PaidInterviewLaunchStore = {
      findConsumed: vi.fn().mockResolvedValue(null),
      claimAvailable: vi.fn().mockResolvedValue(null),
    }

    await expect(consumePaidInterviewUnlockForLaunchInSession(
      input(),
      transaction,
      { store },
    )).rejects.toMatchObject({
      name: 'PaidInterviewLaunchError',
      code: 'unavailable',
    })
  })

  it('binds the unlock to the exact paying account', async () => {
    await expect(consumePaidInterviewUnlockForLaunchInSession(
      input(firstSessionId, otherUserId),
      transaction,
      { store: mutableStore(userId) },
    )).rejects.toMatchObject({ code: 'unavailable' })
  })

  it('has one atomic winner and replays that exact session idempotently', async () => {
    const store = mutableStore()
    const [first, competing] = await Promise.allSettled([
      consumePaidInterviewUnlockForLaunchInSession(
        input(firstSessionId),
        transaction,
        { store },
      ),
      consumePaidInterviewUnlockForLaunchInSession(
        input(secondSessionId),
        transaction,
        { store },
      ),
    ])

    expect(first).toMatchObject({
      status: 'fulfilled',
      value: {
        sessionId: firstSessionId.toHexString(),
        reused: false,
      },
    })
    expect(competing).toMatchObject({
      status: 'rejected',
      reason: { code: 'unavailable' },
    })

    await expect(consumePaidInterviewUnlockForLaunchInSession(
      input(firstSessionId),
      transaction,
      { store },
    )).resolves.toMatchObject({
      sessionId: firstSessionId.toHexString(),
      reused: true,
    })
  })

  it('rejects 31-minute requests before reading or consuming an unlock', async () => {
    const store: PaidInterviewLaunchStore = {
      findConsumed: vi.fn(),
      claimAvailable: vi.fn(),
    }
    await expect(consumePaidInterviewUnlockForLaunchInSession(
      input(firstSessionId, userId, 31),
      transaction,
      { store },
    )).rejects.toMatchObject({ code: 'invalid_request' })
    expect(store.findConsumed).not.toHaveBeenCalled()
    expect(store.claimAvailable).not.toHaveBeenCalled()
  })

  it('keeps QA unlocks isolated from live customer unlocks', () => {
    const base = {
      qaUserIds: [userId.toHexString()],
    } as BillingConfigView
    expect(paidInterviewLaunchProviderMode({
      ...base,
      sellingMode: 'qa',
    }, userId.toHexString())).toBe('test')
    expect(paidInterviewLaunchProviderMode({
      ...base,
      sellingMode: 'all',
    }, userId.toHexString())).toBe('live')
    expect(paidInterviewLaunchProviderMode({
      ...base,
      sellingMode: 'off',
    }, userId.toHexString())).toBe('live')
  })
})
