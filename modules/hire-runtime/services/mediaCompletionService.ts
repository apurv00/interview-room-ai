import { randomBytes } from 'node:crypto'
import { supportsHireDisplayCapture } from '@hire-multimodal-boundary'
import { InterviewSession } from '@shared/db/models/InterviewSession'
import {
  HireRuntimeBinding,
  type HireRuntimeMediaUnavailableReason,
  type HireRuntimeReplayMediaKind,
  type IHireRuntimeBinding,
} from '../models/HireRuntimeBinding'

const TERMINAL_CLAIM_MS = 60_000

interface CompletionArtifactSnapshot {
  status?: string
  recordingR2Key?: string | null
  recordingSizeBytes?: number | null
  recordingArtifactVersion?: number | null
  screenRecordingR2Key?: string | null
  screenRecordingSizeBytes?: number | null
  screenRecordingArtifactVersion?: number | null
}

export type RuntimeMediaTerminalizationOutcome =
  | 'recorded'
  | 'already_unavailable'
  | 'already_published'
  | 'artifact_present'
  | 'in_flight'
  | 'state_changed'
  | 'session_pending'
  | 'not_required'
  | 'legacy'

function capabilityKeyPattern(kind: HireRuntimeReplayMediaKind): RegExp {
  return kind === 'screen'
    ? /-screen-\d{10,16}\.webm$/i
    : /\/[a-f0-9]{24}-\d{10,16}\.webm$/i
}

function stagedKind(kind: HireRuntimeReplayMediaKind): 'recording' | 'screen' {
  return kind === 'camera' ? 'recording' : 'screen'
}

function statusField(kind: HireRuntimeReplayMediaKind) {
  return kind === 'camera' ? 'cameraMediaStatus' as const : 'screenMediaStatus' as const
}

function terminalFields(kind: HireRuntimeReplayMediaKind) {
  return kind === 'camera'
    ? {
        at: 'cameraMediaUnavailableAt' as const,
        reason: 'cameraMediaUnavailableReason' as const,
        reportedAt: 'cameraMediaUnavailableReportedAt' as const,
        token: 'cameraMediaTerminalClaimToken' as const,
        expiresAt: 'cameraMediaTerminalClaimExpiresAt' as const,
        artifactVersion: 'cameraMediaTerminalClaimArtifactVersion' as const,
      }
    : {
        at: 'screenMediaUnavailableAt' as const,
        reason: 'screenMediaUnavailableReason' as const,
        reportedAt: 'screenMediaUnavailableReportedAt' as const,
        token: 'screenMediaTerminalClaimToken' as const,
        expiresAt: 'screenMediaTerminalClaimExpiresAt' as const,
        artifactVersion: 'screenMediaTerminalClaimArtifactVersion' as const,
      }
}

function artifactSnapshot(
  interview: CompletionArtifactSnapshot,
  kind: HireRuntimeReplayMediaKind,
): { key: string | null; sizeBytes: number | null; version: number } {
  return kind === 'camera'
    ? {
        key: interview.recordingR2Key ?? null,
        sizeBytes: interview.recordingSizeBytes ?? null,
        version: interview.recordingArtifactVersion ?? 0,
      }
    : {
        key: interview.screenRecordingR2Key ?? null,
        sizeBytes: interview.screenRecordingSizeBytes ?? null,
        version: interview.screenRecordingArtifactVersion ?? 0,
      }
}

function sameArtifact(
  left: ReturnType<typeof artifactSnapshot>,
  right: ReturnType<typeof artifactSnapshot>,
): boolean {
  return left.key === right.key &&
    left.sizeBytes === right.sizeBytes &&
    left.version === right.version
}

function hasArtifact(snapshot: ReturnType<typeof artifactSnapshot>): boolean {
  return Boolean(snapshot.key && snapshot.sizeBytes)
}

function noLiveCapability(kind: HireRuntimeReplayMediaKind, now: Date) {
  return {
    $not: {
      $elemMatch: {
        key: capabilityKeyPattern(kind),
        expiresAt: { $gt: now },
      },
    },
  }
}

function noLiveReservation(kind: HireRuntimeReplayMediaKind, now: Date) {
  return {
    $not: {
      $elemMatch: {
        kind,
        expiresAt: { $gt: now },
      },
    },
  }
}

function noLiveRuntimeDrain(now: Date) {
  return { $not: { $gt: now } }
}

async function completionArtifact(
  binding: IHireRuntimeBinding,
): Promise<CompletionArtifactSnapshot | null> {
  return InterviewSession.findOne({
    _id: binding.runtimeSessionId,
    userId: binding.principalId,
    organizationId: binding.workspaceId,
  })
    .select(
      'status recordingR2Key recordingSizeBytes recordingArtifactVersion screenRecordingR2Key screenRecordingSizeBytes screenRecordingArtifactVersion',
    )
    .lean<CompletionArtifactSnapshot>()
}

async function releaseTerminalClaim(input: {
  binding: IHireRuntimeBinding
  kind: HireRuntimeReplayMediaKind
  token: string
}): Promise<void> {
  const fields = terminalFields(input.kind)
  await HireRuntimeBinding.updateOne(
    {
      _id: input.binding._id,
      workspaceId: input.binding.workspaceId,
      [fields.token]: input.token,
    },
    {
      $unset: {
        [fields.token]: 1,
        [fields.expiresAt]: 1,
        [fields.artifactVersion]: 1,
      },
    },
  )
}

/**
 * Convert a required replay kind to terminal unavailable without racing an
 * upload/finalization. The binding claim excludes new pre-side-effect write
 * reservations; the exact session artifact version is then re-read before the
 * final CAS. A crashed claimant expires after one minute and never polls.
 */
export async function terminalizeRuntimeReplayMedia(input: {
  binding: IHireRuntimeBinding
  kind: HireRuntimeReplayMediaKind
  reason: HireRuntimeMediaUnavailableReason
  now?: Date
}): Promise<RuntimeMediaTerminalizationOutcome> {
  const { binding, kind } = input
  if (binding.mediaCompletionContractVersion !== 1) return 'legacy'
  if (kind === 'screen' && !supportsHireDisplayCapture(binding.consentVersion)) {
    return 'not_required'
  }
  const mediaStatusField = statusField(kind)
  if (binding[mediaStatusField] === 'published') return 'already_published'
  if (binding[mediaStatusField] === 'unavailable') return 'already_unavailable'
  if (!binding.runtimeSessionId) return 'session_pending'

  const before = await completionArtifact(binding)
  if (!before || before.status !== 'completed') return 'session_pending'
  const beforeArtifact = artifactSnapshot(before, kind)
  if (hasArtifact(beforeArtifact)) return 'artifact_present'

  const now = input.now ?? new Date()
  const fields = terminalFields(kind)
  const claimToken = randomBytes(32).toString('hex')
  const claimExpiresAt = new Date(now.getTime() + TERMINAL_CLAIM_MS)
  const capabilityFilter = noLiveCapability(kind, now)
  const claimed = await HireRuntimeBinding.findOneAndUpdate(
    {
      _id: binding._id,
      workspaceId: binding.workspaceId,
      runtimeSessionId: binding.runtimeSessionId,
      mediaCompletionContractVersion: 1,
      [mediaStatusField]: { $nin: ['published', 'unavailable'] },
      pendingMediaManifest: {
        $not: { $elemMatch: { kind: stagedKind(kind) } },
      },
      issuedObjectCapabilities: capabilityFilter,
      issuedMultipartCapabilities: capabilityFilter,
      mediaWriteReservations: noLiveReservation(kind, now),
      runtimeWriteDrainUntil: noLiveRuntimeDrain(now),
      revokedAt: { $exists: false },
      purgePersonalData: { $ne: true },
      $or: [
        { [fields.token]: { $exists: false } },
        { [fields.expiresAt]: { $lte: now } },
      ],
    },
    {
      $set: {
        [fields.token]: claimToken,
        [fields.expiresAt]: claimExpiresAt,
        [fields.artifactVersion]: beforeArtifact.version,
      },
    },
    { new: true, runValidators: true },
  )
  if (!claimed) return 'in_flight'

  const after = await completionArtifact(claimed)
  const afterArtifact = after ? artifactSnapshot(after, kind) : null
  if (
    !after ||
    after.status !== 'completed' ||
    !afterArtifact ||
    hasArtifact(afterArtifact) ||
    !sameArtifact(beforeArtifact, afterArtifact)
  ) {
    await releaseTerminalClaim({ binding: claimed, kind, token: claimToken })
    return after?.status === 'completed' ? 'in_flight' : 'session_pending'
  }

  const finalizedAt = input.now ?? new Date()
  const finalized = await HireRuntimeBinding.findOneAndUpdate(
    {
      _id: binding._id,
      workspaceId: binding.workspaceId,
      runtimeSessionId: binding.runtimeSessionId,
      mediaCompletionContractVersion: 1,
      [mediaStatusField]: { $nin: ['published', 'unavailable'] },
      [fields.token]: claimToken,
      [fields.artifactVersion]: afterArtifact.version,
      [fields.expiresAt]: { $gt: finalizedAt },
      pendingMediaManifest: {
        $not: { $elemMatch: { kind: stagedKind(kind) } },
      },
      issuedObjectCapabilities: noLiveCapability(kind, finalizedAt),
      issuedMultipartCapabilities: noLiveCapability(kind, finalizedAt),
      mediaWriteReservations: noLiveReservation(kind, finalizedAt),
      runtimeWriteDrainUntil: noLiveRuntimeDrain(finalizedAt),
      revokedAt: { $exists: false },
      purgePersonalData: { $ne: true },
    },
    {
      $set: {
        [mediaStatusField]: 'unavailable',
        [fields.at]: finalizedAt,
        [fields.reason]: input.reason,
        publishRetryAt: finalizedAt,
      },
      $unset: {
        [fields.reportedAt]: 1,
        [fields.token]: 1,
        [fields.expiresAt]: 1,
        [fields.artifactVersion]: 1,
        publishFailureCode: 1,
      },
    },
    { new: true, runValidators: true },
  )
  if (!finalized) {
    await releaseTerminalClaim({ binding: claimed, kind, token: claimToken })
    return 'state_changed'
  }
  return 'recorded'
}

export const __mediaCompletionService = {
  TERMINAL_CLAIM_MS,
  artifactSnapshot,
}
