import { randomBytes } from 'node:crypto'
import {
  HIRE_MULTIMODAL_ANALYSIS_BRIDGE_SCHEMA_VERSION,
  HIRE_MULTIMODAL_ANALYSIS_POLICY_VERSION,
  HireMultimodalAnalysisIngestionSchema,
  type HireMultimodalAnalysisIngestion,
} from '@shared/contracts/hireMultimodalAnalysisBridge'
import { HIRE_RUNTIME_WRITE_DRAIN_MS } from '@shared/contracts/hireRuntimeWriteFence'
import { InterviewSession } from '@shared/db/models/InterviewSession'
import { supportsHireMultimodalObservations } from '@hire'
import {
  HireRuntimeBinding,
  type IHireRuntimeBinding,
} from '../models/HireRuntimeBinding'
import {
  HireRuntimeMultimodalAnalysisOutbox,
  type IHireRuntimeMultimodalAnalysisOutbox,
} from '../models/HireRuntimeMultimodalAnalysisOutbox'
import { publishMultimodalAnalysisToControl } from './controlBridgeClient'
import { isHireRuntimeMultimodalObservationRetentionPurged } from './multimodalObservationRetentionService'
import { deleteRuntimePersonalObjects } from './runtimeMediaManifest'
import { connectHireRuntimeDB } from './runtimeBoundary'
import { enumerateRuntimeWorkspaceIds } from './runtimeTenantScope'

const PUBLISH_LEASE_MS = 90_000
const RETRY_BASE_MS = 5_000
const RETRY_MAX_MS = 5 * 60 * 1_000
// Reserve BSON headroom below MongoDB's 16 MiB document limit.
const ANALYSIS_PAYLOAD_SNAPSHOT_MAX_BYTES = 12 * 1024 * 1024
const MAJORITY_WRITE_CONCERN = { w: 'majority', j: true } as const

type PublishOutcome = 'published' | 'stale' | 'deferred' | 'skipped'

interface RuntimeSessionAnalysisSnapshot {
  _id: { toString(): string }
  status: string
  startedAt?: Date | null
  completedAt?: Date | null
  updatedAt?: Date | null
  durationActualSeconds?: number | null
  transcript?: Array<{
    speaker?: unknown
    text?: unknown
    timestamp?: unknown
    questionIndex?: unknown
  }> | null
  liveTranscriptWords?: Array<{
    word?: unknown
    start?: unknown
    end?: unknown
    confidence?: unknown
  }> | null
}

function finiteNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null
}

function retryAt(attempt: number, now: Date): Date {
  const delay = Math.min(
    RETRY_MAX_MS,
    RETRY_BASE_MS * 2 ** Math.min(Math.max(attempt - 1, 0), 10),
  )
  return new Date(now.getTime() + delay)
}

function parseAnalysisPayloadSnapshot(
  outbox: IHireRuntimeMultimodalAnalysisOutbox,
  serialized: string,
): HireMultimodalAnalysisIngestion {
  const payload = HireMultimodalAnalysisIngestionSchema.parse(
    JSON.parse(serialized),
  )
  if (
    payload.eventId !== outbox.eventId ||
    payload.workspaceId !== outbox.workspaceId.toString() ||
    payload.applicationId !== outbox.applicationId.toString() ||
    payload.roundId !== outbox.roundId.toString() ||
    payload.runtimeSessionId !== outbox.runtimeSessionId.toString() ||
    payload.attempt !== outbox.attempt ||
    payload.revision !== outbox.revision ||
    payload.consentVersion !== outbox.consentVersion ||
    payload.policyVersion !== outbox.policyVersion ||
    payload.landmarks.sourceKey !== outbox.landmarkArtifact?.sourceKey ||
    payload.landmarks.objectKeyNonce !==
      outbox.landmarkArtifact?.objectKeyNonce ||
    payload.landmarks.sha256 !== outbox.artifactDigest
  ) {
    throw new Error('Runtime analysis payload snapshot does not match its outbox')
  }
  return payload
}

async function reserveAnalysisPayloadSnapshot(input: {
  outbox: IHireRuntimeMultimodalAnalysisOutbox
  payload: HireMultimodalAnalysisIngestion
}): Promise<HireMultimodalAnalysisIngestion> {
  const normalized = HireMultimodalAnalysisIngestionSchema.parse(input.payload)
  const serialized = JSON.stringify(normalized)
  if (Buffer.byteLength(serialized, 'utf8') > ANALYSIS_PAYLOAD_SNAPSHOT_MAX_BYTES) {
    throw new Error('Runtime analysis payload exceeds the durable snapshot limit')
  }
  const staged = await HireRuntimeMultimodalAnalysisOutbox.updateOne(
    {
      _id: input.outbox._id,
      status: 'pending',
      publishLeaseToken: input.outbox.publishLeaseToken,
      payloadSnapshotJson: { $exists: false },
    },
    { $set: { payloadSnapshotJson: serialized } },
    { writeConcern: MAJORITY_WRITE_CONCERN },
  )
  if (!staged.acknowledged) {
    throw new Error('Runtime analysis payload snapshot was not durably acknowledged')
  }
  if (staged.matchedCount === 1) {
    return parseAnalysisPayloadSnapshot(input.outbox, serialized)
  }

  const winner = await HireRuntimeMultimodalAnalysisOutbox.findOne({
    _id: input.outbox._id,
    status: 'pending',
    publishLeaseToken: input.outbox.publishLeaseToken,
    payloadSnapshotJson: { $exists: true },
  })
    .select('payloadSnapshotJson')
    .lean() as Pick<
      IHireRuntimeMultimodalAnalysisOutbox,
      'payloadSnapshotJson'
    > | null
  if (!winner?.payloadSnapshotJson) {
    throw new Error('Runtime analysis outbox changed before payload reservation')
  }
  return parseAnalysisPayloadSnapshot(input.outbox, winner.payloadSnapshotJson)
}

function timelineFromSession(session: RuntimeSessionAnalysisSnapshot): {
  startedAt: Date
  durationMs: number
  transcript: HireMultimodalAnalysisIngestion['transcript']
  liveTranscriptWords: HireMultimodalAnalysisIngestion['liveTranscriptWords']
} {
  const epochCandidates = (session.transcript ?? [])
    .map((entry) => finiteNumber(entry.timestamp))
    .filter((value): value is number => value !== null && value > 1_000_000_000_000)
  const startedAt = session.startedAt ??
    (epochCandidates.length > 0 ? new Date(Math.min(...epochCandidates)) : undefined)
  if (!startedAt || !Number.isFinite(startedAt.getTime())) {
    throw new Error('Completed runtime session has no trustworthy start time')
  }
  const transcript = (session.transcript ?? []).flatMap<
    HireMultimodalAnalysisIngestion['transcript'][number]
  >((entry) => {
    const speaker = entry.speaker === 'interviewer'
      ? 'interviewer'
      : entry.speaker === 'candidate'
        ? 'candidate'
        : null
    if (!speaker || typeof entry.text !== 'string') {
      return []
    }
    const rawTimestamp = finiteNumber(entry.timestamp)
    if (rawTimestamp === null) return []
    const timestampMs = Math.max(
      0,
      Math.round(
        rawTimestamp > 1_000_000_000_000
          ? rawTimestamp - startedAt.getTime()
          : rawTimestamp,
      ),
    )
    const rawQuestionIndex = finiteNumber(entry.questionIndex)
    return [{
      speaker,
      text: entry.text.slice(0, 20_000),
      timestampMs,
      ...(rawQuestionIndex === null
        ? {}
        : { questionIndex: Math.max(0, Math.min(500, Math.round(rawQuestionIndex))) }),
    }]
  })
  const liveTranscriptWords = (session.liveTranscriptWords ?? []).flatMap((word) => {
    if (typeof word.word !== 'string') return []
    const start = finiteNumber(word.start)
    const end = finiteNumber(word.end)
    const confidence = finiteNumber(word.confidence)
    if (start === null || end === null || confidence === null || end < start) return []
    return [{
      word: word.word.slice(0, 200),
      startMs: Math.max(0, Math.min(30 * 60 * 1_000, Math.round(start * 1_000))),
      endMs: Math.max(0, Math.min(30 * 60 * 1_000, Math.round(end * 1_000))),
      confidence: Math.max(0, Math.min(1, confidence)),
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
  const lastWordMs = liveTranscriptWords.reduce(
    (maximum, word) => Math.max(maximum, word.endMs),
    0,
  )
  return {
    startedAt,
    durationMs: Math.min(
      30 * 60 * 1_000,
      Math.max(
        1,
        Math.round(declaredMs === null ? elapsedMs : declaredMs * 1_000),
        lastTranscriptMs,
        lastWordMs,
      ),
    ),
    transcript,
    liveTranscriptWords,
  }
}

async function claimOutbox(
  candidate: IHireRuntimeMultimodalAnalysisOutbox,
  now: Date,
): Promise<IHireRuntimeMultimodalAnalysisOutbox | null> {
  const leaseToken = randomBytes(32).toString('hex')
  const adoptingSnapshotProtocol =
    candidate.payloadSnapshotProtocolVersion !== 1 &&
    (candidate.publishAttemptCount ?? 0) === 0
  return HireRuntimeMultimodalAnalysisOutbox.findOneAndUpdate(
    {
      _id: candidate._id,
      status: 'pending',
      ...(adoptingSnapshotProtocol
        ? {
            payloadSnapshotProtocolVersion: { $exists: false },
            publishAttemptCount: 0,
          }
        : {}),
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
        ...(adoptingSnapshotProtocol
          ? { payloadSnapshotProtocolVersion: 1 }
          : {}),
      },
    },
    { new: true },
  )
}

async function reservePublishDrain(
  outbox: IHireRuntimeMultimodalAnalysisOutbox,
  now: Date,
): Promise<IHireRuntimeBinding | null> {
  return HireRuntimeBinding.findOneAndUpdate(
    {
      workspaceId: outbox.workspaceId,
      applicationId: outbox.applicationId,
      roundId: outbox.roundId,
      principalId: outbox.principalId,
      runtimeSessionId: outbox.runtimeSessionId,
      // The normal result bridge creates the control-side immutable round
      // binding first. The analysis bridge must not race it or create an
      // unlinked recruiter record.
      publishedRevision: { $exists: true },
      status: { $in: ['active', 'completed', 'revoked'] },
      purgePersonalData: { $ne: true },
    },
    {
      $max: {
        runtimeWriteDrainUntil: new Date(now.getTime() + HIRE_RUNTIME_WRITE_DRAIN_MS),
      },
    },
    { new: true },
  )
}

async function deferOutbox(
  outbox: IHireRuntimeMultimodalAnalysisOutbox,
  now: Date,
): Promise<void> {
  await HireRuntimeMultimodalAnalysisOutbox.updateOne(
    { _id: outbox._id, status: 'pending', publishLeaseToken: outbox.publishLeaseToken },
    {
      $set: { publishRetryAt: new Date(now.getTime() + 30_000) },
      $unset: { publishLeaseToken: 1, publishLeaseExpiresAt: 1 },
    },
  )
}

async function recordFailure(
  outbox: IHireRuntimeMultimodalAnalysisOutbox,
  now: Date,
): Promise<void> {
  await HireRuntimeMultimodalAnalysisOutbox.updateOne(
    { _id: outbox._id, status: 'pending', publishLeaseToken: outbox.publishLeaseToken },
    {
      $set: {
        publishRetryAt: retryAt(outbox.publishAttemptCount, now),
        failureCode: 'HIRE_MULTIMODAL_ANALYSIS_PUBLISH_FAILED',
      },
      $unset: { publishLeaseToken: 1, publishLeaseExpiresAt: 1 },
    },
  )
}

async function clearAcknowledgedSource(input: {
  outbox: IHireRuntimeMultimodalAnalysisOutbox
  outcome: 'published' | 'stale'
  now: Date
}): Promise<void> {
  const artifact = input.outbox.landmarkArtifact
  if (artifact) {
    await deleteRuntimePersonalObjects({
      principalId: input.outbox.principalId.toString(),
      objects: [{
        key: artifact.sourceKey,
        runtimeSessionId: input.outbox.runtimeSessionId.toString(),
        ...(artifact.objectKeyNonce
          ? { objectKeyNonce: artifact.objectKeyNonce }
          : {}),
      }],
    })
    await InterviewSession.updateOne(
      {
        _id: input.outbox.runtimeSessionId,
        userId: input.outbox.principalId,
        organizationId: input.outbox.workspaceId,
        facialLandmarksR2Key: artifact.sourceKey,
      },
      { $unset: { facialLandmarksR2Key: 1 } },
    )
  }
  const settled = await HireRuntimeMultimodalAnalysisOutbox.updateOne(
    { _id: input.outbox._id, status: 'pending', publishLeaseToken: input.outbox.publishLeaseToken },
    {
      $set: { status: input.outcome, publishedAt: input.now },
      // The control plane is now the durable owner. Clear both raw-artifact
      // metadata and any retry lease from the isolated runtime database.
      $unset: {
        landmarkArtifact: 1,
        payloadSnapshotJson: 1,
        publishLeaseToken: 1,
        publishLeaseExpiresAt: 1,
        publishRetryAt: 1,
        failureCode: 1,
      },
    },
    { writeConcern: MAJORITY_WRITE_CONCERN },
  )
  if (!settled.acknowledged || settled.matchedCount !== 1) {
    throw new Error('Runtime multimodal analysis outbox changed before acknowledgement')
  }
}

function bridgePayload(
  outbox: IHireRuntimeMultimodalAnalysisOutbox,
  session: RuntimeSessionAnalysisSnapshot,
): HireMultimodalAnalysisIngestion | null {
  if (!outbox.landmarkArtifact) return null
  const timeline = timelineFromSession(session)
  return HireMultimodalAnalysisIngestionSchema.parse({
    schemaVersion: HIRE_MULTIMODAL_ANALYSIS_BRIDGE_SCHEMA_VERSION,
    eventId: outbox.eventId,
    workspaceId: outbox.workspaceId.toString(),
    applicationId: outbox.applicationId.toString(),
    roundId: outbox.roundId.toString(),
    runtimeSessionId: outbox.runtimeSessionId.toString(),
    attempt: outbox.attempt,
    revision: outbox.revision,
    consentVersion: outbox.consentVersion,
    policyVersion: HIRE_MULTIMODAL_ANALYSIS_POLICY_VERSION,
    capturedAt: outbox.capturedAt.toISOString(),
    durationMs: timeline.durationMs,
    landmarks: {
      kind: 'landmarks',
      ...outbox.landmarkArtifact,
    },
    transcript: timeline.transcript,
    liveTranscriptWords: timeline.liveTranscriptWords,
  })
}

async function retentionTombstoned(
  outbox: IHireRuntimeMultimodalAnalysisOutbox,
): Promise<boolean> {
  return isHireRuntimeMultimodalObservationRetentionPurged({
    workspaceId: outbox.workspaceId,
    applicationId: outbox.applicationId,
    roundId: outbox.roundId,
  })
}

async function publishOne(
  candidate: IHireRuntimeMultimodalAnalysisOutbox,
  now = new Date(),
): Promise<PublishOutcome> {
  const outbox = await claimOutbox(candidate, now)
  if (!outbox) return 'skipped'
  try {
    if (!supportsHireMultimodalObservations(outbox.consentVersion) || await retentionTombstoned(outbox)) {
      await clearAcknowledgedSource({ outbox, outcome: 'stale', now })
      return 'stale'
    }
    const binding = await reservePublishDrain(outbox, now)
    if (!binding) {
      const liveBinding = await HireRuntimeBinding.exists({
        workspaceId: outbox.workspaceId,
        applicationId: outbox.applicationId,
        roundId: outbox.roundId,
        runtimeSessionId: outbox.runtimeSessionId,
        purgePersonalData: { $ne: true },
      })
      if (!liveBinding) {
        await clearAcknowledgedSource({ outbox, outcome: 'stale', now })
        return 'stale'
      }
      await deferOutbox(outbox, now)
      return 'deferred'
    }
    // Claiming increments the attempt count. A count above one with no
    // snapshot means an older publisher may already have crossed the plane
    // and lost its acknowledgement. Preserve it for operator reconciliation;
    // rebuilding from the current mutable session could create a new digest.
    if (
      !outbox.payloadSnapshotJson &&
      outbox.payloadSnapshotProtocolVersion !== 1 &&
      outbox.publishAttemptCount > 1
    ) {
      throw new Error(
        'Legacy runtime analysis attempt requires operator snapshot reconciliation',
      )
    }
    let payload = outbox.payloadSnapshotJson
      ? parseAnalysisPayloadSnapshot(outbox, outbox.payloadSnapshotJson)
      : null
    if (!payload) {
      const session = await InterviewSession.findOne({
        _id: outbox.runtimeSessionId,
        userId: outbox.principalId,
        organizationId: outbox.workspaceId,
        status: 'completed',
      })
        .select(
          '_id status startedAt completedAt updatedAt durationActualSeconds transcript liveTranscriptWords',
        )
        .lean() as RuntimeSessionAnalysisSnapshot | null
      if (!session) {
        await deferOutbox(outbox, now)
        return 'deferred'
      }
      const candidatePayload = bridgePayload(outbox, session)
      if (!candidatePayload) {
        await clearAcknowledgedSource({ outbox, outcome: 'stale', now })
        return 'stale'
      }
      payload = await reserveAnalysisPayloadSnapshot({
        outbox,
        payload: candidatePayload,
      })
    }
    // Reserve immediately before crossing the plane, then repeat the durable
    // retention check. Both prevent a privacy/retention winner from leaving a
    // late raw-landmark artifact in control.
    if (!await reservePublishDrain(outbox, now) || await retentionTombstoned(outbox)) {
      await clearAcknowledgedSource({ outbox, outcome: 'stale', now })
      return 'stale'
    }
    const acknowledgement = await publishMultimodalAnalysisToControl(payload)
    await clearAcknowledgedSource({
      outbox,
      outcome: acknowledgement === 'stale' ? 'stale' : 'published',
      now,
    })
    return acknowledgement === 'stale' ? 'stale' : 'published'
  } catch {
    await recordFailure(outbox, now).catch(() => undefined)
    return 'skipped'
  }
}

export async function publishPendingHireMultimodalAnalyses(
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
  const perWorkspaceLimit = Math.max(1, Math.ceil(batchLimit / Math.max(workspaceIds.length, 1)))
  const candidates: IHireRuntimeMultimodalAnalysisOutbox[] = []
  for (const workspaceId of workspaceIds) {
    const scoped = await HireRuntimeMultimodalAnalysisOutbox.find({
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
    const outcome = await publishOne(candidate, now)
    if (outcome === 'published') published += 1
    else if (outcome === 'stale') stale += 1
    else if (outcome === 'deferred') deferred += 1
    else if (outcome === 'skipped') failed += 1
  }
  return { scanned: pending.length, published, stale, deferred, failed }
}

export const __hireRuntimeMultimodalAnalysisPublisher = {
  timelineFromSession,
  parseAnalysisPayloadSnapshot,
  reserveAnalysisPayloadSnapshot,
  publishOne,
}
