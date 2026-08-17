import { createHash } from 'node:crypto'
import mongoose, { type ClientSession } from 'mongoose'
import {
  HIRE_MULTIMODAL_ANALYSIS_POLICY_VERSION,
  HireMultimodalAnalysisIngestionSchema,
  canonicalHireMultimodalAnalysisJson,
  hireMultimodalAnalysisDigestPayload,
  type HireMultimodalAnalysisIngestion,
} from '@shared/contracts/hireMultimodalAnalysisBridge'
import {
  HireApplication,
  HireConsentReceipt,
  HireInterviewAttempt,
  HireJob,
  HirePrivacyRequest,
  HireRound,
  isRecognizedHireConsentSnapshot,
  supportsHireMultimodalObservations,
  addCalendarMonths,
  connectHireControlDB,
  claimHireCandidatePiiWriteFence,
  HireCandidatePiiTombstoneError,
  ingestRuntimeMediaArtifacts,
} from '@hire'
import { HireMultimodalAnalysis, HireMultimodalAnalysisIngestionEvent } from '../models'

export class HireMultimodalAnalysisIngestionError extends Error {
  constructor(
    message: string,
    readonly code: 'not_found' | 'conflict' | 'digest_mismatch',
    readonly status: number,
  ) {
    super(message)
    this.name = 'HireMultimodalAnalysisIngestionError'
  }
}

export type HireMultimodalAnalysisIngestionOutcome =
  | 'processed'
  | 'duplicate'
  | 'stale'

export interface HireMultimodalAnalysisIngestionResult {
  outcome: HireMultimodalAnalysisIngestionOutcome
  analysisId?: string
}

interface AnalysisCoordinate {
  workspaceId: string
  applicationId: string
  jobId: string
  candidateId: string
  roundId: string
  attemptId: string
  purgeEligibleAt?: Date
}

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex')
}

export function analysisInputDigest(
  payload: Pick<
    HireMultimodalAnalysisIngestion,
    | 'capturedAt'
    | 'durationMs'
    | 'landmarks'
    | 'transcript'
    | 'liveTranscriptWords'
  >,
): string {
  return sha256(
    canonicalHireMultimodalAnalysisJson(
      hireMultimodalAnalysisDigestPayload(payload),
    ),
  )
}

function isDuplicateKeyError(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    (error as { code?: unknown }).code === 11000
  )
}

function sameEventCoordinate(
  existing: {
    workspaceId: { toString(): string }
    applicationId: { toString(): string }
    roundId: { toString(): string }
    runtimeSessionId: { toString(): string }
    revision: number
    inputDigest: string
  },
  payload: HireMultimodalAnalysisIngestion,
  inputDigest: string,
): boolean {
  return (
    existing.workspaceId.toString() === payload.workspaceId &&
    existing.applicationId.toString() === payload.applicationId &&
    existing.roundId.toString() === payload.roundId &&
    existing.runtimeSessionId.toString() === payload.runtimeSessionId &&
    existing.revision === payload.revision &&
    existing.inputDigest === inputDigest
  )
}

async function coordinateFor(
  payload: HireMultimodalAnalysisIngestion,
  session?: ClientSession,
): Promise<AnalysisCoordinate | 'stale'> {
  if (
    !supportsHireMultimodalObservations(payload.consentVersion) ||
    payload.policyVersion !== HIRE_MULTIMODAL_ANALYSIS_POLICY_VERSION
  ) {
    return 'stale'
  }
  const applicationQuery = HireApplication.findOne({
    _id: payload.applicationId,
    workspaceId: payload.workspaceId,
  }).select('candidateId jobId')
  if (session) applicationQuery.session(session)
  const application = await applicationQuery.lean()
  if (!application) {
    throw new HireMultimodalAnalysisIngestionError(
      'Application not found',
      'not_found',
      404,
    )
  }
  const roundQuery = HireRound.findOne({
    _id: payload.roundId,
    workspaceId: payload.workspaceId,
    applicationId: payload.applicationId,
    jobId: application.jobId,
    candidateId: application.candidateId,
    runtimeSessionId: payload.runtimeSessionId,
  }).select('consentVersion resultId')
  if (session) roundQuery.session(session)
  const round = await roundQuery.lean()
  if (!round) {
    throw new HireMultimodalAnalysisIngestionError('Round not found', 'not_found', 404)
  }
  if (!supportsHireMultimodalObservations(round.consentVersion) || !round.resultId) {
    return 'stale'
  }
  const attemptQuery = HireInterviewAttempt.findOne({
    workspaceId: payload.workspaceId,
    applicationId: payload.applicationId,
    jobId: application.jobId,
    candidateId: application.candidateId,
    roundId: payload.roundId,
    sequence: payload.attempt,
  }).select('_id consentReceiptId')
  if (session) attemptQuery.session(session)
  const attempt = await attemptQuery.lean()
  if (!attempt) {
    throw new HireMultimodalAnalysisIngestionError(
      'Interview attempt not found',
      'not_found',
      404,
    )
  }
  const receiptQuery = HireConsentReceipt.findOne({
    _id: attempt.consentReceiptId,
    workspaceId: payload.workspaceId,
    applicationId: payload.applicationId,
    jobId: application.jobId,
    candidateId: application.candidateId,
    roundId: payload.roundId,
    attemptId: attempt._id,
    'accepted.recording': true,
    'accepted.identityPhoto': true,
    'accepted.attentionMonitoring': true,
    'accepted.aiEvaluation': true,
  }).select('consentVersion disclosureDigest')
  if (session) receiptQuery.session(session)
  const receipt = await receiptQuery.lean()
  if (!receipt || !supportsHireMultimodalObservations(receipt.consentVersion) || !isRecognizedHireConsentSnapshot(receipt)) {
    return 'stale'
  }
  const privacyQuery = HirePrivacyRequest.exists({
    workspaceId: payload.workspaceId,
    candidateId: application.candidateId,
    live: true,
  })
  if (session) privacyQuery.session(session)
  if (await privacyQuery) return 'stale'
  const jobQuery = HireJob.findOne({
    _id: application.jobId,
    workspaceId: payload.workspaceId,
  }).select('status closedAt')
  if (session) jobQuery.session(session)
  const job = await jobQuery.lean()
  if (!job) {
    throw new HireMultimodalAnalysisIngestionError(
      'Interview job not found',
      'not_found',
      404,
    )
  }
  const purgeEligibleAt = job.status === 'closed' && job.closedAt
    ? addCalendarMonths(job.closedAt, 6)
    : undefined
  if (purgeEligibleAt && purgeEligibleAt <= new Date()) return 'stale'
  return {
    workspaceId: payload.workspaceId,
    applicationId: payload.applicationId,
    jobId: application.jobId.toString(),
    candidateId: application.candidateId.toString(),
    roundId: payload.roundId,
    attemptId: attempt._id.toString(),
    ...(purgeEligibleAt ? { purgeEligibleAt } : {}),
  }
}

async function existingOutcome(input: {
  payload: HireMultimodalAnalysisIngestion
  inputDigest: string
  session: ClientSession
}): Promise<HireMultimodalAnalysisIngestionResult | null> {
  const exact = await HireMultimodalAnalysisIngestionEvent.findOne({
    eventId: input.payload.eventId,
  })
    .session(input.session)
    .lean()
  if (exact) {
    if (!sameEventCoordinate(exact, input.payload, input.inputDigest)) {
      throw new HireMultimodalAnalysisIngestionError(
        'An analysis event id was reused with different content',
        'conflict',
        409,
      )
    }
    const analysis = await HireMultimodalAnalysis.findOne({
      workspaceId: input.payload.workspaceId,
      applicationId: input.payload.applicationId,
      roundId: input.payload.roundId,
      runtimeSessionId: input.payload.runtimeSessionId,
      revision: input.payload.revision,
    })
      .select('_id')
      .session(input.session)
      .lean()
    return {
      outcome: exact.status === 'processed' ? 'duplicate' : 'stale',
      ...(analysis ? { analysisId: analysis._id.toString() } : {}),
    }
  }
  const latest = await HireMultimodalAnalysis.findOne({
    workspaceId: input.payload.workspaceId,
    applicationId: input.payload.applicationId,
    roundId: input.payload.roundId,
    runtimeSessionId: input.payload.runtimeSessionId,
  })
    .sort({ revision: -1 })
    .session(input.session)
    .lean()
  if (!latest) return null
  if (latest.revision > input.payload.revision) return { outcome: 'stale' }
  if (latest.revision < input.payload.revision) return null
  if (latest.inputDigest === input.inputDigest) {
    return { outcome: 'duplicate', analysisId: latest._id.toString() }
  }
  throw new HireMultimodalAnalysisIngestionError(
    'The same analysis revision has different content',
    'conflict',
    409,
  )
}

async function recheckCandidateWriteFence(input: AnalysisCoordinate, session: ClientSession) {
  try {
    await claimHireCandidatePiiWriteFence({
      workspaceId: input.workspaceId,
      candidateId: input.candidateId,
      session,
    })
  } catch (error) {
    if (error instanceof HireCandidatePiiTombstoneError) return false
    throw error
  }
  return true
}

/**
 * Verifies and copies the raw runtime landmark artifact, then persists a
 * control-owned pending analysis. Processing is an independent Inngest job;
 * this ingest path never alters HireInterviewResult or JD scoring.
 */
export async function ingestHireMultimodalAnalysis(
  rawPayload: unknown,
): Promise<HireMultimodalAnalysisIngestionResult> {
  const payload = HireMultimodalAnalysisIngestionSchema.parse(rawPayload)
  await connectHireControlDB()
  const inputDigest = analysisInputDigest(payload)
  const coordinate = await coordinateFor(payload)
  if (coordinate === 'stale') return { outcome: 'stale' }

  // Reuse the existing cross-plane checksum copy and candidate PII write fence.
  // `facial_landmarks` is a private HireMediaAsset kind and media access
  // explicitly refuses to sign it for workspace users.
  const media = await ingestRuntimeMediaArtifacts({
    ...coordinate,
    runtimeSessionId: payload.runtimeSessionId,
    completedAt: new Date(payload.capturedAt),
    artifacts: [payload.landmarks],
  })
  const landmarkAsset = media.find((asset) => asset.kind === 'facial_landmarks')
  if (!landmarkAsset) {
    throw new Error('Runtime landmark artifact was not staged in control')
  }

  const dbSession = await mongoose.startSession()
  try {
    let result: HireMultimodalAnalysisIngestionResult = { outcome: 'stale' }
    await dbSession.withTransaction(async () => {
      const latestCoordinate = await coordinateFor(payload, dbSession)
      if (latestCoordinate === 'stale') return
      const duplicate = await existingOutcome({
        payload,
        inputDigest,
        session: dbSession,
      })
      if (duplicate) {
        result = duplicate
        return
      }
      if (!await recheckCandidateWriteFence(latestCoordinate, dbSession)) return
      const event = await HireMultimodalAnalysisIngestionEvent.create([{
        eventId: payload.eventId,
        workspaceId: latestCoordinate.workspaceId,
        applicationId: latestCoordinate.applicationId,
        candidateId: latestCoordinate.candidateId,
        roundId: latestCoordinate.roundId,
        runtimeSessionId: payload.runtimeSessionId,
        revision: payload.revision,
        inputDigest,
        status: 'received',
      }], { session: dbSession })
      const analysis = await HireMultimodalAnalysis.create([{
        workspaceId: latestCoordinate.workspaceId,
        applicationId: latestCoordinate.applicationId,
        jobId: latestCoordinate.jobId,
        candidateId: latestCoordinate.candidateId,
        roundId: latestCoordinate.roundId,
        attemptId: latestCoordinate.attemptId,
        runtimeSessionId: payload.runtimeSessionId,
        revision: payload.revision,
        eventId: payload.eventId,
        inputDigest,
        consentVersion: payload.consentVersion,
        policyVersion: payload.policyVersion,
        capturedAt: new Date(payload.capturedAt),
        durationMs: payload.durationMs,
        landmarksAssetId: landmarkAsset._id,
        inputTranscript: payload.transcript,
        liveTranscriptWords: payload.liveTranscriptWords,
        status: 'pending',
        retryAttemptCount: 0,
        ...(latestCoordinate.purgeEligibleAt
          ? { purgeEligibleAt: latestCoordinate.purgeEligibleAt, purgeReason: 'job_closed' }
          : {}),
      }], { session: dbSession })
      const processed = await HireMultimodalAnalysisIngestionEvent.updateOne(
        { _id: event[0]._id, eventId: payload.eventId, status: 'received' },
        { $set: { status: 'processed', processedAt: new Date() } },
        { session: dbSession },
      )
      if (processed.matchedCount !== 1) {
        throw new Error('Analysis ingestion event changed before completion')
      }
      result = { outcome: 'processed', analysisId: analysis[0]._id.toString() }
    })
    return result
  } catch (error) {
    if (isDuplicateKeyError(error)) {
      const existing = await HireMultimodalAnalysis.findOne({
        workspaceId: payload.workspaceId,
        applicationId: payload.applicationId,
        roundId: payload.roundId,
        runtimeSessionId: payload.runtimeSessionId,
        revision: payload.revision,
      })
        .select('_id inputDigest')
        .lean()
      if (existing?.inputDigest === inputDigest) {
        return { outcome: 'duplicate', analysisId: existing._id.toString() }
      }
    }
    throw error
  } finally {
    await dbSession.endSession()
  }
}

export const __hireMultimodalAnalysisIngestion = {
  analysisInputDigest,
  sameEventCoordinate,
}
