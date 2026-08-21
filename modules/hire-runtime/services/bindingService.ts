import { createHash, randomBytes } from 'node:crypto'
import mongoose from 'mongoose'
import {
  canonicalBridgeJson,
  HireEngineHandoffEnvelopeSchema,
  type HireEngineHandoffEnvelope,
} from '@shared/contracts/hireEngineBridge'
import { InterviewSession } from '@shared/db/models/InterviewSession'
import { User } from '@shared/db/models/User'
import {
  HireRuntimeBinding,
  type IHireRuntimeBinding,
} from '../models/HireRuntimeBinding'
import { HireRuntimeRevocation } from '../models/HireRuntimeRevocation'
import { connectHireRuntimeDB } from './runtimeBoundary'
import { runtimePrincipalEmail } from './runtimePrincipalService'

// Session creation can run inside a 300-second Vercel function while the
// unchanged engine parses the JD. Keep the lease beyond that ceiling so a
// privacy purge can never acknowledge while a creator is still able to land.
const SESSION_LEASE_MS = 6 * 60 * 1_000

export class HireRuntimeBindingError extends Error {
  constructor(
    message: string,
    readonly code: 'expired' | 'revoked' | 'conflict' | 'not_found' | 'busy',
    readonly status: number,
  ) {
    super(message)
    this.name = 'HireRuntimeBindingError'
  }
}

export function runtimePrincipalIdForRound(roundId: string): mongoose.Types.ObjectId {
  const hex = createHash('sha256')
    .update(`ipg-hire-runtime-principal:v1:${roundId.toLowerCase()}`)
    .digest('hex')
    .slice(0, 24)
  return new mongoose.Types.ObjectId(hex)
}

function assertEnvelopeCurrent(envelope: HireEngineHandoffEnvelope, now: Date) {
  if (
    new Date(envelope.expiresAt) <= now ||
    new Date(envelope.inviteExpiresAt) <= now ||
    new Date(envelope.consentAt) > now
  ) {
    throw new HireRuntimeBindingError('Engine handoff expired', 'expired', 410)
  }
}

export async function provisionRuntimeBinding(
  rawEnvelope: unknown,
  now = new Date(),
): Promise<IHireRuntimeBinding> {
  const envelope = HireEngineHandoffEnvelopeSchema.parse(rawEnvelope)
  assertEnvelopeCurrent(envelope, now)
  await connectHireRuntimeDB()

  const coordinates = {
    workspaceId: envelope.workspaceId,
    applicationId: envelope.applicationId,
    roundId: envelope.roundId,
  }
  if (await HireRuntimeRevocation.exists(coordinates)) {
    throw new HireRuntimeBindingError('Round was revoked', 'revoked', 410)
  }
  const existing = await HireRuntimeBinding.findOne(coordinates)
  if (existing) {
    if (existing.status === 'revoked' || existing.revokedAt) {
      throw new HireRuntimeBindingError('Round was revoked', 'revoked', 410)
    }
    if (canonicalBridgeJson(existing.config) !== canonicalBridgeJson(envelope.config)) {
      throw new HireRuntimeBindingError(
        'Immutable runtime configuration changed',
        'conflict',
        409,
      )
    }
    return existing
  }

  try {
    const created = await HireRuntimeBinding.create({
      ...coordinates,
      principalId: runtimePrincipalIdForRound(envelope.roundId),
      handoffNonce: envelope.nonce,
      config: envelope.config,
      consentVersion: envelope.consentVersion,
      consentAt: new Date(envelope.consentAt),
      inviteExpiresAt: new Date(envelope.inviteExpiresAt),
      mediaCompletionContractVersion: 1,
      status: 'provisioned',
      attemptCount: 0,
    })
    // Close the tombstone/create race: either revoke sees the new binding,
    // or this post-create read sees the tombstone. There is no ordering in
    // which both checks miss one another.
    if (await HireRuntimeRevocation.exists(coordinates)) {
      await HireRuntimeBinding.updateOne(
        { _id: created._id, workspaceId: envelope.workspaceId },
        { $set: { status: 'revoked', revokedAt: new Date() } },
      )
      throw new HireRuntimeBindingError('Round was revoked', 'revoked', 410)
    }
    return created
  } catch (error: unknown) {
    if (error && typeof error === 'object' && (error as { code?: number }).code === 11000) {
      const winner = await HireRuntimeBinding.findOne(coordinates)
      if (winner) {
        if (winner.status === 'revoked' || winner.revokedAt) {
          throw new HireRuntimeBindingError('Round was revoked', 'revoked', 410)
        }
        return winner
      }
    }
    throw error
  }
}

export async function activateRuntimeBinding(
  input: { workspaceId: string; bindingId: string },
): Promise<IHireRuntimeBinding> {
  await connectHireRuntimeDB()
  const binding = await HireRuntimeBinding.findOneAndUpdate(
    {
      _id: input.bindingId,
      workspaceId: input.workspaceId,
      status: { $in: ['provisioned', 'active'] },
      revokedAt: { $exists: false },
      inviteExpiresAt: { $gt: new Date() },
    },
    { $set: { status: 'active' } },
    { new: true },
  )
  if (!binding) throw new HireRuntimeBindingError('Runtime binding unavailable', 'expired', 410)
  return binding
}

export async function activeBindingForPrincipal(
  input: { workspaceId: string; principalId: string; now?: Date },
): Promise<IHireRuntimeBinding> {
  await connectHireRuntimeDB()
  const binding = await HireRuntimeBinding.findOne({
    workspaceId: input.workspaceId,
    principalId: input.principalId,
    status: { $in: ['provisioned', 'active'] },
    revokedAt: { $exists: false },
    inviteExpiresAt: { $gt: input.now ?? new Date() },
  })
  if (!binding) throw new HireRuntimeBindingError('Runtime binding unavailable', 'not_found', 404)
  return binding
}

/**
 * Resolve the exact terminal-check authority after an engine session exists.
 * Unlike a new handoff/session claim, completion may legitimately happen after
 * invite expiry and the publisher may already have moved the binding to its
 * completed state. Revoked or privacy-purging bindings remain unavailable.
 */
export async function completionBindingForPrincipal(
  input: { workspaceId: string; principalId: string },
): Promise<IHireRuntimeBinding> {
  await connectHireRuntimeDB()
  const binding = await HireRuntimeBinding.findOne({
    workspaceId: input.workspaceId,
    principalId: input.principalId,
    runtimeSessionId: { $exists: true },
    status: { $in: ['active', 'completed'] },
    revokedAt: { $exists: false },
    purgePersonalData: { $ne: true },
  })
  if (!binding) {
    throw new HireRuntimeBindingError('Runtime binding unavailable', 'not_found', 404)
  }
  return binding
}

/**
 * Completion-page authority includes a privacy-terminal outcome so the last
 * authenticated tab can discard local IndexedDB media and sign out. Other
 * runtime callers keep the narrower completionBindingForPrincipal contract.
 */
export async function completionBoundaryForPrincipal(input: {
  workspaceId: string
  principalId: string
}): Promise<
  | { state: 'available'; binding: IHireRuntimeBinding }
  | { state: 'account_unavailable'; reason: 'revoked' | 'purging' }
> {
  await connectHireRuntimeDB()
  const binding = await HireRuntimeBinding.findOne({
    workspaceId: input.workspaceId,
    principalId: input.principalId,
  })
  if (!binding) {
    throw new HireRuntimeBindingError('Runtime binding unavailable', 'not_found', 404)
  }
  if (binding.purgePersonalData === true) {
    return { state: 'account_unavailable', reason: 'purging' }
  }
  if (binding.status === 'revoked' || binding.revokedAt) {
    return { state: 'account_unavailable', reason: 'revoked' }
  }
  if (binding.status !== 'active' && binding.status !== 'completed') {
    throw new HireRuntimeBindingError('Runtime binding unavailable', 'not_found', 404)
  }
  return { state: 'available', binding }
}

export async function acquireSessionProvisioningLease(
  input: { workspaceId: string; principalId: string; now?: Date },
): Promise<{ binding: IHireRuntimeBinding; leaseToken?: string }> {
  const now = input.now ?? new Date()
  const existing = await activeBindingForPrincipal({ ...input, now })
  if (existing.runtimeSessionId) return { binding: existing }

  const leaseToken = randomBytes(32).toString('hex')
  const binding = await HireRuntimeBinding.findOneAndUpdate(
    {
      _id: existing._id,
      workspaceId: input.workspaceId,
      runtimeSessionId: { $exists: false },
      status: { $in: ['provisioned', 'active'] },
      revokedAt: { $exists: false },
      $or: [
        { sessionLeaseToken: { $exists: false } },
        { sessionLeaseExpiresAt: { $lte: now } },
      ],
    },
    {
      $set: {
        sessionLeaseToken: leaseToken,
        sessionLeaseExpiresAt: new Date(now.getTime() + SESSION_LEASE_MS),
      },
    },
    { new: true },
  )
  if (!binding) {
    throw new HireRuntimeBindingError('Session provisioning is already in progress', 'busy', 409)
  }
  return { binding, leaseToken }
}

export async function attachRuntimeSession(input: {
  workspaceId: string
  bindingId: string
  leaseToken: string
  runtimeSessionId: string
}): Promise<IHireRuntimeBinding> {
  await connectHireRuntimeDB()
  const binding = await HireRuntimeBinding.findOneAndUpdate(
    {
      _id: input.bindingId,
      workspaceId: input.workspaceId,
      sessionLeaseToken: input.leaseToken,
      runtimeSessionId: { $exists: false },
      status: { $in: ['provisioned', 'active'] },
      revokedAt: { $exists: false },
    },
    {
      $set: {
        runtimeSessionId: input.runtimeSessionId,
        status: 'active',
      },
      $inc: { attemptCount: 1 },
      $unset: { sessionLeaseToken: 1, sessionLeaseExpiresAt: 1 },
    },
    { new: true },
  )
  if (!binding) {
    throw new HireRuntimeBindingError('Could not bind runtime session', 'conflict', 409)
  }
  return binding
}

/** Preserve a session created in the narrow create-vs-revoke race for audit/results. */
export async function attachRuntimeSessionAfterRevocation(input: {
  workspaceId: string
  bindingId: string
  runtimeSessionId: string
}): Promise<boolean> {
  await connectHireRuntimeDB()
  const discardAfterPrivacyRevocation = async (): Promise<boolean> => {
    const binding = await HireRuntimeBinding.findOne({
      _id: input.bindingId,
      workspaceId: input.workspaceId,
      status: 'revoked',
      purgePersonalData: true,
    })
      .select('principalId roundId')
      .lean()
    if (!binding) return false
    const deletedSession = await InterviewSession.deleteOne({
      _id: input.runtimeSessionId,
      userId: binding.principalId,
      organizationId: input.workspaceId,
    })
    if (!deletedSession.acknowledged) {
      throw new Error('Late runtime session privacy purge was not acknowledged')
    }
    const deletedUser = await User.deleteOne({
      _id: binding.principalId,
      email: runtimePrincipalEmail(binding.roundId.toString()),
      organizationId: input.workspaceId,
    })
    if (!deletedUser.acknowledged) {
      throw new Error('Late runtime principal privacy purge was not acknowledged')
    }
    return true
  }
  if (await discardAfterPrivacyRevocation()) return false

  const result = await HireRuntimeBinding.updateOne(
    {
      _id: input.bindingId,
      workspaceId: input.workspaceId,
      status: 'revoked',
      revokedAt: { $exists: true },
      purgePersonalData: { $ne: true },
      runtimeSessionId: { $exists: false },
    },
    {
      $set: { runtimeSessionId: input.runtimeSessionId },
      $inc: { attemptCount: 1 },
    },
  )
  if (result.matchedCount !== 1) {
    await discardAfterPrivacyRevocation()
  }
  return result.matchedCount === 1
}

export async function releaseSessionProvisioningLease(input: {
  workspaceId: string
  bindingId: string
  leaseToken: string
}): Promise<void> {
  await connectHireRuntimeDB()
  await HireRuntimeBinding.updateOne(
    {
      _id: input.bindingId,
      workspaceId: input.workspaceId,
      sessionLeaseToken: input.leaseToken,
    },
    { $unset: { sessionLeaseToken: 1, sessionLeaseExpiresAt: 1 } },
  )
}

export const __runtimeBinding = { SESSION_LEASE_MS }
