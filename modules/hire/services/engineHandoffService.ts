import { createHash, randomBytes } from 'node:crypto'
import mongoose from 'mongoose'
import {
  HIRE_ENGINE_BRIDGE_SCHEMA_VERSION,
  HireEngineConfigSchema,
  HireEngineExchangeRequestSchema,
  type HireEngineConfig,
  type HireEngineHandoffEnvelope,
} from '@shared/contracts/hireEngineBridge'
import { HireEngineHandoff } from '../models/HireEngineHandoff'
import { HireRound } from '../models/HireRound'
import { HireWorkspace } from '../models/HireWorkspace'
import { connectHireControlDB } from './hireControlBoundary'
import {
  decodeWorkspaceCapability,
  encodeWorkspaceCapability,
} from './workspaceCapability'

const HANDOFF_TTL_SECONDS = 60

export class HireEngineHandoffError extends Error {
  constructor(
    message: string,
    readonly code: 'invalid' | 'expired' | 'conflict' | 'unconfigured',
    readonly status: number,
  ) {
    super(message)
    this.name = 'HireEngineHandoffError'
  }
}

function digest(value: string): string {
  return createHash('sha256').update(value).digest('hex')
}

function runtimeBaseUrl(): string {
  const raw = process.env.HIRE_ENGINE_RUNTIME_URL
  if (!raw) {
    throw new HireEngineHandoffError(
      'Hire engine runtime URL is not configured',
      'unconfigured',
      503,
    )
  }
  const url = new URL(raw)
  if (process.env.NODE_ENV === 'production' && url.protocol !== 'https:') {
    throw new HireEngineHandoffError('Runtime URL must use HTTPS', 'unconfigured', 503)
  }
  url.pathname = '/'
  url.search = ''
  url.hash = ''
  return url.toString().replace(/\/$/, '')
}

export interface IssueHireEngineHandoffInput {
  workspaceId: string
  applicationId: string
  roundId: string
  config: HireEngineConfig
  consentVersion: string
  consentAt: Date
  inviteExpiresAt: Date
  now?: Date
}

export async function issueHireEngineHandoff(
  input: IssueHireEngineHandoffInput,
): Promise<{ code: string; handoffUrl: string; expiresAt: Date }> {
  await connectHireControlDB()
  const now = input.now ?? new Date()
  if (input.consentAt > now || input.inviteExpiresAt <= now) {
    throw new HireEngineHandoffError('Round is not eligible for handoff', 'expired', 410)
  }
  for (const id of [input.workspaceId, input.applicationId, input.roundId]) {
    if (!mongoose.Types.ObjectId.isValid(id)) {
      throw new HireEngineHandoffError('Invalid Hire coordinate', 'invalid', 400)
    }
  }
  const config = HireEngineConfigSchema.parse(input.config)
  const secret = randomBytes(32).toString('hex')
  const code = encodeWorkspaceCapability(input.workspaceId, secret)
  const expiresAt = new Date(
    Math.min(input.inviteExpiresAt.getTime(), now.getTime() + HANDOFF_TTL_SECONDS * 1_000),
  )

  // Serialize runtime-authority creation against workspace deletion and round
  // revocation. This must be one transaction: a lifecycle read followed by a
  // separate handoff insert would permit a just-deleted workspace to mint a
  // fresh runtime capability from an in-flight request.
  const dbSession = await mongoose.startSession()
  try {
    await dbSession.withTransaction(async () => {
      const workspaceFence = await HireWorkspace.updateOne(
        {
          _id: input.workspaceId,
          $or: [
            { lifecycleState: 'active' },
            { lifecycleState: { $exists: false } },
          ],
        },
        { $inc: { writeFenceVersion: 1 } },
        { session: dbSession },
      )
      if (workspaceFence.matchedCount !== 1) {
        throw new HireEngineHandoffError(
          'This engine handoff is no longer valid',
          'expired',
          410,
        )
      }
      const liveRound = await HireRound.exists({
        _id: input.roundId,
        workspaceId: input.workspaceId,
        applicationId: input.applicationId,
        inviteTokenExpiry: { $gt: now },
        revokedAt: { $exists: false },
        status: { $nin: ['completed', 'revoked'] },
        consentVersion: input.consentVersion,
        consentAt: input.consentAt,
      }).session(dbSession)
      if (!liveRound) {
        throw new HireEngineHandoffError(
          'This engine handoff is no longer valid',
          'expired',
          410,
        )
      }

      // A fresh exchange supersedes any unredeemed code for this exact round.
      await HireEngineHandoff.updateMany(
        {
          workspaceId: input.workspaceId,
          applicationId: input.applicationId,
          roundId: input.roundId,
          redeemedAt: { $exists: false },
          revokedAt: { $exists: false },
        },
        { $set: { revokedAt: now } },
        { session: dbSession },
      )
      await HireEngineHandoff.create(
        [{
          workspaceId: input.workspaceId,
          applicationId: input.applicationId,
          roundId: input.roundId,
          codeHash: digest(secret),
          config,
          consentVersion: input.consentVersion,
          consentAt: input.consentAt,
          inviteExpiresAt: input.inviteExpiresAt,
          expiresAt,
        }],
        { session: dbSession },
      )
    })
  } finally {
    await dbSession.endSession()
  }

  const handoffUrl = new URL('/handoff', runtimeBaseUrl())
  handoffUrl.hash = `code=${encodeURIComponent(code)}`
  return { code, handoffUrl: handoffUrl.toString(), expiresAt }
}

export async function exchangeHireEngineHandoff(
  rawInput: unknown,
  now = new Date(),
): Promise<HireEngineHandoffEnvelope> {
  await connectHireControlDB()
  const input = HireEngineExchangeRequestSchema.parse(rawInput)
  const capability = decodeWorkspaceCapability(input.code)
  if (!capability) {
    throw new HireEngineHandoffError(
      'This engine handoff is no longer valid',
      'invalid',
      400,
    )
  }
  const codeHash = digest(capability.secret)
  const handoff = await HireEngineHandoff.findOneAndUpdate(
    {
      workspaceId: capability.workspaceId,
      codeHash,
      expiresAt: { $gt: now },
      inviteExpiresAt: { $gt: now },
      revokedAt: { $exists: false },
      $or: [
        { requestBindingHash: { $exists: false } },
        { requestBindingHash: input.requestId },
      ],
    },
    {
      $set: {
        requestBindingHash: input.requestId,
        redeemedBy: input.requestId,
        redeemedAt: now,
      },
    },
    { new: true },
  )
  if (!handoff) {
    // Uniform response: callers cannot distinguish nonexistent, expired,
    // revoked, or already consumed by a different exchange request.
    throw new HireEngineHandoffError(
      'This engine handoff is no longer valid',
      'expired',
      410,
    )
  }

  const envelopeExpiresAt = new Date(
    Math.min(handoff.expiresAt.getTime(), now.getTime() + HANDOFF_TTL_SECONDS * 1_000),
  )
  // `config` is a hydrated Mongoose subdocument here. Zod's strict object
  // parser correctly rejects its enumerable document helpers, so cross the
  // internal-API seam with a plain object rather than the persistence wrapper.
  const storedConfig =
    handoff.config && typeof (handoff.config as { toObject?: unknown }).toObject === 'function'
      ? (handoff.config as unknown as { toObject: () => unknown }).toObject()
      : handoff.config
  return {
    schemaVersion: HIRE_ENGINE_BRIDGE_SCHEMA_VERSION,
    workspaceId: handoff.workspaceId.toString(),
    applicationId: handoff.applicationId.toString(),
    roundId: handoff.roundId.toString(),
    nonce: digest(`${handoff.codeHash}:${input.requestId}`),
    issuedAt: now.toISOString(),
    expiresAt: envelopeExpiresAt.toISOString(),
    inviteExpiresAt: handoff.inviteExpiresAt.toISOString(),
    consentVersion: handoff.consentVersion,
    consentAt: handoff.consentAt.toISOString(),
    config: HireEngineConfigSchema.parse(storedConfig),
  }
}

export const __engineHandoff = { HANDOFF_TTL_SECONDS, digest }
