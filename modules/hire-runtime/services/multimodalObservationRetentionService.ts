import {
  HireMultimodalObservationRuntimePurgeSchema,
  type HireMultimodalObservationRuntimePurge,
} from '@shared/contracts/hireMultimodalObservationBridge'
import { HireRuntimeBinding } from '../models/HireRuntimeBinding'
import { HireRuntimeMultimodalObservationOutbox } from '../models/HireRuntimeMultimodalObservationOutbox'
import { HireRuntimeMultimodalAnalysisOutbox } from '../models/HireRuntimeMultimodalAnalysisOutbox'
import { HireRuntimeMultimodalObservationRetentionTombstone } from '../models/HireRuntimeMultimodalObservationRetentionTombstone'
import { deleteRuntimePersonalObjects } from './runtimeMediaManifest'
import { connectHireRuntimeDB } from './runtimeBoundary'

const MAJORITY_WRITE_CONCERN = { w: 'majority', j: true } as const

export type HireRuntimeMultimodalObservationRetentionOutcome =
  | 'purged'
  | 'already_purged'
  | 'not_provisioned'

export function runtimeMultimodalObservationRetentionCoordinates(input: Pick<
  HireMultimodalObservationRuntimePurge,
  'workspaceId' | 'applicationId' | 'roundId'
>) {
  return {
    workspaceId: input.workspaceId,
    applicationId: input.applicationId,
    roundId: input.roundId,
  }
}

export async function isHireRuntimeMultimodalObservationRetentionPurged(input: {
  workspaceId: string | object
  applicationId: string | object
  roundId: string | object
}): Promise<boolean> {
  return Boolean(
    await HireRuntimeMultimodalObservationRetentionTombstone.exists({
      workspaceId: input.workspaceId,
      applicationId: input.applicationId,
      roundId: input.roundId,
    }),
  )
}

/**
 * Runtime half of the six-month closed-job deletion promise. The tombstone is
 * intentionally written before either legacy-observation or V4 full-analysis
 * outbox deletion: every writer checks it, so a delayed browser capture
 * cannot recreate derived or raw analysis data after the deadline.
 */
export async function purgeHireRuntimeMultimodalObservationRetention(
  rawInput: unknown,
): Promise<{ outcome: HireRuntimeMultimodalObservationRetentionOutcome }> {
  const input = HireMultimodalObservationRuntimePurgeSchema.parse(rawInput)
  await connectHireRuntimeDB()
  const now = new Date()
  const purgeEligibleAt = new Date(input.purgeEligibleAt)
  if (purgeEligibleAt > now) {
    throw new Error('Runtime observation retention purge arrived before its deadline')
  }
  const coordinates = runtimeMultimodalObservationRetentionCoordinates(input)
  const alreadyTombstoned = await isHireRuntimeMultimodalObservationRetentionPurged(
    coordinates,
  )
  if (!alreadyTombstoned) {
    try {
      await HireRuntimeMultimodalObservationRetentionTombstone.updateOne(
        coordinates,
        {
          $setOnInsert: {
            ...coordinates,
            purgeId: input.purgeId,
            purgeEligibleAt,
            purgedAt: now,
          },
        },
        { upsert: true, writeConcern: MAJORITY_WRITE_CONCERN },
      )
    } catch (error) {
      // Two control retries can race on the unique coordinate. A subsequent
      // exact read proves the other caller installed the same suppression
      // fence; anything else remains an outage and is retried by control.
      if (!(await isHireRuntimeMultimodalObservationRetentionPurged(coordinates))) {
        throw error
      }
    }
  }

  // Serialize with capture's capability-to-outbox transaction on this binding
  // row. A capture that wins first is visible in the outbox scan below; a
  // retention fence that wins first leaves its exact capability visible here
  // and prevents any later handoff or reservation.
  const fencedBindings = await HireRuntimeBinding.updateMany(
    coordinates,
    { $set: { multimodalObservationRetentionPurgedAt: now } },
    { writeConcern: MAJORITY_WRITE_CONCERN },
  )
  if (!fencedBindings.acknowledged) {
    throw new Error('Runtime multimodal retention binding fence was not acknowledged')
  }
  const bindings = await HireRuntimeBinding.find(coordinates)
    .select('_id principalId issuedObjectCapabilities')
    .lean()
  for (const binding of bindings) {
    const landmarkCapabilities = (binding.issuedObjectCapabilities ?? [])
      .filter((capability) => capability.key.startsWith('landmarks/'))
    if (landmarkCapabilities.length === 0) continue
    await deleteRuntimePersonalObjects({
      principalId: binding.principalId.toString(),
      objects: landmarkCapabilities.map((capability) => ({
        key: capability.key,
        ...(capability.objectKeyNonce
          ? { objectKeyNonce: capability.objectKeyNonce }
          : {}),
        runtimeSessionId: capability.runtimeSessionId.toString(),
      })),
    })
    const released = await HireRuntimeBinding.updateOne(
      { _id: binding._id, ...coordinates },
      {
        $pull: {
          issuedObjectCapabilities: {
            key: { $in: landmarkCapabilities.map(({ key }) => key) },
          },
        },
      },
      { writeConcern: MAJORITY_WRITE_CONCERN },
    )
    if (!released.acknowledged) {
      throw new Error('Runtime multimodal retention capability release was not acknowledged')
    }
  }

  const analysisOutboxes = await HireRuntimeMultimodalAnalysisOutbox.find(coordinates)
    .select('principalId runtimeSessionId landmarkArtifact')
    .lean()
  for (const outbox of analysisOutboxes) {
    if (!outbox.landmarkArtifact) continue
    await deleteRuntimePersonalObjects({
      principalId: outbox.principalId.toString(),
      objects: [{
        key: outbox.landmarkArtifact.sourceKey,
        ...(outbox.landmarkArtifact.objectKeyNonce
          ? { objectKeyNonce: outbox.landmarkArtifact.objectKeyNonce }
          : {}),
        runtimeSessionId: outbox.runtimeSessionId.toString(),
      }],
    })
  }
  const [deleted, deletedAnalyses] = await Promise.all([
    HireRuntimeMultimodalObservationOutbox.deleteMany(
      coordinates,
      { writeConcern: MAJORITY_WRITE_CONCERN },
    ),
    HireRuntimeMultimodalAnalysisOutbox.deleteMany(
      coordinates,
      { writeConcern: MAJORITY_WRITE_CONCERN },
    ),
  ])
  if (!deleted.acknowledged || !deletedAnalyses.acknowledged) {
    throw new Error('Runtime multimodal observation retention purge was not acknowledged')
  }

  if (alreadyTombstoned) return { outcome: 'already_purged' }
  const binding = await HireRuntimeBinding.exists(coordinates)
  return { outcome: binding ? 'purged' : 'not_provisioned' }
}

export const __hireRuntimeMultimodalObservationRetention = {
  runtimeMultimodalObservationRetentionCoordinates,
}
