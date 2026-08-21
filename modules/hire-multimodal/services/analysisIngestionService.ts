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
  completeHireRoundIngestion,
  connectHireControlDB,
  claimHireCandidatePiiWriteFence,
  HireCandidatePiiTombstoneError,
  HireRuntimeMediaStaleError,
  activateRuntimeMediaArtifacts,
  ingestRuntimeMediaArtifacts,
  quarantineRuntimeMediaAssets,
  releaseHireRoundIngestion,
  reserveHireRoundIngestion,
  type HireIngestionPriorOutcome,
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
    attempt: number
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
    existing.attempt === payload.attempt &&
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
  coordinate: AnalysisCoordinate
  session: ClientSession
}): Promise<HireIngestionPriorOutcome | 'resume' | null> {
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
    return exact.status === 'processed'
      ? exact.terminalOutcome === 'stale'
        ? 'stale'
        : 'duplicate'
      : 'resume'
  }
  const latestEvent = await HireMultimodalAnalysisIngestionEvent.findOne({
    workspaceId: input.payload.workspaceId,
    applicationId: input.payload.applicationId,
    roundId: input.payload.roundId,
    runtimeSessionId: input.payload.runtimeSessionId,
    status: { $in: ['received', 'processed'] },
  })
    .sort({ attempt: -1, revision: -1, createdAt: -1 })
    .session(input.session)
    .lean()
  if (latestEvent) {
    if (latestEvent.attempt > input.payload.attempt) return 'stale'
    if (latestEvent.attempt < input.payload.attempt) {
      return latestEvent.status === 'received' ? 'in_progress' : null
    }
    if (latestEvent.revision > input.payload.revision) return 'stale'
    if (latestEvent.revision === input.payload.revision) {
      if (latestEvent.inputDigest !== input.inputDigest) {
        throw new HireMultimodalAnalysisIngestionError(
          'The same analysis revision has different content',
          'conflict',
          409,
        )
      }
      return latestEvent.status === 'processed'
        ? latestEvent.terminalOutcome === 'stale'
          ? 'stale'
          : 'duplicate'
        : 'in_progress'
    }
    if (latestEvent.status === 'received') return 'in_progress'
  }

  // Legacy processed analyses predate the round reservation head. Checking
  // them inside the reservation transaction keeps legacy reads deterministic;
  // the drained protocol-v2 migration still backfills the durable event ledger.
  const latest = await HireMultimodalAnalysis.findOne({
    workspaceId: input.payload.workspaceId,
    applicationId: input.payload.applicationId,
    roundId: input.payload.roundId,
    attemptId: input.coordinate.attemptId,
    runtimeSessionId: input.payload.runtimeSessionId,
  })
    .sort({ revision: -1 })
    .session(input.session)
    .lean()
  if (!latest) return null
  if (latest.revision > input.payload.revision) return 'stale'
  if (latest.revision < input.payload.revision) return null
  if (latest.inputDigest === input.inputDigest) return 'duplicate'
  throw new HireMultimodalAnalysisIngestionError(
    'The same analysis revision has different content',
    'conflict',
    409,
  )
}

async function persistAnalysisReservation(input: {
  payload: HireMultimodalAnalysisIngestion
  inputDigest: string
  coordinate: AnalysisCoordinate
  session: ClientSession
}): Promise<HireIngestionPriorOutcome | null> {
  const prior = await existingOutcome(input)
  if (prior && prior !== 'resume') return prior
  if (prior === 'resume') return null
  await HireMultimodalAnalysisIngestionEvent.create(
    [
      {
        eventId: input.payload.eventId,
        workspaceId: input.coordinate.workspaceId,
        applicationId: input.coordinate.applicationId,
        candidateId: input.coordinate.candidateId,
        roundId: input.coordinate.roundId,
        runtimeSessionId: input.payload.runtimeSessionId,
        attempt: input.payload.attempt,
        revision: input.payload.revision,
        inputDigest: input.inputDigest,
        status: 'received',
      },
    ],
    { session: input.session },
  )
  return null
}

async function existingAnalysisId(
  payload: HireMultimodalAnalysisIngestion,
  inputDigest: string,
  attemptId: string,
): Promise<string | undefined> {
  const analysis = await HireMultimodalAnalysis.findOne({
    workspaceId: payload.workspaceId,
    applicationId: payload.applicationId,
    roundId: payload.roundId,
    attemptId,
    runtimeSessionId: payload.runtimeSessionId,
    revision: payload.revision,
    inputDigest,
  })
    .select('_id')
    .lean()
  return analysis?._id.toString()
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

async function completeAnalysisAsStale(input: {
  payload: HireMultimodalAnalysisIngestion
  inputDigest: string
  reservationToken: string
  coordinate?: AnalysisCoordinate
  assets?: Awaited<ReturnType<typeof ingestRuntimeMediaArtifacts>>
  reason?: 'privacy_request' | 'stale_staging'
}): Promise<HireMultimodalAnalysisIngestionResult> {
  const dbSession = await mongoose.startSession()
  try {
    await dbSession.withTransaction(async () => {
      if (input.coordinate && input.assets?.length) {
        await quarantineRuntimeMediaAssets({
          assets: input.assets,
          ...input.coordinate,
          reason: input.reason ?? 'stale_staging',
          session: dbSession,
        })
      }
      const processed = await HireMultimodalAnalysisIngestionEvent.updateOne(
        {
          eventId: input.payload.eventId,
          workspaceId: input.payload.workspaceId,
          applicationId: input.payload.applicationId,
          roundId: input.payload.roundId,
          runtimeSessionId: input.payload.runtimeSessionId,
          attempt: input.payload.attempt,
          revision: input.payload.revision,
          inputDigest: input.inputDigest,
          status: 'received',
        },
        {
          $set: {
            status: 'processed',
            terminalOutcome: 'stale',
            processedAt: new Date(),
          },
        },
        { session: dbSession },
      )
      if (processed.matchedCount !== 1) {
        throw new Error('Analysis ingestion event changed before stale completion')
      }
      await completeHireRoundIngestion({
        stream: 'multimodalAnalysis',
        workspaceId: input.payload.workspaceId,
        applicationId: input.payload.applicationId,
        roundId: input.payload.roundId,
        runtimeSessionId: input.payload.runtimeSessionId,
        attempt: input.payload.attempt,
        revision: input.payload.revision,
        eventId: input.payload.eventId,
        digest: input.inputDigest,
        reservationToken: input.reservationToken,
        terminalOutcome: 'stale',
        session: dbSession,
      })
    })
    return { outcome: 'stale' }
  } finally {
    await dbSession.endSession()
  }
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

  const reservationScope = {
    stream: 'multimodalAnalysis' as const,
    workspaceId: payload.workspaceId,
    applicationId: payload.applicationId,
    roundId: payload.roundId,
    runtimeSessionId: payload.runtimeSessionId,
    attempt: payload.attempt,
    revision: payload.revision,
    eventId: payload.eventId,
    digest: inputDigest,
  }
  const reservation = await reserveHireRoundIngestion({
    ...reservationScope,
    allowUnboundRuntimeSession: false,
    persistReservation: (session) =>
      persistAnalysisReservation({
        payload,
        inputDigest,
        coordinate,
        session,
      }),
  })
  if (reservation.outcome === 'stale') return { outcome: 'stale' }
  if (reservation.outcome === 'duplicate') {
    const analysisId = await existingAnalysisId(
      payload,
      inputDigest,
      coordinate.attemptId,
    )
    return {
      outcome: 'duplicate',
      ...(analysisId ? { analysisId } : {}),
    }
  }
  if (reservation.outcome === 'in_progress') {
    throw new HireMultimodalAnalysisIngestionError(
      'This analysis stream already has an active ingestion reservation',
      'conflict',
      409,
    )
  }
  if (reservation.outcome === 'conflict') {
    throw new HireMultimodalAnalysisIngestionError(
      reservation.reason,
      'conflict',
      409,
    )
  }
  if (reservation.outcome !== 'acquired') {
    throw new Error('Unexpected analysis ingestion reservation outcome')
  }
  const reservationToken = reservation.reservationToken
  let preparedMedia: Awaited<
    ReturnType<typeof ingestRuntimeMediaArtifacts>
  > = []

  try {
    // Reuse the existing cross-plane checksum copy and candidate PII write
    // fence only after the monotonic stream reservation is durable.
    const media = await ingestRuntimeMediaArtifacts({
      ...coordinate,
      runtimeSessionId: payload.runtimeSessionId,
      ingestionStream: 'multimodal_analysis',
      ingestionAttempt: payload.attempt,
      ingestionRevision: payload.revision,
      ingestionEventId: payload.eventId,
      ingestionDigest: inputDigest,
      completedAt: new Date(payload.capturedAt),
      artifacts: [payload.landmarks],
    })
    preparedMedia = media
    const landmarkAsset = media.find(
      (asset) => asset.kind === 'facial_landmarks',
    )
    if (!landmarkAsset) {
      throw new Error('Runtime landmark artifact was not staged in control')
    }

    const dbSession = await mongoose.startSession()
    try {
      let result: HireMultimodalAnalysisIngestionResult = { outcome: 'stale' }
      await dbSession.withTransaction(async () => {
        const latestCoordinate = await coordinateFor(payload, dbSession)
        const mayWrite =
          latestCoordinate !== 'stale' &&
          (await recheckCandidateWriteFence(latestCoordinate, dbSession))
        let analysisId: string | undefined
        if (latestCoordinate !== 'stale' && mayWrite) {
          await activateRuntimeMediaArtifacts({
            assets: media,
            ...latestCoordinate,
            session: dbSession,
          })
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
              ? {
                  purgeEligibleAt: latestCoordinate.purgeEligibleAt,
                  purgeReason: 'job_closed',
                }
              : {}),
          }], { session: dbSession })
          analysisId = analysis[0]._id.toString()
        } else {
          await quarantineRuntimeMediaAssets({
            assets: [landmarkAsset],
            ...coordinate,
            reason:
              latestCoordinate !== 'stale' && !mayWrite
                ? 'privacy_request'
                : 'stale_staging',
            session: dbSession,
          })
        }
        const terminalOutcome = analysisId ? 'processed' : 'stale'
        const processed = await HireMultimodalAnalysisIngestionEvent.updateOne(
          {
            eventId: payload.eventId,
            workspaceId: payload.workspaceId,
            applicationId: payload.applicationId,
            roundId: payload.roundId,
            runtimeSessionId: payload.runtimeSessionId,
            attempt: payload.attempt,
            revision: payload.revision,
            inputDigest,
            status: 'received',
          },
          {
            $set: {
              status: 'processed',
              terminalOutcome,
              processedAt: new Date(),
            },
          },
          { session: dbSession },
        )
        if (processed.matchedCount !== 1) {
          throw new Error('Analysis ingestion event changed before completion')
        }
        await completeHireRoundIngestion({
          ...reservationScope,
          reservationToken,
          terminalOutcome,
          session: dbSession,
        })
        result = analysisId
          ? { outcome: 'processed', analysisId }
          : { outcome: 'stale' }
      })
      return result
    } catch (error) {
      if (isDuplicateKeyError(error)) {
        const existing = await HireMultimodalAnalysis.findOne({
          workspaceId: payload.workspaceId,
          applicationId: payload.applicationId,
          roundId: payload.roundId,
          attemptId: coordinate.attemptId,
          runtimeSessionId: payload.runtimeSessionId,
          revision: payload.revision,
        })
          .select('_id inputDigest')
          .lean()
        if (existing?.inputDigest === inputDigest) {
          await dbSession.withTransaction(async () => {
            const abandonedStaging = media.filter(
              (asset) => asset.state === 'staging',
            )
            if (abandonedStaging.length > 0) {
              await quarantineRuntimeMediaAssets({
                assets: abandonedStaging,
                ...coordinate,
                reason: 'stale_staging',
                session: dbSession,
              })
            }
            const processed = await HireMultimodalAnalysisIngestionEvent.updateOne(
              {
                eventId: payload.eventId,
                workspaceId: payload.workspaceId,
                applicationId: payload.applicationId,
                roundId: payload.roundId,
                runtimeSessionId: payload.runtimeSessionId,
                attempt: payload.attempt,
                revision: payload.revision,
                inputDigest,
                status: 'received',
              },
              {
                $set: {
                  status: 'processed',
                  terminalOutcome: 'processed',
                  processedAt: new Date(),
                },
              },
              { session: dbSession },
            )
            if (processed.matchedCount !== 1) {
              throw new Error(
                'Analysis ingestion event changed before duplicate recovery',
              )
            }
            await completeHireRoundIngestion({
              ...reservationScope,
              reservationToken,
              terminalOutcome: 'processed',
              session: dbSession,
            })
          })
          return {
            outcome: 'duplicate',
            analysisId: existing._id.toString(),
          }
        }
      }
      throw error
    } finally {
      await dbSession.endSession()
    }
  } catch (error) {
    if (
      error instanceof HireRuntimeMediaStaleError ||
      error instanceof HireCandidatePiiTombstoneError
    ) {
      try {
        return await completeAnalysisAsStale({
          payload,
          inputDigest,
          reservationToken,
          coordinate,
          assets: preparedMedia,
          reason:
            error instanceof HireCandidatePiiTombstoneError
              ? 'privacy_request'
              : 'stale_staging',
        })
      } catch (completionError) {
        await releaseHireRoundIngestion({
          ...reservationScope,
          reservationToken,
        })
        throw completionError
      }
    }
    await releaseHireRoundIngestion({
      ...reservationScope,
      reservationToken,
    })
    throw error
  }
}

export const __hireMultimodalAnalysisIngestion = {
  analysisInputDigest,
  sameEventCoordinate,
}
