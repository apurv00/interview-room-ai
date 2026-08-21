import { redis } from '@shared/redis'
import {
  HireEngineRevocationSchema,
  type HireEngineRevocation,
} from '@shared/contracts/hireEngineBridge'
import { User } from '@shared/db/models/User'
import { HireRuntimeBinding } from '../models/HireRuntimeBinding'
import { HireRuntimeRevocation } from '../models/HireRuntimeRevocation'
import { purgeRuntimePrincipalData } from './runtimePersonalDataPurge'
import { connectHireRuntimeDB } from './runtimeBoundary'

const MAJORITY_WRITE_CONCERN = { w: 'majority', j: true } as const

export function hireRuntimeRevocationKey(roundId: string): string {
  return `hire-runtime:revoked:${roundId.toLowerCase()}`
}

async function finalizeRuntimePrivacyTombstones(input: {
  bindingId: string
  coordinates: { workspaceId: string; applicationId: string; roundId: string }
  purgedAt: Date
}): Promise<void> {
  const scrubbed = await HireRuntimeBinding.updateOne(
    {
      _id: input.bindingId,
      ...input.coordinates,
      status: 'revoked',
      purgePersonalData: true,
    },
    {
      $set: { personalDataPurgedAt: input.purgedAt },
      $unset: {
        runtimeSessionId: 1,
        sessionLeaseToken: 1,
        sessionLeaseExpiresAt: 1,
        principalLeaseToken: 1,
        principalLeaseExpiresAt: 1,
        pendingMediaManifest: 1,
        pendingResultPayloadJson: 1,
        publishedRevision: 1,
        publishedDigest: 1,
        publishedAt: 1,
        publishRetryAt: 1,
        publishFailureCode: 1,
        runtimeWriteDrainUntil: 1,
        issuedObjectCapabilities: 1,
        issuedMultipartCapabilities: 1,
        feedbackRecoveryLeaseToken: 1,
        feedbackRecoveryLeaseExpiresAt: 1,
        feedbackRecoveryRetryAt: 1,
        feedbackRecoveryFailureCode: 1,
        authTicketGeneration: 1,
        authTicketHandoffNonce: 1,
        authTicketState: 1,
        authTicketDigest: 1,
        authTicketExpiresAt: 1,
        authTicketIssuedAt: 1,
        authTicketConsumedAt: 1,
        revokeReason: 1,
      },
    },
    { writeConcern: MAJORITY_WRITE_CONCERN },
  )
  if (scrubbed.matchedCount !== 1) {
    throw new Error('Runtime binding changed during personal-data purge')
  }
  const tombstone = await HireRuntimeRevocation.updateOne(
    { ...input.coordinates, purgePersonalData: true },
    { $set: { purgeStatus: 'completed', purgedAt: input.purgedAt } },
    { writeConcern: MAJORITY_WRITE_CONCERN },
  )
  if (tombstone.matchedCount !== 1) {
    throw new Error('Runtime privacy tombstone changed during purge')
  }
}

export async function revokeRuntimeBinding(
  rawInput: unknown,
): Promise<{ outcome: 'revoked' | 'already-revoked' | 'not-provisioned' }> {
  const input: HireEngineRevocation = HireEngineRevocationSchema.parse(rawInput)
  await connectHireRuntimeDB()
  const coordinates = {
    workspaceId: input.workspaceId,
    applicationId: input.applicationId,
    roundId: input.roundId,
  }
  const existingTombstone = await HireRuntimeRevocation.findOne(coordinates).lean()
  const preservePrivacyReason =
    existingTombstone?.purgePersonalData === true && !input.purgePersonalData
  await HireRuntimeRevocation.updateOne(
    coordinates,
    {
      $setOnInsert: { ...coordinates, purgePersonalData: false },
      $set: {
        revokedAt: preservePrivacyReason
          ? existingTombstone.revokedAt
          : new Date(input.revokedAt),
        reason: preservePrivacyReason ? existingTombstone.reason : input.reason,
      },
    },
    { upsert: true, writeConcern: MAJORITY_WRITE_CONCERN },
  )
  if (input.purgePersonalData) {
    // Purge is monotonic: an older ordinary-revocation retry can never turn a
    // privacy tombstone back off after the signed upgrade has been received.
    await HireRuntimeRevocation.updateOne(
      coordinates,
      { $set: { purgePersonalData: true } },
      { writeConcern: MAJORITY_WRITE_CONCERN },
    )
    await HireRuntimeRevocation.updateOne(
      { ...coordinates, purgeStatus: { $ne: 'completed' } },
      { $set: { purgeStatus: 'pending' } },
      { writeConcern: MAJORITY_WRITE_CONCERN },
    )
  }
  const purgePersonalData =
    input.purgePersonalData || existingTombstone?.purgePersonalData === true
  const binding = await HireRuntimeBinding.findOneAndUpdate(
    coordinates,
    {
      $set: {
        status: 'revoked',
        revokedAt: new Date(input.revokedAt),
        revokeReason: input.reason,
        ...(purgePersonalData ? { purgePersonalData: true } : {}),
      },
      ...(purgePersonalData
        ? {}
        : { $unset: { sessionLeaseToken: 1, sessionLeaseExpiresAt: 1 } }),
    },
    { new: true, writeConcern: MAJORITY_WRITE_CONCERN },
  )

  // Redis is the request-path revocation authority. Fail the acknowledgement
  // if it cannot be written; the control-plane outbox will retry.
  await redis.set(hireRuntimeRevocationKey(input.roundId), input.revokedAt, 'EX', 30 * 24 * 60 * 60)
  if (binding) {
    if (purgePersonalData) {
      const now = new Date()
      // A session create that already owns the lease must first finish or
      // release it. The signed control outbox retries; after lease expiry the
      // purge can safely collect even a crashed creator's orphan session.
      if (
        (binding.sessionLeaseToken &&
          (!binding.sessionLeaseExpiresAt || binding.sessionLeaseExpiresAt > now)) ||
        (binding.principalLeaseToken &&
          (!binding.principalLeaseExpiresAt || binding.principalLeaseExpiresAt > now)) ||
        (binding.feedbackRecoveryLeaseToken &&
          (!binding.feedbackRecoveryLeaseExpiresAt ||
            binding.feedbackRecoveryLeaseExpiresAt > now))
      ) {
        throw new Error('Runtime personal-data purge is waiting for an active writer lease')
      }
      const purgedAt = await purgeRuntimePrincipalData({
        binding,
        roundId: input.roundId,
      })
      await finalizeRuntimePrivacyTombstones({
        bindingId: binding._id.toString(),
        coordinates,
        purgedAt,
      })
      return { outcome: existingTombstone ? 'already-revoked' : 'revoked' }
    }
    await User.updateOne(
      {
        _id: binding.principalId,
        organizationId: input.workspaceId,
      },
      { $set: { monthlyInterviewLimit: 0 } },
      { writeConcern: MAJORITY_WRITE_CONCERN },
    )
    return { outcome: existingTombstone ? 'already-revoked' : 'revoked' }
  }
  if (purgePersonalData) {
    const purgedAt = new Date()
    const tombstone = await HireRuntimeRevocation.updateOne(
      { ...coordinates, purgePersonalData: true },
      { $set: { purgeStatus: 'completed', purgedAt } },
      { writeConcern: MAJORITY_WRITE_CONCERN },
    )
    if (tombstone.matchedCount !== 1) {
      throw new Error('Runtime privacy tombstone changed during purge')
    }
  }
  return { outcome: existingTombstone ? 'already-revoked' : 'not-provisioned' }
}

export const __runtimeRevocation = {
  finalizeRuntimePrivacyTombstones,
}
