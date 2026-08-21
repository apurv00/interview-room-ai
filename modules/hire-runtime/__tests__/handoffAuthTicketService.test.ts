import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  connect: vi.fn(),
  findOneAndUpdate: vi.fn(),
  findOne: vi.fn(),
  exists: vi.fn(),
  redisEval: vi.fn(),
  authError: vi.fn(),
}))

vi.mock('../services/runtimeBoundary', () => ({
  connectHireRuntimeDB: mocks.connect,
}))
vi.mock('../models/HireRuntimeBinding', () => ({
  HireRuntimeBinding: {
    findOneAndUpdate: mocks.findOneAndUpdate,
    findOne: mocks.findOne,
    exists: mocks.exists,
  },
}))
vi.mock('@shared/redis', () => ({
  redis: { eval: mocks.redisEval },
}))
vi.mock('@shared/logger', () => ({
  authLogger: {
    error: mocks.authError,
    warn: vi.fn(),
    info: vi.fn(),
  },
}))

import {
  __runtimeAuthTicket,
  issueRuntimeAuthTicket,
  redeemRuntimeAuthTicket,
  RUNTIME_AUTH_TICKET_CONSUMED,
  RuntimeAuthTicketError,
} from '../services/handoffAuthTicketService'

const NOW = new Date('2026-08-21T00:00:00.000Z')
const IDS = {
  bindingId: '1'.repeat(24),
  workspaceId: '2'.repeat(24),
  principalId: '3'.repeat(24),
  roundId: '4'.repeat(24),
}
const NONCE_1 = 'a'.repeat(64)
const NONCE_2 = 'b'.repeat(64)

type BindingState = typeof IDS & {
  status: 'active' | 'revoked'
  inviteExpiresAt: Date
  revokedAt?: Date
  purgePersonalData?: boolean
  authTicketGeneration?: number
  authTicketHandoffNonce?: string
  authTicketState?: 'issued' | 'consumed'
  authTicketDigest?: string
  authTicketExpiresAt?: Date
  authTicketIssuedAt?: Date
  authTicketConsumedAt?: Date
}

let binding: BindingState
const redisRecords = new Map<string, string>()

function cloneBinding(): BindingState {
  return { ...binding }
}

function isLive(): boolean {
  return binding.status === 'active' &&
    !binding.revokedAt &&
    binding.purgePersonalData !== true &&
    binding.inviteExpiresAt > NOW
}

function envelope(
  handoffGeneration = 1,
  nonce = NONCE_1,
  issuedAt = NOW,
) {
  return {
    handoffGeneration,
    nonce,
    issuedAt: issuedAt.toISOString(),
    expiresAt: new Date(issuedAt.getTime() + 60_000).toISOString(),
  }
}

function issueInput(
  handoffGeneration = 1,
  nonce = NONCE_1,
  issuedAt = NOW,
) {
  return {
    ...IDS,
    envelope: envelope(handoffGeneration, nonce, issuedAt),
    now: NOW,
  }
}

function installMongoStateMachine() {
  mocks.findOneAndUpdate.mockImplementation(
    async (_filter: Record<string, unknown>, update: {
      $set: Partial<BindingState>
      $unset?: Record<string, unknown>
    }) => {
      if (!isLive()) return null
      if (update.$set.authTicketState === 'consumed') {
        const filter = _filter as {
          authTicketDigest?: string
          authTicketState?: string
          authTicketExpiresAt?: { $gt?: Date }
        }
        if (
          binding.authTicketState !== filter.authTicketState ||
          binding.authTicketDigest !== filter.authTicketDigest ||
          !binding.authTicketExpiresAt ||
          binding.authTicketExpiresAt <= (filter.authTicketExpiresAt?.$gt ?? NOW)
        ) {
          return null
        }
        const previous = cloneBinding()
        Object.assign(binding, update.$set)
        return previous
      }

      const incomingGeneration = update.$set.authTicketGeneration
      if (
        typeof incomingGeneration !== 'number' ||
        (binding.authTicketGeneration !== undefined &&
          binding.authTicketGeneration >= incomingGeneration)
      ) {
        return null
      }
      Object.assign(binding, update.$set)
      if (update.$unset?.authTicketConsumedAt) {
        delete binding.authTicketConsumedAt
      }
      return cloneBinding()
    },
  )
  mocks.findOne.mockImplementation(async () => isLive() ? cloneBinding() : null)
  mocks.exists.mockImplementation(async (query: Record<string, unknown>) => {
    if (!isLive()) return null
    for (const [key, value] of Object.entries(query)) {
      if (key.startsWith('$') || ['status', 'revokedAt', 'purgePersonalData', 'inviteExpiresAt'].includes(key)) {
        continue
      }
      const actual = binding[key as keyof BindingState]
      if (key === '_id') {
        if (binding.bindingId !== value) return null
        continue
      }
      if (actual instanceof Date && value instanceof Date) {
        if (actual.getTime() !== value.getTime()) return null
      } else if (actual !== value) {
        return null
      }
    }
    return { _id: binding.bindingId }
  })
}

function installRedisStateMachine() {
  mocks.redisEval.mockImplementation(
    async (
      script: string,
      _keyCount: number,
      key: string,
      generationValue: string,
      ticketDigest: string,
      incomingRaw: string,
    ) => {
      const incomingGeneration = Number(generationValue)
      const existingRaw = redisRecords.get(key)
      const existing = existingRaw
        ? JSON.parse(existingRaw) as {
            generation: number
            state: 'issued' | 'consumed'
            digest: string
          }
        : null
      if (existing && existing.generation > incomingGeneration) return 'stale'
      if (
        existing &&
        existing.generation === incomingGeneration &&
        existing.digest !== ticketDigest
      ) {
        return 'conflict'
      }
      if (script === __runtimeAuthTicket.SYNC_ISSUED_SCRIPT) {
        if (existing?.generation === incomingGeneration) {
          return existing.state
        }
        redisRecords.set(key, incomingRaw)
        return 'issued'
      }
      if (
        existing?.generation === incomingGeneration &&
        existing.state === 'consumed'
      ) {
        return 'consumed'
      }
      redisRecords.set(key, incomingRaw)
      return 'consumed'
    },
  )
}

beforeEach(() => {
  vi.clearAllMocks()
  process.env.HIRE_RUNTIME_NEXTAUTH_SECRET = 'runtime-auth-secret-'.repeat(3)
  binding = {
    ...IDS,
    status: 'active',
    inviteExpiresAt: new Date('2026-08-22T00:00:00.000Z'),
  }
  redisRecords.clear()
  mocks.connect.mockResolvedValue(undefined)
  installMongoStateMachine()
  installRedisStateMachine()
})

describe('runtime handoff auth ticket durability', () => {
  it('pins both Redis transitions to the absolute Mongo deadline', () => {
    expect(__runtimeAuthTicket.SYNC_ISSUED_SCRIPT).toContain('PEXPIREAT')
    expect(__runtimeAuthTicket.SYNC_CONSUMED_SCRIPT).toContain('PEXPIREAT')
    expect(__runtimeAuthTicket.SYNC_ISSUED_SCRIPT).not.toContain("'PX'")
    expect(__runtimeAuthTicket.SYNC_CONSUMED_SCRIPT).not.toContain("'PX'")
  })

  it('issues one deterministic ticket and one Redis record across concurrent retries', async () => {
    const tickets = await Promise.all(
      Array.from({ length: 20 }, () => issueRuntimeAuthTicket(issueInput())),
    )

    expect(new Set(tickets).size).toBe(1)
    expect(tickets[0]).toMatch(new RegExp(`^${IDS.bindingId}[a-f0-9]{40}$`))
    expect(redisRecords.size).toBe(1)
    expect([...redisRecords.keys()]).toEqual([
      `${__runtimeAuthTicket.RUNTIME_TICKET_PREFIX}${IDS.bindingId}`,
    ])
    expect(binding.authTicketGeneration).toBe(1)
    expect(binding.authTicketState).toBe('issued')
  })

  it('repairs an evicted Redis record without minting a second ticket or extending expiry', async () => {
    const first = await issueRuntimeAuthTicket(issueInput())
    const durableExpiry = binding.authTicketExpiresAt?.getTime()
    redisRecords.clear()

    const retry = await issueRuntimeAuthTicket(issueInput())

    expect(retry).toBe(first)
    expect(binding.authTicketExpiresAt?.getTime()).toBe(durableExpiry)
    expect(redisRecords.size).toBe(1)
    expect(JSON.parse([...redisRecords.values()][0])).toMatchObject({
      generation: 1,
      state: 'issued',
      expiresAtMs: durableExpiry,
    })
  })

  it('allows exactly one Mongo redemption winner under concurrency', async () => {
    const ticket = String(await issueRuntimeAuthTicket(issueInput()))

    const outcomes = await Promise.all(
      Array.from({ length: 100 }, () => redeemRuntimeAuthTicket(ticket, NOW)),
    )

    expect(outcomes.filter(Boolean)).toEqual([{
      userId: IDS.principalId,
      sessionId: IDS.roundId,
      organizationId: IDS.workspaceId,
    }])
    expect(binding.authTicketState).toBe('consumed')
    expect(JSON.parse([...redisRecords.values()][0]).state).toBe('consumed')
  })

  it('keeps a consumed generation terminal even when its Redis record is missing or resurrected', async () => {
    const ticket = String(await issueRuntimeAuthTicket(issueInput()))
    await expect(redeemRuntimeAuthTicket(ticket, NOW)).resolves.toBeTruthy()
    redisRecords.clear()

    await expect(issueRuntimeAuthTicket(issueInput())).resolves.toBe(
      RUNTIME_AUTH_TICKET_CONSUMED,
    )
    expect(JSON.parse([...redisRecords.values()][0]).state).toBe('consumed')

    redisRecords.set(
      `${__runtimeAuthTicket.RUNTIME_TICKET_PREFIX}${IDS.bindingId}`,
      JSON.stringify({
        version: 2,
        generation: 1,
        state: 'issued',
        digest: binding.authTicketDigest,
        expiresAtMs: binding.authTicketExpiresAt?.getTime(),
      }),
    )
    await expect(redeemRuntimeAuthTicket(ticket, NOW)).resolves.toBeNull()
    await expect(issueRuntimeAuthTicket(issueInput())).resolves.toBe(
      RUNTIME_AUTH_TICKET_CONSUMED,
    )
  })

  it('recovers with a strictly newer handoff generation while the old ticket remains dead', async () => {
    const oldTicket = String(await issueRuntimeAuthTicket(issueInput()))
    await redeemRuntimeAuthTicket(oldTicket, NOW)
    const freshIssuedAt = new Date(NOW.getTime() + 1_000)

    const freshTicket = await issueRuntimeAuthTicket(
      issueInput(2, NONCE_2, freshIssuedAt),
    )

    expect(freshTicket).toMatch(/^[a-f0-9]{64}$/)
    expect(freshTicket).not.toBe(oldTicket)
    expect(binding.authTicketGeneration).toBe(2)
    await expect(redeemRuntimeAuthTicket(oldTicket, NOW)).resolves.toBeNull()
    await expect(redeemRuntimeAuthTicket(String(freshTicket), NOW)).resolves.toBeTruthy()
  })

  it('rejects lower generations and equal-generation nonce conflicts', async () => {
    await issueRuntimeAuthTicket(issueInput(2, NONCE_2, new Date(NOW.getTime() + 1_000)))

    await expect(issueRuntimeAuthTicket(issueInput())).resolves.toBe(
      RUNTIME_AUTH_TICKET_CONSUMED,
    )
    await expect(
      issueRuntimeAuthTicket(issueInput(2, 'c'.repeat(64), new Date(NOW.getTime() + 1_000))),
    ).rejects.toBeInstanceOf(RuntimeAuthTicketError)
  })

  it('repairs a crash after Mongo issuance and never changes the durable ticket tuple', async () => {
    mocks.redisEval.mockRejectedValueOnce(new Error('redis unavailable'))

    await expect(issueRuntimeAuthTicket(issueInput())).resolves.toBeNull()
    const digestAfterCrash = binding.authTicketDigest
    installRedisStateMachine()

    const recovered = await issueRuntimeAuthTicket(issueInput())
    expect(recovered).toMatch(/^[a-f0-9]{64}$/)
    expect(binding.authTicketDigest).toBe(digestAfterCrash)
    expect(redisRecords.size).toBe(1)
  })

  it('returns the Mongo redemption winner when the post-consume Redis update fails', async () => {
    const ticket = String(await issueRuntimeAuthTicket(issueInput()))
    mocks.redisEval.mockRejectedValueOnce(new Error('redis unavailable'))

    await expect(redeemRuntimeAuthTicket(ticket, NOW)).resolves.toEqual({
      userId: IDS.principalId,
      sessionId: IDS.roundId,
      organizationId: IDS.workspaceId,
    })
    await expect(redeemRuntimeAuthTicket(ticket, NOW)).resolves.toBeNull()
    expect(binding.authTicketState).toBe('consumed')
  })

  it('does not return a delayed old ticket after a newer generation rotates the binding', async () => {
    let releaseOldRedis!: () => void
    const oldRedisBlocked = new Promise<void>((resolve) => {
      releaseOldRedis = resolve
    })
    const ordinaryRedis = mocks.redisEval.getMockImplementation()!
    mocks.redisEval.mockImplementationOnce(async (...args: unknown[]) => {
      await oldRedisBlocked
      return ordinaryRedis(...args)
    })

    const oldIssue = issueRuntimeAuthTicket(issueInput())
    await vi.waitFor(() => expect(binding.authTicketGeneration).toBe(1))
    const fresh = await issueRuntimeAuthTicket(
      issueInput(2, NONCE_2, new Date(NOW.getTime() + 1_000)),
    )
    releaseOldRedis()

    expect(fresh).toMatch(/^[a-f0-9]{64}$/)
    expect([null, RUNTIME_AUTH_TICKET_CONSUMED]).toContain(await oldIssue)
    expect(binding.authTicketGeneration).toBe(2)
  })

  it('fails redemption closed if revocation or privacy purge wins first', async () => {
    const ticket = String(await issueRuntimeAuthTicket(issueInput()))
    binding.status = 'revoked'
    binding.revokedAt = NOW
    await expect(redeemRuntimeAuthTicket(ticket, NOW)).resolves.toBeNull()

    binding.status = 'active'
    delete binding.revokedAt
    binding.purgePersonalData = true
    await expect(redeemRuntimeAuthTicket(ticket, NOW)).resolves.toBeNull()
  })
})
