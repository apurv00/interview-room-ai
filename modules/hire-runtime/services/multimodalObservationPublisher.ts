import { randomBytes } from 'node:crypto'
import {
  HIRE_MULTIMODAL_OBSERVATION_BRIDGE_SCHEMA_VERSION,
  HIRE_MULTIMODAL_OBSERVATION_LEGACY_BRIDGE_SCHEMA_VERSION,
  HIRE_MULTIMODAL_OBSERVATION_LEGACY_POLICY_VERSION,
  HireMultimodalObservationIngestionSchema,
  type HireMultimodalObservationIngestion,
} from '@shared/contracts/hireMultimodalObservationBridge'
import { HIRE_RUNTIME_WRITE_DRAIN_MS } from '@shared/contracts/hireRuntimeWriteFence'
import {
  HireRuntimeBinding,
  type IHireRuntimeBinding,
} from '../models/HireRuntimeBinding'
import {
  HireRuntimeMultimodalObservationOutbox,
  type IHireRuntimeMultimodalObservationOutbox,
} from '../models/HireRuntimeMultimodalObservationOutbox'
import { publishMultimodalObservationToControl } from './controlBridgeClient'
import { isHireRuntimeMultimodalObservationRetentionPurged } from './multimodalObservationRetentionService'
import { connectHireRuntimeDB } from './runtimeBoundary'
import { enumerateRuntimeWorkspaceIds } from './runtimeTenantScope'

const OBSERVATION_REVISION = 1
const PUBLISH_LEASE_MS = 90_000
const RETRY_BASE_MS = 5_000
const RETRY_MAX_MS = 5 * 60 * 1_000

type PublishOutcome = 'published' | 'stale' | 'deferred' | 'skipped'

function retryAt(attempt: number, now: Date): Date {
  const delay = Math.min(
    RETRY_MAX_MS,
    RETRY_BASE_MS * 2 ** Math.min(Math.max(attempt - 1, 0), 10),
  )
  return new Date(now.getTime() + delay)
}

async function claimObservationOutbox(
  candidate: IHireRuntimeMultimodalObservationOutbox,
  now: Date,
): Promise<IHireRuntimeMultimodalObservationOutbox | null> {
  const leaseToken = randomBytes(32).toString('hex')
  return HireRuntimeMultimodalObservationOutbox.findOneAndUpdate(
    {
      _id: candidate._id,
      status: 'pending',
      $and: [
        {
          $or: [
            { publishLeaseToken: { $exists: false } },
            { publishLeaseExpiresAt: { $lte: now } },
          ],
        },
        {
          $or: [
            { publishRetryAt: { $exists: false } },
            { publishRetryAt: { $lte: now } },
          ],
        },
      ],
    },
    {
      $set: {
        publishLeaseToken: leaseToken,
        publishLeaseExpiresAt: new Date(now.getTime() + PUBLISH_LEASE_MS),
        publishAttemptCount: Math.min((candidate.publishAttemptCount ?? 0) + 1, 20),
      },
    },
    { new: true },
  )
}

async function reserveObservationPublishDrain(
  outbox: IHireRuntimeMultimodalObservationOutbox,
  now: Date,
): Promise<IHireRuntimeBinding | null> {
  return HireRuntimeBinding.findOneAndUpdate(
    {
      workspaceId: outbox.workspaceId,
      applicationId: outbox.applicationId,
      roundId: outbox.roundId,
      principalId: outbox.principalId,
      runtimeSessionId: outbox.runtimeSessionId,
      // Late camera/screen replay publication can advance the normal result
      // beyond revision 1 before this independent observation is delivered.
      publishedRevision: { $gte: OBSERVATION_REVISION },
      status: { $in: ['active', 'completed', 'revoked'] },
      purgePersonalData: { $ne: true },
    },
    {
      $max: {
        runtimeWriteDrainUntil: new Date(
          now.getTime() + HIRE_RUNTIME_WRITE_DRAIN_MS,
        ),
      },
    },
    { new: true },
  )
}

async function deferObservation(
  outbox: IHireRuntimeMultimodalObservationOutbox,
  now: Date,
): Promise<void> {
  await HireRuntimeMultimodalObservationOutbox.updateOne(
    {
      _id: outbox._id,
      status: 'pending',
      publishLeaseToken: outbox.publishLeaseToken,
    },
    {
      $set: { publishRetryAt: new Date(now.getTime() + 30_000) },
      $unset: { publishLeaseToken: 1, publishLeaseExpiresAt: 1 },
    },
  )
}

async function markObservationPublished(
  outbox: IHireRuntimeMultimodalObservationOutbox,
  outcome: 'published' | 'stale',
  now: Date,
): Promise<void> {
  const settled = await HireRuntimeMultimodalObservationOutbox.updateOne(
    {
      _id: outbox._id,
      status: 'pending',
      publishLeaseToken: outbox.publishLeaseToken,
    },
    {
      $set: { status: outcome, publishedAt: now },
      // The control plane holds the only durable report after acknowledgement.
      // Runtime retains delivery metadata solely until its privacy purge.
      $unset: {
        report: 1,
        publishLeaseToken: 1,
        publishLeaseExpiresAt: 1,
        publishRetryAt: 1,
        failureCode: 1,
      },
    },
  )
  if (settled.matchedCount !== 1) {
    throw new Error('Runtime observation outbox changed before acknowledgement')
  }
}

async function recordObservationPublishFailure(
  outbox: IHireRuntimeMultimodalObservationOutbox,
  now: Date,
): Promise<void> {
  const failed = await HireRuntimeMultimodalObservationOutbox.updateOne(
    {
      _id: outbox._id,
      status: 'pending',
      publishLeaseToken: outbox.publishLeaseToken,
    },
    {
      $set: {
        publishRetryAt: retryAt(outbox.publishAttemptCount, now),
        failureCode: 'HIRE_MULTIMODAL_OBSERVATION_PUBLISH_FAILED',
      },
      $unset: { publishLeaseToken: 1, publishLeaseExpiresAt: 1 },
    },
  )
  if (failed.matchedCount !== 1) {
    throw new Error('Runtime observation outbox changed while recording failure')
  }
}

function bridgePayload(
  outbox: IHireRuntimeMultimodalObservationOutbox,
): HireMultimodalObservationIngestion | null {
  if (!outbox.report) return null
  return HireMultimodalObservationIngestionSchema.parse({
    schemaVersion:
      outbox.policyVersion === HIRE_MULTIMODAL_OBSERVATION_LEGACY_POLICY_VERSION
        ? HIRE_MULTIMODAL_OBSERVATION_LEGACY_BRIDGE_SCHEMA_VERSION
        : HIRE_MULTIMODAL_OBSERVATION_BRIDGE_SCHEMA_VERSION,
    eventId: outbox.eventId,
    workspaceId: outbox.workspaceId.toString(),
    applicationId: outbox.applicationId.toString(),
    roundId: outbox.roundId.toString(),
    runtimeSessionId: outbox.runtimeSessionId.toString(),
    attempt: outbox.attempt,
    revision: outbox.revision,
    consentVersion: outbox.consentVersion,
    policyVersion: outbox.policyVersion,
    observationDigest: outbox.observationDigest,
    observedAt: outbox.observedAt.toISOString(),
    report: outbox.report,
  })
}

async function isRetentionTombstoned(
  outbox: IHireRuntimeMultimodalObservationOutbox,
): Promise<boolean> {
  return isHireRuntimeMultimodalObservationRetentionPurged({
    workspaceId: outbox.workspaceId,
    applicationId: outbox.applicationId,
    roundId: outbox.roundId,
  })
}

async function publishOneObservation(
  candidate: IHireRuntimeMultimodalObservationOutbox,
  now = new Date(),
): Promise<PublishOutcome> {
  const outbox = await claimObservationOutbox(candidate, now)
  if (!outbox) return 'skipped'

  try {
    if (await isRetentionTombstoned(outbox)) {
      await markObservationPublished(outbox, 'stale', now)
      return 'stale'
    }
    // A normal result must be durable and linked before a recruiter can ever
    // see the independent supplemental panel. If it has not arrived yet, keep
    // the report local and retry without treating that as a provider failure.
    const binding = await reserveObservationPublishDrain(outbox, now)
    if (!binding) {
      const latest = await HireRuntimeBinding.exists({
        workspaceId: outbox.workspaceId,
        applicationId: outbox.applicationId,
        roundId: outbox.roundId,
        runtimeSessionId: outbox.runtimeSessionId,
        purgePersonalData: { $ne: true },
      })
      if (!latest) {
        await markObservationPublished(outbox, 'stale', now)
        return 'stale'
      }
      await deferObservation(outbox, now)
      return 'deferred'
    }
    const payload = bridgePayload(outbox)
    if (!payload) {
      await markObservationPublished(outbox, 'stale', now)
      return 'stale'
    }

    // Reclaim the drain immediately before crossing planes. If privacy won in
    // between, the conditional update fails and nothing is sent.
    const stillPublishable = await reserveObservationPublishDrain(outbox, now)
    if (!stillPublishable) {
      await markObservationPublished(outbox, 'stale', now)
      return 'stale'
    }
    // The deadline purge uses a separate durable model, so this final read is
    // required even after the binding reservation. It prevents cross-plane
    // delivery when the signed runtime purge won while this row was claimed.
    if (await isRetentionTombstoned(outbox)) {
      await markObservationPublished(outbox, 'stale', now)
      return 'stale'
    }
    const acknowledgement = await publishMultimodalObservationToControl(payload)
    await markObservationPublished(
      outbox,
      acknowledgement === 'stale' ? 'stale' : 'published',
      now,
    )
    return acknowledgement === 'stale' ? 'stale' : 'published'
  } catch {
    await recordObservationPublishFailure(outbox, now).catch(() => undefined)
    return 'skipped'
  }
}

export async function publishPendingHireMultimodalObservations(
  limit = 25,
): Promise<{
  scanned: number
  published: number
  stale: number
  deferred: number
  failed: number
}> {
  await connectHireRuntimeDB()
  const now = new Date()
  const batchLimit = Math.min(Math.max(limit, 1), 100)
  const workspaceIds = await enumerateRuntimeWorkspaceIds()
  const perWorkspaceLimit = Math.max(
    1,
    Math.ceil(batchLimit / Math.max(workspaceIds.length, 1)),
  )
  const candidates: IHireRuntimeMultimodalObservationOutbox[] = []
  for (const workspaceId of workspaceIds) {
    const scoped = await HireRuntimeMultimodalObservationOutbox.find({
      workspaceId,
      status: 'pending',
      $or: [
        { publishRetryAt: { $exists: false } },
        { publishRetryAt: { $lte: now } },
      ],
    })
      .sort({ publishRetryAt: 1, updatedAt: 1 })
      .limit(perWorkspaceLimit)
    candidates.push(...scoped)
  }
  const pending = candidates
    .sort((left, right) => left.updatedAt.getTime() - right.updatedAt.getTime())
    .slice(0, batchLimit)

  let published = 0
  let stale = 0
  let deferred = 0
  let failed = 0
  for (const candidate of pending) {
    const outcome = await publishOneObservation(candidate, now)
    if (outcome === 'published') published += 1
    else if (outcome === 'stale') stale += 1
    else if (outcome === 'deferred') deferred += 1
    else if (outcome === 'skipped') failed += 1
  }
  return { scanned: pending.length, published, stale, deferred, failed }
}

export const __hireMultimodalObservationPublisher = {
  bridgePayload,
  claimObservationOutbox,
  reserveObservationPublishDrain,
  isRetentionTombstoned,
  publishOneObservation,
}
