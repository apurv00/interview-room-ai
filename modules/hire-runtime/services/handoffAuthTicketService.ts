import { createHash, createHmac } from 'node:crypto'
import mongoose from 'mongoose'
import type { HireEngineHandoffEnvelope } from '@shared/contracts/hireEngineBridge'
import { redis } from '@shared/redis'
import { authLogger } from '@shared/logger'
import { HireRuntimeBinding } from '../models/HireRuntimeBinding'
import { connectHireRuntimeDB } from './runtimeBoundary'

const RUNTIME_TICKET_PREFIX = 'auth:hire-runtime-ticket:v2:'
const RUNTIME_TICKET_PATTERN = /^[a-f0-9]{64}$/
const SHA256_PATTERN = /^[a-f0-9]{64}$/
const TICKET_DOMAIN = 'ipg-hire-runtime-auth-ticket:v2'
const MAX_ISSUE_CAS_ATTEMPTS = 5

export const RUNTIME_AUTH_TICKET_CONSUMED = 'consumed' as const

const SYNC_ISSUED_SCRIPT = `
local existing = redis.call('GET', KEYS[1])
if existing then
  local decoded, value = pcall(cjson.decode, existing)
  if decoded and type(value) == 'table' then
    local storedGeneration = tonumber(value.generation)
    local incomingGeneration = tonumber(ARGV[1])
    if storedGeneration and storedGeneration > incomingGeneration then
      return 'stale'
    end
    if storedGeneration and storedGeneration == incomingGeneration then
      if value.digest ~= ARGV[2] then
        return 'conflict'
      end
      if value.state == 'consumed' then
        return 'consumed'
      end
      return 'issued'
    end
  end
end
redis.call('SET', KEYS[1], ARGV[3])
redis.call('PEXPIREAT', KEYS[1], ARGV[4])
return 'issued'
`

const SYNC_CONSUMED_SCRIPT = `
local existing = redis.call('GET', KEYS[1])
if existing then
  local decoded, value = pcall(cjson.decode, existing)
  if decoded and type(value) == 'table' then
    local storedGeneration = tonumber(value.generation)
    local incomingGeneration = tonumber(ARGV[1])
    if storedGeneration and storedGeneration > incomingGeneration then
      return 'stale'
    end
    if storedGeneration and storedGeneration == incomingGeneration then
      if value.digest ~= ARGV[2] then
        return 'conflict'
      end
      if value.state == 'consumed' then
        return 'consumed'
      end
    end
  end
end
redis.call('SET', KEYS[1], ARGV[3])
redis.call('PEXPIREAT', KEYS[1], ARGV[4])
return 'consumed'
`

export interface RuntimeAuthTicketPayload {
  userId: string
  sessionId: string
  organizationId: string
}

export interface IssueRuntimeAuthTicketInput {
  bindingId: string
  workspaceId: string
  principalId: string
  roundId: string
  envelope: Pick<
    HireEngineHandoffEnvelope,
    'handoffGeneration' | 'nonce' | 'issuedAt' | 'expiresAt'
  >
  now?: Date
}

export class RuntimeAuthTicketError extends Error {
  constructor(
    message: string,
    readonly code: 'invalid' | 'conflict',
    readonly status: number,
  ) {
    super(message)
    this.name = 'RuntimeAuthTicketError'
  }
}

function digest(value: string): string {
  return createHash('sha256').update(value).digest('hex')
}

function runtimeTicketSigningKey(): Buffer {
  const secret = process.env.HIRE_RUNTIME_NEXTAUTH_SECRET?.trim() ?? ''
  if (secret.length < 32) {
    throw new Error('Runtime auth ticket signing key is not configured')
  }
  return createHmac('sha256', secret)
    .update(`${TICKET_DOMAIN}:signing-key`)
    .digest()
}

function deriveTicket(input: {
  bindingId: string
  workspaceId: string
  principalId: string
  roundId: string
  generation: number
  handoffNonce: string
  issuedAt: Date
  expiresAt: Date
}): string {
  const proof = createHmac('sha256', runtimeTicketSigningKey())
    .update(TICKET_DOMAIN)
    .update('\0')
    .update(input.bindingId)
    .update('\0')
    .update(String(input.generation))
    .update('\0')
    .update(input.handoffNonce)
    .update('\0')
    .update(input.principalId)
    .update('\0')
    .update(input.roundId)
    .update('\0')
    .update(input.workspaceId)
    .update('\0')
    .update(input.issuedAt.toISOString())
    .update('\0')
    .update(String(input.expiresAt.getTime()))
    .digest('hex')
    .slice(0, 40)
  return `${input.bindingId}${proof}`
}

function redisRecord(input: {
  generation: number
  state: 'issued' | 'consumed'
  ticketDigest: string
  expiresAt: Date
}): string {
  return JSON.stringify({
    version: 2,
    generation: input.generation,
    state: input.state,
    digest: input.ticketDigest,
    expiresAtMs: input.expiresAt.getTime(),
  })
}

async function syncIssuedRecord(input: {
  bindingId: string
  generation: number
  ticketDigest: string
  expiresAt: Date
}): Promise<boolean> {
  const result = await redis.eval(
    SYNC_ISSUED_SCRIPT,
    1,
    `${RUNTIME_TICKET_PREFIX}${input.bindingId}`,
    String(input.generation),
    input.ticketDigest,
    redisRecord({
      generation: input.generation,
      state: 'issued',
      ticketDigest: input.ticketDigest,
      expiresAt: input.expiresAt,
    }),
    String(input.expiresAt.getTime()),
  )
  return result === 'issued'
}

async function syncConsumedRecord(input: {
  bindingId: string
  generation: number
  ticketDigest: string
  expiresAt: Date
}): Promise<void> {
  try {
    const result = await redis.eval(
      SYNC_CONSUMED_SCRIPT,
      1,
      `${RUNTIME_TICKET_PREFIX}${input.bindingId}`,
      String(input.generation),
      input.ticketDigest,
      redisRecord({
        generation: input.generation,
        state: 'consumed',
        ticketDigest: input.ticketDigest,
        expiresAt: input.expiresAt,
      }),
      String(input.expiresAt.getTime()),
    )
    if (result === 'conflict') {
      authLogger.error('runtime auth ticket mirror conflict after redemption')
    }
  } catch (error) {
    authLogger.error(
      { errorName: error instanceof Error ? error.constructor.name : 'UnknownError' },
      'runtime auth ticket consumed in Mongo but Redis mirror update failed',
    )
  }
}

function validatedIssueInput(input: IssueRuntimeAuthTicketInput, now: Date) {
  const ids = [input.bindingId, input.workspaceId, input.principalId, input.roundId]
  if (ids.some((id) => !mongoose.Types.ObjectId.isValid(id))) {
    throw new RuntimeAuthTicketError('Invalid runtime auth ticket scope', 'invalid', 400)
  }
  if (
    !Number.isSafeInteger(input.envelope.handoffGeneration) ||
    input.envelope.handoffGeneration < 1 ||
    !SHA256_PATTERN.test(input.envelope.nonce)
  ) {
    throw new RuntimeAuthTicketError('Invalid runtime handoff generation', 'invalid', 400)
  }
  const issuedAt = new Date(input.envelope.issuedAt)
  const expiresAt = new Date(input.envelope.expiresAt)
  if (
    !Number.isFinite(issuedAt.getTime()) ||
    !Number.isFinite(expiresAt.getTime()) ||
    expiresAt <= now
  ) {
    throw new RuntimeAuthTicketError('Runtime handoff expired', 'invalid', 410)
  }
  return {
    bindingId: input.bindingId.toLowerCase(),
    workspaceId: input.workspaceId.toLowerCase(),
    principalId: input.principalId.toLowerCase(),
    roundId: input.roundId.toLowerCase(),
    generation: input.envelope.handoffGeneration,
    handoffNonce: input.envelope.nonce.toLowerCase(),
    issuedAt,
    expiresAt,
  }
}

export async function issueRuntimeAuthTicket(
  rawInput: IssueRuntimeAuthTicketInput,
): Promise<string | typeof RUNTIME_AUTH_TICKET_CONSUMED | null> {
  const now = rawInput.now ?? new Date()
  const input = validatedIssueInput(rawInput, now)
  const ticket = deriveTicket(input)
  const ticketDigest = digest(ticket)
  await connectHireRuntimeDB()

  const liveScope = {
    _id: input.bindingId,
    workspaceId: input.workspaceId,
    principalId: input.principalId,
    roundId: input.roundId,
    status: { $in: ['provisioned', 'active'] },
    revokedAt: { $exists: false },
    purgePersonalData: { $ne: true },
    inviteExpiresAt: { $gt: now },
  }

  for (let attempt = 0; attempt < MAX_ISSUE_CAS_ATTEMPTS; attempt += 1) {
    const rotated = await HireRuntimeBinding.findOneAndUpdate(
      {
        ...liveScope,
        $or: [
          { authTicketGeneration: { $exists: false } },
          { authTicketGeneration: { $lt: input.generation } },
        ],
      },
      {
        $set: {
          authTicketGeneration: input.generation,
          authTicketHandoffNonce: input.handoffNonce,
          authTicketState: 'issued',
          authTicketDigest: ticketDigest,
          authTicketExpiresAt: input.expiresAt,
          authTicketIssuedAt: input.issuedAt,
        },
        $unset: { authTicketConsumedAt: 1 },
      },
      { new: true },
    )

    const current = rotated ?? await HireRuntimeBinding.findOne(liveScope)
    if (!current) return RUNTIME_AUTH_TICKET_CONSUMED

    const currentGeneration = current.authTicketGeneration
    if (currentGeneration === undefined || currentGeneration < input.generation) {
      continue
    }
    if (currentGeneration > input.generation) {
      return RUNTIME_AUTH_TICKET_CONSUMED
    }
    if (
      current.authTicketHandoffNonce !== input.handoffNonce ||
      current.authTicketDigest !== ticketDigest ||
      current.authTicketIssuedAt?.getTime() !== input.issuedAt.getTime() ||
      current.authTicketExpiresAt?.getTime() !== input.expiresAt.getTime()
    ) {
      throw new RuntimeAuthTicketError(
        'Runtime handoff generation conflicts with durable auth state',
        'conflict',
        409,
      )
    }
    if (
      current.authTicketState === 'consumed' ||
      !current.authTicketExpiresAt ||
      current.authTicketExpiresAt <= now
    ) {
      if (current.authTicketExpiresAt && current.authTicketExpiresAt > now) {
        await syncConsumedRecord({
          bindingId: input.bindingId,
          generation: input.generation,
          ticketDigest,
          expiresAt: current.authTicketExpiresAt,
        })
      }
      return RUNTIME_AUTH_TICKET_CONSUMED
    }
    if (current.authTicketState !== 'issued') {
      throw new RuntimeAuthTicketError(
        'Runtime auth ticket state is incomplete',
        'conflict',
        409,
      )
    }

    try {
      if (!await syncIssuedRecord({
        bindingId: input.bindingId,
        generation: input.generation,
        ticketDigest,
        expiresAt: input.expiresAt,
      })) {
        return null
      }
    } catch (error) {
      authLogger.error(
        { errorName: error instanceof Error ? error.constructor.name : 'UnknownError' },
        'runtime auth ticket persisted in Mongo but Redis mirror update failed',
      )
      return null
    }

    // A newer recovery link can rotate the tuple while this request is
    // syncing Redis. Re-read the exact issued tuple before returning so a
    // delayed response never hands the browser an already-superseded ticket.
    const stillCurrent = await HireRuntimeBinding.exists({
      ...liveScope,
      authTicketGeneration: input.generation,
      authTicketHandoffNonce: input.handoffNonce,
      authTicketState: 'issued',
      authTicketDigest: ticketDigest,
      authTicketExpiresAt: input.expiresAt,
      authTicketIssuedAt: input.issuedAt,
    })
    return stillCurrent ? ticket : RUNTIME_AUTH_TICKET_CONSUMED
  }

  return null
}

export async function redeemRuntimeAuthTicket(
  ticket: string,
  now = new Date(),
): Promise<RuntimeAuthTicketPayload | null> {
  if (!RUNTIME_TICKET_PATTERN.test(ticket)) return null
  const bindingId = ticket.slice(0, 24)
  if (!mongoose.Types.ObjectId.isValid(bindingId)) return null
  const ticketDigest = digest(ticket)
  await connectHireRuntimeDB()

  const binding = await HireRuntimeBinding.findOneAndUpdate(
    {
      _id: bindingId,
      status: { $in: ['provisioned', 'active'] },
      revokedAt: { $exists: false },
      purgePersonalData: { $ne: true },
      inviteExpiresAt: { $gt: now },
      authTicketState: 'issued',
      authTicketDigest: ticketDigest,
      authTicketExpiresAt: { $gt: now },
    },
    {
      $set: {
        authTicketState: 'consumed',
        authTicketConsumedAt: now,
      },
    },
    { new: false },
  )
  if (
    !binding ||
    binding.authTicketGeneration === undefined ||
    !binding.authTicketExpiresAt
  ) {
    return null
  }

  await syncConsumedRecord({
    bindingId,
    generation: binding.authTicketGeneration,
    ticketDigest,
    expiresAt: binding.authTicketExpiresAt,
  })

  return {
    userId: binding.principalId.toString(),
    sessionId: binding.roundId.toString(),
    organizationId: binding.workspaceId.toString(),
  }
}

export const __runtimeAuthTicket = {
  RUNTIME_TICKET_PREFIX,
  RUNTIME_TICKET_PATTERN,
  SYNC_ISSUED_SCRIPT,
  SYNC_CONSUMED_SCRIPT,
  deriveTicket,
  digest,
}
