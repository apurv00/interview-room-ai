import { randomBytes } from 'node:crypto'
import { isCanonicalR2Key } from '@shared/storage/r2'
import {
  HIRE_RUNTIME_STORAGE_CAPABILITY_MS,
  HIRE_RUNTIME_WRITE_DRAIN_MS,
  runtimeWriteDrainMs,
} from '@shared/contracts/hireRuntimeWriteFence'
import { HIRE_AI_CONSENT_VERSION } from '@hire-multimodal-boundary'
import { HireRuntimeBinding, type IHireRuntimeBinding } from '../models/HireRuntimeBinding'
import { connectHireRuntimeDB } from './runtimeBoundary'

export class RuntimeWriteFenceError extends Error {
  constructor(
    message: string,
    readonly status: 404 | 410 | 503,
    readonly code:
      | 'ACCOUNT_UNAVAILABLE'
      | 'MEDIA_TERMINAL'
      | 'RUNTIME_WRITE_UNAVAILABLE' = 'RUNTIME_WRITE_UNAVAILABLE',
  ) {
    super(message)
    this.name = 'RuntimeWriteFenceError'
  }
}

export { runtimeWriteDrainMs }

const MAX_RESULT_REVISION = 10
const REPLAY_WRITE_RESERVATION_MS = HIRE_RUNTIME_WRITE_DRAIN_MS

export type RuntimeReplayWriteKind = 'camera' | 'screen'

export interface RuntimeReplayWriteReservation {
  reservationId: string
  kind: RuntimeReplayWriteKind
}

function isReplayContinuationTarget(pathname: string, method: string): boolean {
  return method.toUpperCase() === 'POST' && (
    pathname === '/api/storage/presign' ||
    pathname === '/api/storage/multipart' ||
    pathname === '/api/recordings/finalize'
  )
}

function completedReplayScope(): Record<string, unknown> {
  return {
    status: 'completed',
    publishedRevision: { $gte: 1, $lt: MAX_RESULT_REVISION },
    $or: [
      { cameraMediaStatus: 'pending' },
      {
        screenMediaStatus: 'pending',
        consentVersion: HIRE_AI_CONSENT_VERSION,
      },
    ],
  }
}

export async function claimRuntimeWriteCapability(input: {
  workspaceId: string
  principalId: string
  pathname: string
  method: string
  now?: Date
}): Promise<IHireRuntimeBinding> {
  const horizonMs = runtimeWriteDrainMs(input.pathname, input.method)
  if (horizonMs === null) {
    throw new RuntimeWriteFenceError('Runtime write target is not allow-listed', 404)
  }
  await connectHireRuntimeDB()
  const now = input.now ?? new Date()
  const statusScope = isReplayContinuationTarget(input.pathname, input.method)
    ? { $or: [{ status: 'active' }, completedReplayScope()] }
    : { status: 'active' }
  const binding = await HireRuntimeBinding.findOneAndUpdate(
    {
      workspaceId: input.workspaceId,
      principalId: input.principalId,
      ...statusScope,
      runtimeSessionId: { $exists: true },
      revokedAt: { $exists: false },
      purgePersonalData: { $ne: true },
    },
    {
      $max: { runtimeWriteDrainUntil: new Date(now.getTime() + horizonMs) },
    },
    { new: true },
  )
  if (!binding) {
    const denied = await HireRuntimeBinding.findOne({
      workspaceId: input.workspaceId,
      principalId: input.principalId,
    })
      .select('status revokedAt purgePersonalData')
      .lean<{
        status?: string
        revokedAt?: Date
        purgePersonalData?: boolean
      }>()
    const privacyTerminal =
      !denied ||
      denied.status === 'revoked' ||
      Boolean(denied.revokedAt) ||
      denied.purgePersonalData === true
    throw new RuntimeWriteFenceError(
      'Runtime binding is revoked or unavailable',
      410,
      privacyTerminal ? 'ACCOUNT_UNAVAILABLE' : 'MEDIA_TERMINAL',
    )
  }
  return binding
}

function replayTerminalClaimScope(
  kind: RuntimeReplayWriteKind,
  now: Date,
): Record<string, unknown> {
  const tokenField = kind === 'camera'
    ? 'cameraMediaTerminalClaimToken'
    : 'screenMediaTerminalClaimToken'
  const expiresAtField = kind === 'camera'
    ? 'cameraMediaTerminalClaimExpiresAt'
    : 'screenMediaTerminalClaimExpiresAt'
  return {
    $or: [
      { [tokenField]: { $exists: false } },
      { [expiresAtField]: { $lte: now } },
    ],
  }
}

function replayReservationStatusScope(
  kind: RuntimeReplayWriteKind,
): Record<string, unknown> {
  const mediaStatusField = kind === 'camera'
    ? 'cameraMediaStatus'
    : 'screenMediaStatus'
  return {
    $or: [
      {
        status: 'active',
        [mediaStatusField]: { $nin: ['published', 'unavailable'] },
      },
      {
        status: 'completed',
        publishedRevision: { $gte: 1, $lt: MAX_RESULT_REVISION },
        [mediaStatusField]: 'pending',
      },
    ],
  }
}

/**
 * Reserve each consent-required replay kind before an upstream endpoint can
 * mint a capability, mutate R2, or associate an InterviewSession artifact.
 * A crashed request leaves only a bounded drain entry; a successful request
 * releases it after the durable capability/finalization checkpoint.
 */
export async function reserveRuntimeReplayWrites(input: {
  workspaceId: string
  bindingId: string
  principalId: string
  runtimeSessionId: string
  kinds: RuntimeReplayWriteKind[]
  now?: Date
}): Promise<RuntimeReplayWriteReservation[]> {
  const kinds = Array.from(new Set(input.kinds))
  if (kinds.length === 0) return []
  const now = input.now ?? new Date()
  const expiresAt = new Date(now.getTime() + REPLAY_WRITE_RESERVATION_MS)
  const reservations: RuntimeReplayWriteReservation[] = []

  // Retire crashed reservations opportunistically so the array stays bounded.
  await HireRuntimeBinding.updateOne(
    {
      _id: input.bindingId,
      workspaceId: input.workspaceId,
      principalId: input.principalId,
      runtimeSessionId: input.runtimeSessionId,
    },
    {
      $pull: { mediaWriteReservations: { expiresAt: { $lte: now } } },
    },
  )

  try {
    for (const kind of kinds) {
      const reservationId = randomBytes(32).toString('hex')
      const reserved = await HireRuntimeBinding.findOneAndUpdate(
        {
          _id: input.bindingId,
          workspaceId: input.workspaceId,
          principalId: input.principalId,
          runtimeSessionId: input.runtimeSessionId,
          mediaCompletionContractVersion: 1,
          revokedAt: { $exists: false },
          purgePersonalData: { $ne: true },
          $and: [
            replayReservationStatusScope(kind),
            replayTerminalClaimScope(kind, now),
          ],
        },
        {
          $push: {
            mediaWriteReservations: { reservationId, kind, expiresAt },
          },
        },
        { new: true },
      )
      if (!reserved) {
        throw new RuntimeWriteFenceError(
          'Runtime replay delivery is terminalizing or unavailable',
          410,
          'MEDIA_TERMINAL',
        )
      }
      reservations.push({ reservationId, kind })
    }
    return reservations
  } catch (error) {
    await releaseRuntimeReplayWriteReservations({
      workspaceId: input.workspaceId,
      bindingId: input.bindingId,
      reservations,
    })
    throw error
  }
}

export async function releaseRuntimeReplayWriteReservations(input: {
  workspaceId: string
  bindingId: string
  reservations: RuntimeReplayWriteReservation[]
}): Promise<void> {
  if (input.reservations.length === 0) return
  await HireRuntimeBinding.updateOne(
    { _id: input.bindingId, workspaceId: input.workspaceId },
    {
      $pull: {
        mediaWriteReservations: {
          reservationId: {
            $in: input.reservations.map((reservation) => reservation.reservationId),
          },
        },
      },
    },
  )
}

function assertCapabilityKey(input: {
  key: string
  principalId: string
  runtimeSessionId: string
}): void {
  if (!isCanonicalR2Key(input.key)) {
    throw new RuntimeWriteFenceError('Runtime storage capability key is not canonical', 503)
  }
  const match = /^recordings\/([a-f0-9]{24})\/([a-f0-9]{24})(?:-(?:screen|audio))?-\d{10,16}\.webm$/i
    .exec(input.key)
  if (
    !match ||
    match[1].toLowerCase() !== input.principalId.toLowerCase() ||
    match[2].toLowerCase() !== input.runtimeSessionId.toLowerCase()
  ) {
    throw new RuntimeWriteFenceError('Runtime storage capability crossed its binding', 503)
  }
}

function capabilityKind(key: string): 'recording' | 'screen-recording' | 'audio-recording' {
  if (/-screen-\d{10,16}\.webm$/i.test(key)) return 'screen-recording'
  if (/-audio-\d{10,16}\.webm$/i.test(key)) return 'audio-recording'
  return 'recording'
}

function storageCapabilityStatusScope(key: string): Record<string, unknown> {
  const kind = capabilityKind(key)
  const activeScope = kind === 'recording'
    ? { status: { $in: ['provisioned', 'active'] }, cameraMediaStatus: { $ne: 'unavailable' } }
    : kind === 'screen-recording'
      ? { status: { $in: ['provisioned', 'active'] }, screenMediaStatus: { $ne: 'unavailable' } }
      : { status: { $in: ['provisioned', 'active'] } }
  const replayScope = kind === 'recording'
    ? {
        status: 'completed',
        publishedRevision: { $gte: 1, $lt: MAX_RESULT_REVISION },
        cameraMediaStatus: 'pending',
      }
    : kind === 'screen-recording'
      ? {
          status: 'completed',
          publishedRevision: { $gte: 1, $lt: MAX_RESULT_REVISION },
          screenMediaStatus: 'pending',
          consentVersion: HIRE_AI_CONSENT_VERSION,
        }
      : null
  return replayScope
    ? { $or: [activeScope, replayScope] }
    : activeScope
}

export async function recordRuntimeStorageCapability(input: {
  workspaceId: string
  bindingId: string
  principalId: string
  runtimeSessionId: string
  key: string
  uploadId?: string
  now?: Date
}): Promise<void> {
  assertCapabilityKey(input)
  const expiresAt = new Date(
    (input.now ?? new Date()).getTime() + HIRE_RUNTIME_STORAGE_CAPABILITY_MS,
  )
  const scope = {
    _id: input.bindingId,
    workspaceId: input.workspaceId,
    principalId: input.principalId,
    runtimeSessionId: input.runtimeSessionId,
    ...storageCapabilityStatusScope(input.key),
    revokedAt: { $exists: false },
    purgePersonalData: { $ne: true },
  }
  await HireRuntimeBinding.updateOne(scope, {
    $pull: {
      issuedObjectCapabilities: { key: input.key },
      ...(input.uploadId
        ? { issuedMultipartCapabilities: { uploadId: input.uploadId } }
        : {}),
    },
  })
  const recorded = await HireRuntimeBinding.updateOne(scope, {
    $push: {
      issuedObjectCapabilities: {
        key: input.key,
        runtimeSessionId: input.runtimeSessionId,
        expiresAt,
      },
      ...(input.uploadId
        ? {
            issuedMultipartCapabilities: {
              key: input.key,
              runtimeSessionId: input.runtimeSessionId,
              uploadId: input.uploadId,
              expiresAt,
            },
          }
        : {}),
    },
    $max: { runtimeWriteDrainUntil: expiresAt },
  })
  if (recorded.matchedCount !== 1) {
    throw new RuntimeWriteFenceError('Runtime binding revoked during capability issue', 410)
  }
}

export async function settleRuntimeMultipartCapability(input: {
  workspaceId: string
  bindingId: string
  uploadId: string
  key: string
  removeObjectCapability: boolean
}): Promise<void> {
  const settled = await HireRuntimeBinding.updateOne(
    { _id: input.bindingId, workspaceId: input.workspaceId },
    {
      $pull: {
        issuedMultipartCapabilities: { uploadId: input.uploadId },
        ...(input.removeObjectCapability
          ? { issuedObjectCapabilities: { key: input.key } }
          : {}),
      },
    },
  )
  if (settled.matchedCount !== 1) {
    throw new RuntimeWriteFenceError('Runtime capability settlement failed', 503)
  }
}

export function assertRuntimeWritesDrained(
  binding: Pick<IHireRuntimeBinding, 'runtimeWriteDrainUntil'>,
  now = new Date(),
): void {
  if (binding.runtimeWriteDrainUntil && binding.runtimeWriteDrainUntil > now) {
    throw new RuntimeWriteFenceError(
      'Runtime personal-data purge is waiting for issued write capabilities to drain',
      503,
    )
  }
}

export const __runtimeWriteFence = {
  RUNTIME_WRITE_DRAIN_MS: HIRE_RUNTIME_WRITE_DRAIN_MS,
  RUNTIME_STORAGE_CAPABILITY_MS: HIRE_RUNTIME_STORAGE_CAPABILITY_MS,
  REPLAY_WRITE_RESERVATION_MS,
  assertCapabilityKey,
}
