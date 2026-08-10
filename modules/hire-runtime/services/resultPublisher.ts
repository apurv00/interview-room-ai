import { createHash } from 'node:crypto'
import {
  canonicalBridgeJson,
  HIRE_ENGINE_BRIDGE_SCHEMA_VERSION,
  HireEngineResultSchema,
  HireEngineResultIngestionSchema,
  type HireEngineResult,
  type HireEngineResultIngestion,
} from '@shared/contracts/hireEngineBridge'
import { HIRE_RUNTIME_WRITE_DRAIN_MS } from '@shared/contracts/hireRuntimeWriteFence'
import { InterviewSession } from '@shared/db/models/InterviewSession'
import {
  HireRuntimeBinding,
  type IHireRuntimeBinding,
} from '../models/HireRuntimeBinding'
import { connectHireRuntimeDB } from './runtimeBoundary'
import { publishResultToControl } from './controlBridgeClient'
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
const PUBLISH_RETRY_BASE_MS = 5_000
const PUBLISH_RETRY_MAX_MS = 5 * 60 * 1_000

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
  // Publication revision 1 is immutable. The source objects are deliberately
  // gone after acknowledgement, so a completed marker must short-circuit
  // before attempting to hash them again.
  if (binding.publishedRevision === RESULT_REVISION) {
    await markPublishChecked(binding)
    return 'skipped'
  }
  // Result projection/copy can hold transcript/media in memory and can write
  // publisher state. Reserve a bounded drain horizon before the first read;
  // privacy revocation atomically flips purgePersonalData and then waits for
  // this horizon, so it cannot acknowledge while a stale cron row is active.
  await reserveRuntimePublishDrain(binding)

  const session = (await InterviewSession.findOne({
    _id: binding.runtimeSessionId,
    userId: binding.principalId,
    organizationId: binding.workspaceId,
    status: 'completed',
  })
    .select(
      '_id status feedback evaluations answeredCount plannedQuestionCount endReason startedAt completedAt durationActualSeconds transcript recordingR2Key recordingSizeBytes audioRecordingR2Key audioRecordingSizeBytes updatedAt',
    )
    .lean()) as RuntimeSessionSnapshot | null
  if (!session) {
    await markPublishChecked(binding)
    return 'skipped'
  }

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
  if (!media) {
    media = await buildRuntimeMediaManifest({
      principalId: binding.principalId.toString(),
      runtimeSessionId: session._id.toString(),
      recordingR2Key: session.recordingR2Key,
      recordingSizeBytes: session.recordingSizeBytes,
      audioRecordingR2Key: session.audioRecordingR2Key,
      audioRecordingSizeBytes: session.audioRecordingSizeBytes,
    })
    if (media.length > 0) {
      const staged = await HireRuntimeBinding.updateOne(
        {
          _id: binding._id,
          workspaceId: binding.workspaceId,
          runtimeSessionId: session._id,
          publishedRevision: { $ne: RESULT_REVISION },
          purgePersonalData: { $ne: true },
        },
        { $set: { pendingMediaManifest: media } },
      )
      if (staged.matchedCount !== 1) {
        throw new Error('Runtime result binding changed before media staging')
      }
    }
  }

  const completedAt = session.completedAt ?? session.updatedAt ?? new Date()
  const digest = sha256(canonicalBridgeJson({
    results,
    startedAt: timeline.startedAt.toISOString(),
    completedAt: completedAt.toISOString(),
    durationMs: timeline.durationMs,
    transcript: timeline.transcript,
    media,
  }))
  const eventId = sha256(
    `${binding.roundId.toString()}:${session._id.toString()}:${RESULT_REVISION}:${digest}`,
  )
  const payload: HireEngineResultIngestion = {
    schemaVersion: HIRE_ENGINE_BRIDGE_SCHEMA_VERSION,
    eventId,
    workspaceId: binding.workspaceId.toString(),
    applicationId: binding.applicationId.toString(),
    roundId: binding.roundId.toString(),
    runtimeSessionId: session._id.toString(),
    attempt: Math.max(1, binding.attemptCount),
    revision: RESULT_REVISION,
    status: 'completed',
    startedAt: timeline.startedAt.toISOString(),
    completedAt: completedAt.toISOString(),
    durationMs: timeline.durationMs,
    resultDigest: digest,
    results,
    transcript: timeline.transcript,
    // Media transfer is a separate checksum-verified bridge operation.
    // Never send raw object URLs or candidate identity through this result contract.
    media,
  }

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
    runtimeSessionId: session._id.toString(),
    media,
  })
  const completed = await HireRuntimeBinding.updateOne(
    {
      _id: binding._id,
      workspaceId: binding.workspaceId,
      runtimeSessionId: session._id,
      purgePersonalData: { $ne: true },
    },
    {
      $set: {
        publishedRevision: RESULT_REVISION,
        publishedDigest: digest,
        publishedAt: new Date(),
        publishCheckedAt: new Date(),
        publishFailureCount: 0,
        ...(binding.status === 'revoked' ? {} : { status: 'completed' }),
      },
      $unset: {
        pendingMediaManifest: 1,
        publishRetryAt: 1,
        publishFailureCode: 1,
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
      publishedRevision: { $ne: RESULT_REVISION },
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
      $or: [
        { publishRetryAt: { $exists: false } },
        { publishRetryAt: { $lte: now } },
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
