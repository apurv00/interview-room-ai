import { createHash } from 'node:crypto'
import {
  canonicalBridgeJson,
  HIRE_ENGINE_BRIDGE_SCHEMA_VERSION,
  HIRE_ENGINE_RESULT_MAX_BODY_BYTES,
  HireEngineResultSchema,
  HireEngineResultIngestionSchema,
  type HireEngineResult,
  type HireEngineResultIngestion,
} from '@shared/contracts/hireEngineBridge'
import { HIRE_RUNTIME_WRITE_DRAIN_MS } from '@shared/contracts/hireRuntimeWriteFence'
import { supportsHireDisplayCapture } from '@hire-multimodal-boundary'
import { InterviewSession } from '@shared/db/models/InterviewSession'
import {
  HireRuntimeBinding,
  type IHireRuntimeBinding,
} from '../models/HireRuntimeBinding'
import { connectHireRuntimeDB } from './runtimeBoundary'
import { publishResultToControl } from './controlBridgeClient'
import { terminalizeRuntimeReplayMedia } from './mediaCompletionService'
import {
  buildRuntimeMediaManifest,
  deleteRuntimeMediaManifest,
} from './runtimeMediaManifest'
import { enumerateRuntimeWorkspaceIds } from './runtimeTenantScope'

interface RuntimeSessionSnapshot {
  _id: { toString(): string }
  status: string
  feedback?: Record<string, unknown> | null
  evaluations?: Array<Record<string, unknown>> | null
  answeredCount?: number | null
  plannedQuestionCount?: number | null
  endReason?: string | null
  startedAt?: Date | null
  completedAt?: Date | null
  durationActualSeconds?: number | null
  transcript?: Array<{
    speaker?: unknown
    text?: unknown
    timestamp?: unknown
    questionIndex?: unknown
  }> | null
  recordingR2Key?: string | null
  recordingSizeBytes?: number | null
  screenRecordingR2Key?: string | null
  screenRecordingSizeBytes?: number | null
  audioRecordingR2Key?: string | null
  audioRecordingSizeBytes?: number | null
  updatedAt?: Date
}

function finiteNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null
}

export function buildRuntimeResult(session: RuntimeSessionSnapshot): HireEngineResult {
  const feedback = session.feedback as
    | {
        overall_score?: unknown
        pass_probability?: unknown
        confidence_level?: unknown
        dimensions?: {
          answer_quality?: { score?: unknown }
          communication?: { score?: unknown }
        }
        jd_match_score?: unknown
        red_flags?: unknown
        top_3_improvements?: unknown
      }
    | null
    | undefined

  const perQuestion = (session.evaluations ?? []).map((evaluation) => {
    const failed = evaluation.status === 'failed'
    const dimensions = failed
      ? []
      : [
          finiteNumber(evaluation.relevance),
          finiteNumber(evaluation.structure),
          finiteNumber(evaluation.specificity),
          finiteNumber(evaluation.ownership),
        ].filter((value): value is number => value !== null)
    return {
      questionIndex: finiteNumber(evaluation.questionIndex) ?? 0,
      question: typeof evaluation.question === 'string' ? evaluation.question : '',
      ...(typeof evaluation.answer === 'string' ? { answer: evaluation.answer } : {}),
      ...(typeof evaluation.answerSummary === 'string'
        ? { answerSummary: evaluation.answerSummary }
        : {}),
      score: dimensions.length
        ? Math.round(dimensions.reduce((sum, value) => sum + value, 0) / dimensions.length)
        : null,
      relevance: failed ? null : finiteNumber(evaluation.relevance),
      structure: failed ? null : finiteNumber(evaluation.structure),
      specificity: failed ? null : finiteNumber(evaluation.specificity),
      ownership: failed ? null : finiteNumber(evaluation.ownership),
      jdAlignment: failed ? null : finiteNumber(evaluation.jdAlignment),
      ...(Array.isArray(evaluation.flags) ? { flags: evaluation.flags } : {}),
      ...(failed ? { evaluationFailed: true } : {}),
    }
  })

  const unscored =
    feedback != null &&
    finiteNumber(feedback.overall_score) === 0 &&
    finiteNumber(feedback.dimensions?.answer_quality?.score) === 0 &&
    finiteNumber(feedback.dimensions?.communication?.score) === 0

  return HireEngineResultSchema.parse({
    overallScore: unscored ? null : finiteNumber(feedback?.overall_score),
    ...(!unscored && typeof feedback?.pass_probability === 'string'
      ? { passProbability: feedback.pass_probability }
      : {}),
    ...(!unscored && typeof feedback?.confidence_level === 'string'
      ? { confidenceLevel: feedback.confidence_level }
      : {}),
    answerQualityScore: unscored
      ? null
      : finiteNumber(feedback?.dimensions?.answer_quality?.score),
    communicationScore: unscored
      ? null
      : finiteNumber(feedback?.dimensions?.communication?.score),
    jdMatchScore: unscored ? null : finiteNumber(feedback?.jd_match_score),
    ...(Array.isArray(feedback?.red_flags) ? { redFlags: feedback.red_flags } : {}),
    ...(Array.isArray(feedback?.top_3_improvements)
      ? { topImprovements: feedback.top_3_improvements }
      : {}),
    answeredCount: finiteNumber(session.answeredCount),
    plannedQuestionCount: finiteNumber(session.plannedQuestionCount),
    endReason: typeof session.endReason === 'string' ? session.endReason : null,
    perQuestion,
    pending: !feedback,
    ...(unscored ? { unscored: true } : {}),
    ...(session.completedAt ? { sessionCompletedAt: session.completedAt.toISOString() } : {}),
  })
}

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex')
}

function buildRuntimeTimeline(session: RuntimeSessionSnapshot): {
  startedAt: Date
  durationMs: number
  transcript: Array<{
    speaker: 'interviewer' | 'candidate'
    text: string
    timestampMs: number
    questionIndex?: number | null
  }>
} {
  const epochCandidates = (session.transcript ?? [])
    .map((entry) => finiteNumber(entry.timestamp))
    .filter((value): value is number => value !== null && value > 1_000_000_000_000)
  const startedAt = session.startedAt ??
    (epochCandidates.length > 0 ? new Date(Math.min(...epochCandidates)) : undefined)
  if (!startedAt || !Number.isFinite(startedAt.getTime())) {
    throw new Error('Completed runtime session has no trustworthy start time')
  }
  const transcript = (session.transcript ?? []).flatMap((entry) => {
    if (
      (entry.speaker !== 'interviewer' && entry.speaker !== 'candidate') ||
      typeof entry.text !== 'string'
    ) {
      return []
    }
    const rawTimestamp = finiteNumber(entry.timestamp)
    if (rawTimestamp === null) return []
    const timestampMs = Math.max(
      0,
      Math.round(rawTimestamp > 1_000_000_000_000
        ? rawTimestamp - startedAt.getTime()
        : rawTimestamp),
    )
    const questionIndex = finiteNumber(entry.questionIndex)
    return [{
      speaker: entry.speaker as 'interviewer' | 'candidate',
      text: entry.text,
      timestampMs,
      ...(questionIndex === null ? {} : { questionIndex: Math.round(questionIndex) }),
    }]
  })
  const elapsedMs = session.completedAt
    ? Math.max(1, session.completedAt.getTime() - startedAt.getTime())
    : 1
  const declaredMs = finiteNumber(session.durationActualSeconds)
  const lastTranscriptMs = transcript.reduce(
    (maximum, entry) => Math.max(maximum, entry.timestampMs),
    0,
  )
  return {
    startedAt,
    durationMs: Math.max(
      1,
      Math.round(declaredMs === null ? elapsedMs : declaredMs * 1_000),
      lastTranscriptMs,
    ),
    transcript,
  }
}

const RESULT_REVISION = 1
const MAX_RESULT_REVISION = 10
const PUBLISH_RETRY_BASE_MS = 5_000
const PUBLISH_RETRY_MAX_MS = 5 * 60 * 1_000
// Camera and display replays can finish after feedback/result publication
// because the browser deliberately detaches their multipart uploads. Check
// again on the next publisher minute without treating that normal race as an
// error.
const CAMERA_MEDIA_RETRY_MS = 60_000
const MEDIA_COMPLETION_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1_000

function persistedMedia(
  binding: IHireRuntimeBinding,
): HireEngineResultIngestion['media'] | undefined {
  if (!binding.pendingMediaManifest) return undefined
  return HireEngineResultIngestionSchema.shape.media.parse(
    binding.pendingMediaManifest.map((artifact) => ({
      kind: artifact.kind,
      sourceKey: artifact.sourceKey,
      contentType: artifact.contentType,
      sizeBytes: artifact.sizeBytes,
      sha256: artifact.sha256,
    })),
  )
}

function isLateCameraPublication(binding: IHireRuntimeBinding): boolean {
  return (
    binding.publishedRevision !== undefined &&
    binding.publishedRevision < MAX_RESULT_REVISION &&
    binding.cameraMediaStatus === 'pending'
  )
}

function isLateScreenPublication(binding: IHireRuntimeBinding): boolean {
  return (
    supportsHireDisplayCapture(binding.consentVersion) &&
    binding.publishedRevision !== undefined &&
    binding.publishedRevision < MAX_RESULT_REVISION &&
    binding.screenMediaStatus === 'pending'
  )
}

function isLateReplayPublication(binding: IHireRuntimeBinding): boolean {
  return isLateCameraPublication(binding) || isLateScreenPublication(binding)
}

function isMediaCompletionReportPending(binding: IHireRuntimeBinding): boolean {
  if (
    binding.publishedRevision === undefined ||
    binding.publishedRevision >= MAX_RESULT_REVISION
  ) return false
  return (
    binding.cameraMediaStatus === 'unavailable' &&
    !binding.cameraMediaUnavailableReportedAt
  ) || (
    expectsScreenRecording(binding) &&
    binding.screenMediaStatus === 'unavailable' &&
    !binding.screenMediaUnavailableReportedAt
  )
}

function isPublishableBinding(binding: IHireRuntimeBinding): boolean {
  return binding.publishedRevision === undefined ||
    isLateReplayPublication(binding) ||
    isMediaCompletionReportPending(binding)
}

function containsCameraMedia(media: HireEngineResultIngestion['media']): boolean {
  return media.some((artifact) => artifact.kind === 'recording')
}

function containsScreenMedia(media: HireEngineResultIngestion['media']): boolean {
  return media.some((artifact) => artifact.kind === 'screen')
}

function expectsScreenRecording(binding: IHireRuntimeBinding): boolean {
  return supportsHireDisplayCapture(binding.consentVersion)
}

function mediaCompletionFor(
  binding: IHireRuntimeBinding,
  media: HireEngineResultIngestion['media'],
): HireEngineResultIngestion['mediaCompletion'] {
  if (binding.mediaCompletionContractVersion !== 1) return undefined
  const requiredState = (
    status: IHireRuntimeBinding['cameraMediaStatus'],
    reason: IHireRuntimeBinding['cameraMediaUnavailableReason'],
  ) => {
    if (status === 'published') return { status: 'published' as const }
    if (status === 'unavailable') {
      if (!reason) throw new Error('Unavailable runtime media has no terminal reason')
      return { status: 'unavailable' as const, reason }
    }
    return { status: 'pending' as const }
  }
  return {
    contractVersion: 1,
    camera: containsCameraMedia(media)
      ? { status: 'published' }
      : requiredState(
          binding.cameraMediaStatus,
          binding.cameraMediaUnavailableReason,
        ),
    screen: expectsScreenRecording(binding)
      ? containsScreenMedia(media)
        ? { status: 'published' }
        : requiredState(
            binding.screenMediaStatus,
            binding.screenMediaUnavailableReason,
          )
      : { status: 'not_required' },
  }
}

function hasLiveReplayCapability(
  binding: IHireRuntimeBinding,
  kind: 'camera' | 'screen',
  now: Date,
): boolean {
  return [
    ...(binding.issuedObjectCapabilities ?? []),
    ...(binding.issuedMultipartCapabilities ?? []),
  ].some((capability) => {
    if (capability.expiresAt <= now) return false
    return kind === 'screen'
      ? /-screen-\d{10,16}\.webm$/i.test(capability.key)
      : /\/[a-f0-9]{24}-\d{10,16}\.webm$/i.test(capability.key)
  })
}

function assertMediaConsent(
  binding: IHireRuntimeBinding,
  media: HireEngineResultIngestion['media'],
): void {
  if (containsScreenMedia(media) && !expectsScreenRecording(binding)) {
    throw new Error('Runtime display recording was not consented')
  }
}

function publicationStateFilter(binding: IHireRuntimeBinding): Record<string, unknown> {
  return {
    ...(binding.publishedRevision === undefined
      ? { publishedRevision: { $exists: false } }
      : { publishedRevision: binding.publishedRevision }),
    ...(binding.cameraMediaStatus === undefined
      ? { cameraMediaStatus: { $exists: false } }
      : { cameraMediaStatus: binding.cameraMediaStatus }),
    ...(binding.screenMediaStatus === undefined
      ? { screenMediaStatus: { $exists: false } }
      : { screenMediaStatus: binding.screenMediaStatus }),
    ...(binding.cameraMediaUnavailableReportedAt === undefined
      ? { cameraMediaUnavailableReportedAt: { $exists: false } }
      : { cameraMediaUnavailableReportedAt: binding.cameraMediaUnavailableReportedAt }),
    ...(binding.screenMediaUnavailableReportedAt === undefined
      ? { screenMediaUnavailableReportedAt: { $exists: false } }
      : { screenMediaUnavailableReportedAt: binding.screenMediaUnavailableReportedAt }),
  }
}

function parseResultPayloadSnapshot(
  binding: IHireRuntimeBinding,
  revision: number,
  serialized: string,
): HireEngineResultIngestion {
  const payload = HireEngineResultIngestionSchema.parse(JSON.parse(serialized))
  if (
    payload.workspaceId !== binding.workspaceId.toString() ||
    payload.applicationId !== binding.applicationId.toString() ||
    payload.roundId !== binding.roundId.toString() ||
    payload.runtimeSessionId !== binding.runtimeSessionId?.toString() ||
    payload.attempt !== Math.max(1, binding.attemptCount) ||
    payload.revision !== revision
  ) {
    throw new Error('Runtime result payload snapshot does not match its binding')
  }
  return payload
}

async function reserveResultPayloadSnapshot(input: {
  binding: IHireRuntimeBinding
  revision: number
  expectedPublicationState: Record<string, unknown>
  payload: HireEngineResultIngestion
}): Promise<HireEngineResultIngestion> {
  const normalized = HireEngineResultIngestionSchema.parse(input.payload)
  const serialized = JSON.stringify(normalized)
  if (Buffer.byteLength(serialized, 'utf8') > HIRE_ENGINE_RESULT_MAX_BODY_BYTES) {
    throw new Error('Runtime result payload exceeds the durable snapshot limit')
  }
  const staged = await HireRuntimeBinding.updateOne(
    {
      _id: input.binding._id,
      workspaceId: input.binding.workspaceId,
      runtimeSessionId: input.binding.runtimeSessionId,
      ...input.expectedPublicationState,
      purgePersonalData: { $ne: true },
      pendingResultPayloadJson: { $exists: false },
    },
    {
      // The exact media inventory and the exact outgoing payload become
      // authoritative in one CAS. Concurrent workers may build candidates,
      // but only this winner can define the revision that is sent.
      $set: {
        pendingMediaManifest: normalized.media,
        pendingResultPayloadJson: serialized,
      },
    },
  )
  if (staged.matchedCount === 1) {
    return parseResultPayloadSnapshot(
      input.binding,
      input.revision,
      serialized,
    )
  }

  const winner = await HireRuntimeBinding.findOne({
    _id: input.binding._id,
    workspaceId: input.binding.workspaceId,
    runtimeSessionId: input.binding.runtimeSessionId,
    ...input.expectedPublicationState,
    purgePersonalData: { $ne: true },
    pendingResultPayloadJson: { $exists: true },
  })
    .select('pendingResultPayloadJson')
    .lean() as Pick<IHireRuntimeBinding, 'pendingResultPayloadJson'> | null
  if (!winner?.pendingResultPayloadJson) {
    throw new Error('Runtime result binding changed before payload reservation')
  }
  return parseResultPayloadSnapshot(
    input.binding,
    input.revision,
    winner.pendingResultPayloadJson,
  )
}

async function expireUnavailableMediaIfDue(
  binding: IHireRuntimeBinding,
  session: RuntimeSessionSnapshot,
  now = new Date(),
): Promise<{ expired: boolean; deadline?: Date }> {
  if (binding.mediaCompletionContractVersion !== 1) {
    return { expired: false }
  }
  const completedAt = session.completedAt ?? session.updatedAt ?? now
  const deadline = binding.mediaCompletionDeadlineAt ??
    new Date(completedAt.getTime() + MEDIA_COMPLETION_MAX_AGE_MS)
  return { expired: false, deadline }
}

async function settleKnownExpiredMediaBeforePublish(
  binding: IHireRuntimeBinding,
  now = new Date(),
): Promise<boolean> {
  if (
    binding.mediaCompletionContractVersion !== 1 ||
    !binding.mediaCompletionDeadlineAt ||
    binding.mediaCompletionDeadlineAt > now
  ) return false

  const pendingKinds: Array<'camera' | 'screen'> = []
  if (
    binding.cameraMediaStatus !== 'published' &&
    binding.cameraMediaStatus !== 'unavailable' &&
    !hasLiveReplayCapability(binding, 'camera', now)
  ) pendingKinds.push('camera')
  if (
    expectsScreenRecording(binding) &&
    binding.screenMediaStatus !== 'published' &&
    binding.screenMediaStatus !== 'unavailable' &&
    !hasLiveReplayCapability(binding, 'screen', now)
  ) pendingKinds.push('screen')

  let deferPublication = false
  for (const kind of pendingKinds) {
    const outcome = await terminalizeRuntimeReplayMedia({
      binding,
      kind,
      reason: 'upload_expired',
      now,
    })
    // An already-associated artifact should proceed into the publisher. Every
    // other outcome means the binding changed or a bounded writer/drain is
    // still authoritative; do not extend that drain from this stale row.
    if (outcome !== 'artifact_present') deferPublication = true
  }
  return deferPublication
}

async function scheduleCameraMediaCheck(
  binding: IHireRuntimeBinding,
  now = new Date(),
): Promise<void> {
  await HireRuntimeBinding.updateOne(
    {
      _id: binding._id,
      workspaceId: binding.workspaceId,
      runtimeSessionId: binding.runtimeSessionId,
      ...publicationStateFilter(binding),
      purgePersonalData: { $ne: true },
    },
    {
      $set: {
        publishCheckedAt: now,
        publishFailureCount: 0,
        publishRetryAt: new Date(now.getTime() + CAMERA_MEDIA_RETRY_MS),
      },
      $unset: { publishFailureCode: 1 },
    },
  )
}

async function markPublishChecked(
  binding: Pick<IHireRuntimeBinding, '_id' | 'workspaceId'>,
): Promise<void> {
  await HireRuntimeBinding.updateOne(
    {
      _id: binding._id,
      workspaceId: binding.workspaceId,
      purgePersonalData: { $ne: true },
    },
    {
      $set: { publishCheckedAt: new Date(), publishFailureCount: 0 },
      $unset: { publishRetryAt: 1, publishFailureCode: 1 },
    },
  )
}

async function reserveRuntimePublishDrain(
  binding: IHireRuntimeBinding,
  now = new Date(),
): Promise<void> {
  const reserved = await HireRuntimeBinding.updateOne(
    {
      _id: binding._id,
      workspaceId: binding.workspaceId,
      runtimeSessionId: binding.runtimeSessionId,
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
  )
  if (reserved.matchedCount !== 1) {
    throw new Error('Runtime result binding is no longer publishable')
  }
}

async function publishRuntimeBindingResult(
  binding: IHireRuntimeBinding,
): Promise<'published' | 'skipped'> {
  // Revision 1 makes the scorecard available promptly. Detached camera and
  // display uploads can finish independently, so later revisions contain
  // only the still-pending replay kinds. Legacy bindings without an explicit
  // pending status remain terminal because their source object may already
  // have been deleted by an earlier publisher.
  if (!isPublishableBinding(binding)) {
    await markPublishChecked(binding)
    return 'skipped'
  }
  if (
    !binding.pendingResultPayloadJson &&
    await settleKnownExpiredMediaBeforePublish(binding)
  ) return 'skipped'
  const lateReplay = isLateReplayPublication(binding)
  const completionReportPending = isMediaCompletionReportPending(binding)
  const followUp = binding.publishedRevision !== undefined
  const revision = followUp
    ? (binding.publishedRevision ?? RESULT_REVISION) + 1
    : RESULT_REVISION
  const expectedPublicationState = publicationStateFilter(binding)
  // Result projection/copy can hold transcript/media in memory and can write
  // publisher state. Reserve a bounded drain horizon before the first read;
  // privacy revocation atomically flips purgePersonalData and then waits for
  // this horizon, so it cannot acknowledge while a stale cron row is active.
  await reserveRuntimePublishDrain(binding)

  let mediaCompletionDeadlineAt = binding.mediaCompletionDeadlineAt
  let payload = binding.pendingResultPayloadJson
    ? parseResultPayloadSnapshot(
        binding,
        revision,
        binding.pendingResultPayloadJson,
      )
    : null
  if (!payload) {
    const session = (await InterviewSession.findOne({
      _id: binding.runtimeSessionId,
      userId: binding.principalId,
      organizationId: binding.workspaceId,
      status: 'completed',
    })
      .select(
        '_id status feedback evaluations answeredCount plannedQuestionCount endReason startedAt completedAt durationActualSeconds transcript recordingR2Key recordingSizeBytes screenRecordingR2Key screenRecordingSizeBytes audioRecordingR2Key audioRecordingSizeBytes updatedAt',
      )
      .lean()) as RuntimeSessionSnapshot | null
    if (!session) {
      await markPublishChecked(binding)
      return 'skipped'
    }

    const mediaExpiry = await expireUnavailableMediaIfDue(binding, session)
    if (mediaExpiry.expired) return 'skipped'
    mediaCompletionDeadlineAt = mediaExpiry.deadline

    const results = buildRuntimeResult(session)
    const timeline = buildRuntimeTimeline(session)
    // The control result is immutable and evidence-linked. Do not publish a
    // provisional scorecard while engine feedback is still being generated;
    // the scheduled publisher retries until the authoritative result exists.
    if (results.pending) {
      await markPublishChecked(binding)
      return 'skipped'
    }

    let media = persistedMedia(binding)
    if (media) assertMediaConsent(binding, media)
    if (
      media?.some(
        (artifact) =>
          (artifact.kind === 'recording' &&
            binding.cameraMediaStatus === 'unavailable') ||
          (artifact.kind === 'screen' &&
            binding.screenMediaStatus === 'unavailable'),
      )
    ) {
      throw new Error('Unavailable runtime replay kind still has staged media')
    }
    if (
      lateReplay &&
      media &&
      !media.every(
        (artifact) =>
          (artifact.kind === 'recording' &&
            binding.cameraMediaStatus === 'pending') ||
          (artifact.kind === 'screen' && binding.screenMediaStatus === 'pending'),
      )
    ) {
      throw new Error('Late replay publication contains an unexpected artifact')
    }
    if (!media) {
      media = await buildRuntimeMediaManifest({
        principalId: binding.principalId.toString(),
        runtimeSessionId: session._id.toString(),
        ...((!lateReplay || binding.cameraMediaStatus === 'pending') &&
        binding.cameraMediaStatus !== 'unavailable' &&
        binding.cameraMediaStatus !== 'published'
          ? {
              recordingR2Key: session.recordingR2Key,
              recordingSizeBytes: session.recordingSizeBytes,
            }
          : {}),
        ...(expectsScreenRecording(binding) &&
        (!lateReplay || binding.screenMediaStatus === 'pending') &&
        binding.screenMediaStatus !== 'unavailable' &&
        binding.screenMediaStatus !== 'published'
          ? {
              screenRecordingR2Key: session.screenRecordingR2Key,
              screenRecordingSizeBytes: session.screenRecordingSizeBytes,
            }
          : {}),
        // Audio may have been copied and its isolated source object deleted by
        // revision 1. Later revisions are strictly for replay objects that were
        // not present when an earlier revision was built.
        ...(followUp
          ? {}
          : {
              audioRecordingR2Key: session.audioRecordingR2Key,
              audioRecordingSizeBytes: session.audioRecordingSizeBytes,
            }),
      })
      assertMediaConsent(binding, media)
      if (lateReplay && media.length === 0 && !completionReportPending) {
        await scheduleCameraMediaCheck(binding)
        return 'skipped'
      }
    }

    const completedAt = session.completedAt ?? session.updatedAt ?? new Date()
    const mediaCompletion = mediaCompletionFor(binding, media)
    const digest = sha256(canonicalBridgeJson({
      results,
      startedAt: timeline.startedAt.toISOString(),
      completedAt: completedAt.toISOString(),
      durationMs: timeline.durationMs,
      transcript: timeline.transcript,
      media,
      mediaCompletion,
    }))
    const attempt = Math.max(1, binding.attemptCount)
    const eventId = sha256(
      `${binding.roundId.toString()}:${session._id.toString()}:${attempt}:${revision}:${digest}`,
    )
    payload = await reserveResultPayloadSnapshot({
      binding,
      revision,
      expectedPublicationState,
      payload: {
        schemaVersion: HIRE_ENGINE_BRIDGE_SCHEMA_VERSION,
        eventId,
        workspaceId: binding.workspaceId.toString(),
        applicationId: binding.applicationId.toString(),
        roundId: binding.roundId.toString(),
        runtimeSessionId: session._id.toString(),
        attempt,
        revision,
        status: 'completed',
        startedAt: timeline.startedAt.toISOString(),
        completedAt: completedAt.toISOString(),
        durationMs: timeline.durationMs,
        resultDigest: digest,
        results,
        transcript: timeline.transcript,
        // Media transfer is a separate checksum-verified bridge operation.
        // Never send raw object URLs or candidate identity through this contract.
        media,
        ...(mediaCompletion ? { mediaCompletion } : {}),
      },
    })
  }

  if (
    binding.mediaCompletionContractVersion === 1 &&
    !mediaCompletionDeadlineAt
  ) {
    mediaCompletionDeadlineAt = new Date(
      new Date(payload.completedAt).getTime() + MEDIA_COMPLETION_MAX_AGE_MS,
    )
  }
  const media = payload.media
  const mediaCompletion = payload.mediaCompletion
  const digest = payload.resultDigest

  // Control acknowledges only after checksum-verified copying and durable
  // result ingestion. Runtime source deletion is therefore safe on all valid
  // outcomes, including a duplicate response after a prior partial attempt.
  // Close the scan/build-vs-privacy race immediately before crossing the
  // service boundary. Control independently discards behind its durable
  // privacy tombstone; this second atomic reservation avoids needless sends
  // when the runtime tombstone won first.
  await reserveRuntimePublishDrain(binding)
  await publishResultToControl(payload)
  await deleteRuntimeMediaManifest({
    principalId: binding.principalId.toString(),
    runtimeSessionId: payload.runtimeSessionId,
    media,
  })
  const now = new Date()
  const cameraPublished = containsCameraMedia(media)
  const screenPublished = containsScreenMedia(media)
  const cameraWasPending = lateReplay
    ? binding.cameraMediaStatus === 'pending'
    : binding.cameraMediaStatus !== 'unavailable' &&
      binding.cameraMediaStatus !== 'published'
  const screenWasPending = expectsScreenRecording(binding) &&
    (lateReplay
      ? binding.screenMediaStatus === 'pending'
      : binding.screenMediaStatus !== 'unavailable' &&
        binding.screenMediaStatus !== 'published')
  const cameraStillPending = cameraWasPending && !cameraPublished
  const screenStillPending = screenWasPending && !screenPublished
  const replayStillPending = cameraStillPending || screenStillPending
  const completed = await HireRuntimeBinding.updateOne(
    {
      _id: binding._id,
      workspaceId: binding.workspaceId,
      runtimeSessionId: binding.runtimeSessionId,
      ...expectedPublicationState,
      purgePersonalData: { $ne: true },
      pendingResultPayloadJson: JSON.stringify(payload),
    },
    {
      $set: {
        publishedRevision: revision,
        publishedDigest: digest,
        publishedAt: now,
        publishCheckedAt: now,
        publishFailureCount: 0,
        ...(mediaCompletionDeadlineAt
          ? { mediaCompletionDeadlineAt }
          : {}),
        ...(cameraWasPending
          ? cameraPublished
            ? {
                cameraMediaStatus: 'published',
                cameraMediaPublishedAt: now,
              }
            : {
                // A result may legitimately have no media or audio only while
                // the larger browser camera upload is still in flight. Do not
                // declare success for camera delivery until the recording is
                // part of a checksum-acknowledged manifest.
                cameraMediaStatus: 'pending',
              }
          : {}),
        ...(screenWasPending
          ? screenPublished
            ? {
                screenMediaStatus: 'published',
                screenMediaPublishedAt: now,
              }
            : { screenMediaStatus: 'pending' }
          : {}),
        ...(mediaCompletion?.camera.status === 'unavailable'
          ? { cameraMediaUnavailableReportedAt: now }
          : {}),
        ...(mediaCompletion?.screen.status === 'unavailable'
          ? { screenMediaUnavailableReportedAt: now }
          : {}),
        ...(replayStillPending
          ? { publishRetryAt: new Date(now.getTime() + CAMERA_MEDIA_RETRY_MS) }
          : {}),
        ...(binding.status === 'revoked' ? {} : { status: 'completed' }),
      },
      $unset: {
        pendingMediaManifest: 1,
        pendingResultPayloadJson: 1,
        publishFailureCode: 1,
        ...(!replayStillPending ? { publishRetryAt: 1 } : {}),
      },
    },
  )
  if (completed.matchedCount !== 1) {
    throw new Error('Runtime result binding changed after media cleanup')
  }
  return 'published'
}

async function recordPublishFailure(binding: IHireRuntimeBinding): Promise<void> {
  const failureCount = Math.min((binding.publishFailureCount ?? 0) + 1, 20)
  const retryMs = Math.min(
    PUBLISH_RETRY_MAX_MS,
    PUBLISH_RETRY_BASE_MS * 2 ** Math.min(failureCount - 1, 10),
  )
  await HireRuntimeBinding.updateOne(
    {
      _id: binding._id,
      workspaceId: binding.workspaceId,
      ...publicationStateFilter(binding),
      purgePersonalData: { $ne: true },
    },
    {
      $set: {
        publishCheckedAt: new Date(),
        publishFailureCount: failureCount,
        publishRetryAt: new Date(Date.now() + retryMs),
        // Fixed code avoids persisting candidate transcript fragments from an
        // exception while still exposing an operationally useful condition.
        publishFailureCode: 'RUNTIME_RESULT_PUBLISH_FAILED',
      },
    },
  )
}

export async function publishCompletedRuntimeResults(
  limit = 25,
): Promise<{ scanned: number; published: number; skipped: number; failed: number }> {
  await connectHireRuntimeDB()
  const now = new Date()
  const batchLimit = Math.min(Math.max(limit, 1), 100)
  const workspaceIds = await enumerateRuntimeWorkspaceIds()
  const perWorkspaceLimit = Math.max(
    1,
    Math.ceil(batchLimit / Math.max(workspaceIds.length, 1)),
  )
  const candidates: IHireRuntimeBinding[] = []
  for (const workspaceId of workspaceIds) {
    const scoped = await HireRuntimeBinding.find({
      workspaceId,
      runtimeSessionId: { $exists: true },
      status: { $in: ['active', 'completed', 'revoked'] },
      purgePersonalData: { $ne: true },
      $and: [
        {
          $or: [
            { publishedRevision: { $exists: false } },
            {
              publishedRevision: { $gte: RESULT_REVISION, $lt: MAX_RESULT_REVISION },
              cameraMediaStatus: 'pending',
            },
            {
              publishedRevision: { $gte: RESULT_REVISION, $lt: MAX_RESULT_REVISION },
              screenMediaStatus: 'pending',
            },
            {
              publishedRevision: { $gte: RESULT_REVISION, $lt: MAX_RESULT_REVISION },
              cameraMediaStatus: 'unavailable',
              cameraMediaUnavailableReportedAt: { $exists: false },
            },
            {
              publishedRevision: { $gte: RESULT_REVISION, $lt: MAX_RESULT_REVISION },
              screenMediaStatus: 'unavailable',
              screenMediaUnavailableReportedAt: { $exists: false },
            },
          ],
        },
        {
          $or: [
            { publishRetryAt: { $exists: false } },
            { publishRetryAt: { $lte: now } },
          ],
        },
      ],
    })
      .sort({ publishCheckedAt: 1, updatedAt: 1 })
      .limit(perWorkspaceLimit)
    candidates.push(...scoped)
  }
  const bindings = candidates
    .sort((left, right) => {
      const leftDate = left.publishCheckedAt ?? left.updatedAt
      const rightDate = right.publishCheckedAt ?? right.updatedAt
      const leftTime = leftDate instanceof Date ? leftDate.getTime() : 0
      const rightTime = rightDate instanceof Date ? rightDate.getTime() : 0
      return leftTime - rightTime
    })
    .slice(0, batchLimit)

  let published = 0
  let skipped = 0
  let failed = 0
  for (const binding of bindings) {
    try {
      const outcome = await publishRuntimeBindingResult(binding)
      if (outcome === 'published') published += 1
      else skipped += 1
    } catch {
      // A malformed/temporarily unavailable binding cannot starve later
      // completed interviews in the same cron batch.
      await recordPublishFailure(binding).catch(() => undefined)
      failed += 1
    }
  }
  return { scanned: bindings.length, published, skipped, failed }
}

export const __resultPublisher = {
  sha256,
  buildRuntimeTimeline,
  reserveRuntimePublishDrain,
  publishRuntimeBindingResult,
}
