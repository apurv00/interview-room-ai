import { createHmac, timingSafeEqual } from 'node:crypto'
import mongoose from 'mongoose'
import { HireCandidate } from '../models/HireCandidate'
import { HireEmailOutbox } from '../models/HireEmailOutbox'
import { HireReengagementOptOut } from '../models/HireReengagementOptOut'
import { connectHireControlDB } from './hireControlBoundary'
import {
  claimHireCandidatePiiWriteFence,
  HireCandidatePiiTombstoneError,
} from './hireCandidatePrivacyWriteFence'

const OBJECT_ID = /^[a-f0-9]{24}$/i
const CAPABILITY_VERSION = 1
const CAPABILITY_TYPE = 'hire_reengagement_opt_out'
export const HIRE_REENGAGEMENT_OPT_OUT_TTL_MS = 365 * 24 * 60 * 60 * 1_000

interface HireReengagementOptOutCapabilityPayload {
  v: number
  typ: typeof CAPABILITY_TYPE
  workspaceId: string
  candidateId: string
  outboxId: string
  exp: number
}

/** Raised only for a server-side misconfiguration, never surfaced verbatim. */
export class HireReengagementOptOutConfigurationError extends Error {
  constructor() {
    super('Hire re-engagement opt-out capability is not configured')
    this.name = 'HireReengagementOptOutConfigurationError'
  }
}

function capabilitySecret(): string {
  const secret = process.env.HIRE_REENGAGEMENT_OPT_OUT_SECRET?.trim()
  // A short secret is effectively a configuration mistake. There is no
  // fallback: emailing without a durable opt-out route is not acceptable.
  if (!secret || secret.length < 32) {
    throw new HireReengagementOptOutConfigurationError()
  }
  return secret
}

function sign(encodedPayload: string): string {
  return createHmac('sha256', capabilitySecret())
    .update(encodedPayload)
    .digest('base64url')
}

function hasExactObjectId(value: unknown): value is string {
  return typeof value === 'string' && OBJECT_ID.test(value)
}

function parseCapabilityPayload(value: unknown, now: Date): HireReengagementOptOutCapabilityPayload | null {
  if (!value || typeof value !== 'object') return null
  const payload = value as Partial<HireReengagementOptOutCapabilityPayload>
  if (
    payload.v !== CAPABILITY_VERSION ||
    payload.typ !== CAPABILITY_TYPE ||
    !hasExactObjectId(payload.workspaceId) ||
    !hasExactObjectId(payload.candidateId) ||
    !hasExactObjectId(payload.outboxId) ||
    typeof payload.exp !== 'number' ||
    !Number.isSafeInteger(payload.exp) ||
    payload.exp <= now.getTime()
  ) {
    return null
  }
  return payload as HireReengagementOptOutCapabilityPayload
}

/**
 * A stateless Hire-only capability. It is not an authentication session, is
 * not stored in Mongo, and is scoped to the exact outbox row that delivered
 * it. Its HMAC key is separate from B2C and public-apply capability secrets.
 */
export function mintHireReengagementOptOutCapability(input: {
  workspaceId: string
  candidateId: string
  outboxId: string
  now?: Date
  ttlMs?: number
}): string {
  if (
    !hasExactObjectId(input.workspaceId) ||
    !hasExactObjectId(input.candidateId) ||
    !hasExactObjectId(input.outboxId)
  ) {
    throw new Error('Cannot mint a re-engagement opt-out capability for an invalid coordinate')
  }
  const now = input.now ?? new Date()
  const ttlMs = input.ttlMs ?? HIRE_REENGAGEMENT_OPT_OUT_TTL_MS
  if (!Number.isFinite(ttlMs) || ttlMs <= 0) {
    throw new Error('Re-engagement opt-out capability lifetime must be positive')
  }
  const payload: HireReengagementOptOutCapabilityPayload = {
    v: CAPABILITY_VERSION,
    typ: CAPABILITY_TYPE,
    workspaceId: input.workspaceId.toLowerCase(),
    candidateId: input.candidateId.toLowerCase(),
    outboxId: input.outboxId.toLowerCase(),
    exp: now.getTime() + ttlMs,
  }
  const encoded = Buffer.from(JSON.stringify(payload)).toString('base64url')
  return `${encoded}.${sign(encoded)}`
}

/** Returns no coordinate for invalid, forged, or expired values. */
export function verifyHireReengagementOptOutCapability(
  capability: string | null | undefined,
  now = new Date(),
): HireReengagementOptOutCapabilityPayload | null {
  if (!capability || capability.length > 2_000) return null
  const [encoded, providedSignature, ...extra] = capability.split('.')
  if (!encoded || !providedSignature || extra.length > 0) return null
  const expectedSignature = sign(encoded)
  const providedBytes = Buffer.from(providedSignature, 'base64url')
  const expectedBytes = Buffer.from(expectedSignature, 'base64url')
  if (
    providedBytes.length !== expectedBytes.length ||
    !timingSafeEqual(providedBytes, expectedBytes)
  ) {
    return null
  }
  try {
    return parseCapabilityPayload(
      JSON.parse(Buffer.from(encoded, 'base64url').toString('utf8')),
      now,
    )
  } catch {
    return null
  }
}

function publicHireOrigin(): string {
  // HIRE_PUBLIC_URL is already a readiness-validated control hostname. The
  // hard-coded production hostname is only the documented fallback for local
  // test dispatch; deployments may set HIRE_PUBLIC_ORIGIN for a distinct
  // HTTPS public alias without storing that alias or any capability in Mongo.
  const configured =
    process.env.HIRE_PUBLIC_ORIGIN?.trim() ||
    process.env.HIRE_PUBLIC_URL?.trim()
  const candidate = configured || 'https://hire.interviewprep.guru'
  let parsed: URL
  try {
    parsed = new URL(candidate)
  } catch {
    throw new HireReengagementOptOutConfigurationError()
  }
  if (
    parsed.protocol !== 'https:' ||
    parsed.username ||
    parsed.password ||
    parsed.pathname !== '/' ||
    parsed.search ||
    parsed.hash
  ) {
    throw new HireReengagementOptOutConfigurationError()
  }
  return parsed.origin
}

export function buildHireReengagementOptOutUrl(input: {
  workspaceId: string
  candidateId: string
  outboxId: string
  now?: Date
}): string {
  const url = new URL('/api/candidate/reengagement/opt-out', publicHireOrigin())
  url.searchParams.set(
    'capability',
    mintHireReengagementOptOutCapability(input),
  )
  return url.toString()
}

/**
 * Records an unsubscribe choice without resolving a B2C account or session.
 * The exact candidate/outbox coordinate must still exist, so a stale link
 * cannot recreate a record after retention or privacy deletion removed it.
 */
export async function applyHireReengagementOptOut(input: {
  capability: string | null | undefined
  now?: Date
}): Promise<{ accepted: boolean }> {
  const now = input.now ?? new Date()
  const payload = verifyHireReengagementOptOutCapability(input.capability, now)
  if (!payload) return { accepted: false }

  await connectHireControlDB()
  const session = await mongoose.startSession()
  try {
    let accepted = false
    await session.withTransaction(async () => {
      const scope = {
        workspaceId: new mongoose.Types.ObjectId(payload.workspaceId),
        candidateId: new mongoose.Types.ObjectId(payload.candidateId),
      }
      // MongoDB transactions do not permit concurrent session operations.
      // Keep these sequential even though they are independent reads.
      const candidate = await HireCandidate.findOne({
        ...scope,
        piiAnonymizedAt: { $exists: false },
      })
        .select('_id')
        .session(session)
      const outbox = await HireEmailOutbox.exists({
        _id: payload.outboxId,
        ...scope,
        kind: 'job_reengagement',
      }).session(session)
      if (!candidate || !outbox) return

      try {
        await claimHireCandidatePiiWriteFence({
          ...scope,
          session,
        })
      } catch (error) {
        if (error instanceof HireCandidatePiiTombstoneError) return
        throw error
      }

      await HireReengagementOptOut.updateOne(
        scope,
        { $setOnInsert: { ...scope, optedOutAt: now } },
        { upsert: true, session },
      )
      // Pending mail can be cancelled immediately. A worker that already
      // claimed a row rechecks this opt-out just before provider dispatch.
      await HireEmailOutbox.updateMany(
        {
          ...scope,
          kind: 'job_reengagement',
          status: 'pending',
        },
        {
          $set: {
            status: 'cancelled',
            lastError: 'Candidate opted out of talent-pool re-engagement',
          },
        },
        { session },
      )
      accepted = true
    })
    return { accepted }
  } finally {
    await session.endSession()
  }
}
