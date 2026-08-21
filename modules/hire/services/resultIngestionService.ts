import { createHash } from 'node:crypto'
import mongoose, { type ClientSession } from 'mongoose'
import {
  canonicalBridgeJson,
  HireEngineResultIngestionSchema,
  type HireEngineResultIngestion,
} from '@shared/contracts/hireEngineBridge'
import { supportsHireDisplayCapture } from '@hire-multimodal-boundary'
import type {
  HireAssessmentProjection,
  HireEvidenceRef,
} from '../models/HireInterviewResult'
import { HireApplication } from '../models/HireApplication'
import { HireRound } from '../models/HireRound'
import { HireInterviewAttempt } from '../models/HireInterviewAttempt'
import { HireEngineIngestionEvent } from '../models/HireEngineIngestionEvent'
import type { IHireMediaAsset } from '../models/HireMediaAsset'
import { HirePrivacyRequest } from '../models/HirePrivacyRequest'
import { connectHireControlDB } from './hireControlBoundary'
import {
  HireCandidatePiiTombstoneError,
} from './hireCandidatePrivacyWriteFence'
import {
  assertHireInterviewResultCompatible,
  persistHireInterviewResult,
} from './evidenceService'
import {
  completeHireRoundIngestion,
  releaseHireRoundIngestion,
  reserveHireRoundIngestion,
  type HireIngestionPriorOutcome,
} from './ingestionRevisionReservationService'
import {
  activateRuntimeMediaArtifacts,
  HireRuntimeMediaStaleError,
  ingestRuntimeMediaArtifacts,
  quarantineRuntimeMediaAssets,
} from './runtimeMediaIngestionService'

export class HireEngineIngestionError extends Error {
  constructor(
    message: string,
    readonly code:
      'not_found' | 'conflict' | 'digest_mismatch' | 'evidence_missing',
    readonly status: number,
  ) {
    super(message)
    this.name = 'HireEngineIngestionError'
  }
}

export type HireEngineIngestionOutcome = 'processed' | 'duplicate' | 'stale'

interface PreparedResultMedia {
  assets: IHireMediaAsset[]
  jobId: string
  candidateId: string
  attemptId: string
}

function resultDigest(
  payload: Pick<
    HireEngineResultIngestion,
    | 'results'
    | 'startedAt'
    | 'completedAt'
    | 'durationMs'
    | 'transcript'
    | 'media'
    | 'mediaCompletion'
  >,
): string {
  return createHash('sha256')
    .update(
      canonicalBridgeJson({
        results: payload.results,
        startedAt: payload.startedAt,
        completedAt: payload.completedAt,
        durationMs: payload.durationMs,
        transcript: payload.transcript,
        media: payload.media,
        mediaCompletion: payload.mediaCompletion,
      }),
    )
    .digest('hex')
}

function evidenceForQuestions(payload: HireEngineResultIngestion): {
  evidenceIndex: HireEvidenceRef[]
  questions: HireAssessmentProjection['questions']
} {
  const evidenceIndex: HireEvidenceRef[] = []
  const resultQuestions = payload.results.perQuestion ?? []
  const candidateIndexesByQuestion = new Map<number, number[]>()
  payload.transcript.forEach((entry, index) => {
    if (entry.speaker !== 'candidate' || entry.questionIndex == null)
      return
    const indexes = candidateIndexesByQuestion.get(entry.questionIndex) ?? []
    indexes.push(index)
    candidateIndexesByQuestion.set(entry.questionIndex, indexes)
  })
  const consumedCandidateIndexes = new Set<number>()
  const candidateIndexByResult = new Map<number, number>()
  const fallbackEligibleResults = new Set<number>()
  // Reserve all exact answer matches before positional fallback. Otherwise an
  // earlier result with an omitted/normalized answer can steal the transcript
  // entry that a later result identifies exactly.
  resultQuestions.forEach((question, resultIndex) => {
    if (typeof question.answer !== 'string') {
      fallbackEligibleResults.add(resultIndex)
      return
    }
    const allExactCandidateIndexes = (
      candidateIndexesByQuestion.get(question.questionIndex) ?? []
    ).filter((index) => payload.transcript[index].text === question.answer)
    if (allExactCandidateIndexes.length === 0) {
      fallbackEligibleResults.add(resultIndex)
      return
    }
    const availableExactCandidateIndexes = allExactCandidateIndexes.filter(
      (index) => !consumedCandidateIndexes.has(index),
    )
    if (
      allExactCandidateIndexes.length !== 1 ||
      availableExactCandidateIndexes.length !== 1
    )
      return
    const candidateIndex = availableExactCandidateIndexes[0]
    consumedCandidateIndexes.add(candidateIndex)
    candidateIndexByResult.set(resultIndex, candidateIndex)
  })
  const fallbackResultsByQuestion = new Map<number, number[]>()
  resultQuestions.forEach((question, resultIndex) => {
    if (
      candidateIndexByResult.has(resultIndex) ||
      !fallbackEligibleResults.has(resultIndex)
    )
      return
    const indexes = fallbackResultsByQuestion.get(question.questionIndex) ?? []
    indexes.push(resultIndex)
    fallbackResultsByQuestion.set(question.questionIndex, indexes)
  })
  fallbackResultsByQuestion.forEach((resultIndexes, questionIndex) => {
    const candidateIndexes = (
      candidateIndexesByQuestion.get(questionIndex) ?? []
    ).filter((index) => !consumedCandidateIndexes.has(index))
    // Positional fallback is authoritative only for one remaining result and
    // one remaining transcript response. Multiple unmatched results can be
    // persisted in evaluation-completion order rather than transcript order,
    // so equal counts alone are not enough to establish provenance.
    if (candidateIndexes.length !== 1 || resultIndexes.length !== 1) return
    consumedCandidateIndexes.add(candidateIndexes[0])
    candidateIndexByResult.set(resultIndexes[0], candidateIndexes[0])
  })
  const occurrencesByQuestion = new Map<number, number>()
  const questions = resultQuestions.map((question, resultIndex) => {
    const occurrence =
      (occurrencesByQuestion.get(question.questionIndex) ?? 0) + 1
    occurrencesByQuestion.set(question.questionIndex, occurrence)
    const questionId =
      occurrence === 1
        ? `q-${question.questionIndex}`
        : `q-${question.questionIndex}-${occurrence}`
    const candidateIndex = candidateIndexByResult.get(resultIndex) ?? -1
    let interviewerIndex = -1
    for (let index = candidateIndex - 1; index >= 0; index -= 1) {
      const entry = payload.transcript[index]
      if (
        entry.questionIndex === question.questionIndex &&
        entry.speaker === 'interviewer'
      ) {
        interviewerIndex = index
        break
      }
    }
    const evidenceIds: string[] = []
    if (candidateIndex >= 0) {
      const answerEntry = payload.transcript[candidateIndex]
      const nextEntry = payload.transcript[candidateIndex + 1]
      const id = `${questionId}-answer`
      const transcriptStart =
        interviewerIndex >= 0 ? interviewerIndex : candidateIndex
      const transcriptExcerpt = payload.transcript
        .slice(transcriptStart, candidateIndex + 1)
        .map(
          (entry) =>
            `${entry.speaker === 'candidate' ? 'Candidate' : 'Interviewer'}: ${entry.text}`,
        )
        .join('\n')
        .slice(0, 50_000)
      evidenceIndex.push({
        id,
        type: 'transcript_span',
        attemptId: '', // scoped attempt id is injected after lookup
        questionId,
        transcriptStart,
        transcriptEnd: candidateIndex,
        transcriptExcerpt,
        startMs: answerEntry.timestampMs,
        endMs: Math.max(
          answerEntry.timestampMs,
          Math.min(
            payload.durationMs,
            nextEntry?.timestampMs ?? payload.durationMs,
          ),
        ),
      })
      evidenceIds.push(id)
    }
    return {
      questionId,
      index: question.questionIndex,
      prompt: question.question,
      ...(candidateIndex >= 0
        ? { answer: payload.transcript[candidateIndex].text.slice(0, 20_000) }
        : {}),
      score: question.score,
      evidenceIds,
      ...(interviewerIndex >= 0
        ? {
            questionStartedMs: payload.transcript[interviewerIndex].timestampMs,
          }
        : {}),
      ...(candidateIndex >= 0
        ? {
            answerStartedMs: payload.transcript[candidateIndex].timestampMs,
            answerEndedMs: evidenceIndex[evidenceIndex.length - 1].endMs,
          }
        : {}),
    }
  })
  return { evidenceIndex, questions }
}

/** Feedback generation is instructed to use Q1 / Q3-Q5 provenance tokens. */
function questionIndexesInFinding(text: string): number[] {
  const indexes = new Set<number>()
  for (const match of Array.from(
    text.matchAll(/\bQ(\d+)(?:\s*[-–—]\s*Q?(\d+))?\b/gi),
  )) {
    const start = Number(match[1]) - 1
    const end = match[2] ? Number(match[2]) - 1 : start
    if (!Number.isInteger(start) || !Number.isInteger(end)) continue
    for (
      let index = Math.max(0, Math.min(start, end));
      index <= Math.max(start, end);
      index += 1
    ) {
      indexes.add(index)
    }
  }
  return Array.from(indexes)
}

function uniqueEvidenceIds(ids: string[]): string[] {
  return Array.from(new Set(ids))
}

function buildEvidenceProjection(
  payload: HireEngineResultIngestion,
  attemptId: string,
  cameraAssetId?: string,
): { projection: HireAssessmentProjection; evidenceIndex: HireEvidenceRef[] } {
  const built = evidenceForQuestions(payload)
  const evidenceIndex: HireEvidenceRef[] = built.evidenceIndex.map(
    (evidence) => ({
      ...evidence,
      attemptId,
    }),
  )
  if (cameraAssetId) {
    for (const question of built.questions) {
      if (
        question.answerStartedMs === undefined ||
        question.answerEndedMs === undefined
      ) {
        continue
      }
      const id = `${question.questionId}-recording`
      evidenceIndex.push({
        id,
        type: 'recording_range',
        attemptId,
        questionId: question.questionId,
        startMs: question.answerStartedMs,
        endMs: question.answerEndedMs,
        mediaAssetId: cameraAssetId,
      })
      question.evidenceIds.push(id)
    }
  }
  const scoredEvidenceIds = uniqueEvidenceIds(
    built.questions
      .filter((question) => question.score !== null)
      .flatMap((question) => question.evidenceIds),
  )
  const resultQuestions = payload.results.perQuestion ?? []
  const evidenceForDimension = (
    predicate: (
      question: NonNullable<
        HireEngineResultIngestion['results']['perQuestion']
      >[number],
    ) => boolean,
  ) =>
    uniqueEvidenceIds(
      built.questions
        .filter((_question, index) => {
          const result = resultQuestions[index]
          return result ? predicate(result) : false
        })
        .flatMap((question) => question.evidenceIds),
    )
  const answerQualityEvidence = evidenceForDimension(
    (question) =>
      (question.relevance !== null && question.relevance !== undefined) ||
      (question.structure !== null && question.structure !== undefined) ||
      (question.specificity !== null && question.specificity !== undefined) ||
      (question.ownership !== null && question.ownership !== undefined),
  )
  const communicationEvidence = evidenceForDimension(
    (question) =>
      (question.structure !== null && question.structure !== undefined) ||
      (question.specificity !== null && question.specificity !== undefined),
  )
  const jobAlignmentEvidence = evidenceForDimension(
    (question) =>
      question.jdAlignment !== null && question.jdAlignment !== undefined,
  )

  const dimensions: HireAssessmentProjection['dimensions'] = [
    {
      key: 'answer_quality',
      label: 'Answer quality',
      score:
        answerQualityEvidence.length > 0
          ? (payload.results.answerQualityScore ?? null)
          : null,
      evidenceIds: answerQualityEvidence,
    },
    {
      key: 'communication',
      label: 'Communication',
      score:
        communicationEvidence.length > 0
          ? (payload.results.communicationScore ?? null)
          : null,
      evidenceIds: communicationEvidence,
    },
    {
      key: 'job_alignment',
      label: 'Job alignment',
      score:
        jobAlignmentEvidence.length > 0
          ? (payload.results.jdMatchScore ?? null)
          : null,
      evidenceIds: jobAlignmentEvidence,
    },
  ]

  const evidenceForFinding = (text: string): string[] => {
    const referenced = questionIndexesInFinding(text)
    if (referenced.length === 0) {
      // The unchanged engine prompt permits no Q-ref only for genuinely
      // cross-cutting feedback, for which all contributing answers are the
      // honest provenance rather than a fabricated single moment.
      return scoredEvidenceIds
    }
    return uniqueEvidenceIds(
      referenced.flatMap(
        (index) =>
          built.questions
            .filter((question) => question.index === index)
            .flatMap((question) => question.evidenceIds),
      ),
    )
  }
  const findings: HireAssessmentProjection['findings'] = []
  const seenFindings = new Set<string>()
  const addGap = (text: string, evidenceIds: string[]) => {
    const normalized = text.trim()
    if (!normalized || seenFindings.has(normalized) || evidenceIds.length === 0)
      return
    seenFindings.add(normalized)
    findings.push({ kind: 'gap', text: normalized, evidenceIds })
  }
  resultQuestions.forEach((question, index) => {
    const ids = built.questions[index]?.evidenceIds ?? []
    for (const flag of question.flags ?? []) addGap(flag, ids)
  })
  for (const text of payload.results.redFlags ?? [])
    addGap(text, evidenceForFinding(text))
  for (const text of payload.results.topImprovements ?? [])
    addGap(text, evidenceForFinding(text))
  const strongest = built.questions
    .filter(
      (question) => question.score !== null && question.evidenceIds.length > 0,
    )
    .sort((left, right) => (right.score ?? -1) - (left.score ?? -1))[0]
  if (strongest) {
    findings.unshift({
      kind: 'strength',
      text: `Strongest scored response: ${strongest.prompt}`,
      evidenceIds: strongest.evidenceIds,
    })
  }

  const projection: HireAssessmentProjection = {
    overallScore: payload.results.overallScore,
    overallEvidenceIds: scoredEvidenceIds,
    ...(payload.results.passProbability
      ? { recommendation: payload.results.passProbability }
      : {}),
    ...(payload.results.confidenceLevel
      ? { confidence: payload.results.confidenceLevel }
      : {}),
    dimensions,
    findings,
    questions: built.questions,
  }
  const hasDisplayedScore =
    projection.overallScore !== null ||
    projection.dimensions.some((dimension) => dimension.score !== null) ||
    projection.questions.some((question) => question.score !== null)
  const hasUncitedScoredQuestion = projection.questions.some(
    (question) => question.score !== null && question.evidenceIds.length === 0,
  )
  if (
    hasDisplayedScore &&
    (scoredEvidenceIds.length === 0 || hasUncitedScoredQuestion)
  ) {
    throw new HireEngineIngestionError(
      'Scored engine results arrived without timestamped answer evidence',
      'evidence_missing',
      409,
    )
  }
  if (projection.findings.length > 0 && scoredEvidenceIds.length === 0) {
    throw new HireEngineIngestionError(
      'Engine findings arrived without timestamped answer evidence',
      'evidence_missing',
      409,
    )
  }
  return { projection, evidenceIndex }
}

async function existingOutcome(
  payload: HireEngineResultIngestion,
  dbSession: ClientSession,
): Promise<HireIngestionPriorOutcome | 'resume' | null> {
  const exact = await HireEngineIngestionEvent.findOne({
    eventId: payload.eventId,
  })
    .session(dbSession)
    .lean()
  if (exact) {
    if (
      exact.resultDigest !== payload.resultDigest ||
      exact.workspaceId.toString() !== payload.workspaceId ||
      exact.applicationId.toString() !== payload.applicationId ||
      exact.roundId.toString() !== payload.roundId ||
      exact.runtimeSessionId.toString() !== payload.runtimeSessionId ||
      exact.revision !== payload.revision ||
      exact.attempt !== payload.attempt
    ) {
      throw new HireEngineIngestionError(
        'An ingestion event id was reused with different content',
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

  const latest = await HireEngineIngestionEvent.findOne({
    workspaceId: payload.workspaceId,
    applicationId: payload.applicationId,
    roundId: payload.roundId,
    status: { $in: ['received', 'processed'] },
  })
    .sort({ attempt: -1, revision: -1, createdAt: -1 })
    .session(dbSession)
    .lean()
  if (!latest) return null
  if (latest.runtimeSessionId.toString() !== payload.runtimeSessionId) {
    throw new HireEngineIngestionError(
      'The round is already bound to a different runtime session',
      'conflict',
      409,
    )
  }
  if (latest.attempt > payload.attempt) return 'stale'
  if (latest.attempt < payload.attempt) {
    return latest.status === 'received' ? 'in_progress' : null
  }
  if (latest.revision > payload.revision) return 'stale'
  if (latest.revision === payload.revision) {
    if (latest.resultDigest === payload.resultDigest) {
      return latest.status === 'processed'
        ? latest.terminalOutcome === 'stale'
          ? 'stale'
          : 'duplicate'
        : 'in_progress'
    }
    throw new HireEngineIngestionError(
      'The same result revision has different content',
      'conflict',
      409,
    )
  }
  if (latest.status === 'received') return 'in_progress'
  return null
}

async function persistResultReservation(
  payload: HireEngineResultIngestion,
  dbSession: ClientSession,
): Promise<HireIngestionPriorOutcome | null> {
  const prior = await existingOutcome(payload, dbSession)
  if (prior && prior !== 'resume') return prior
  if (prior === 'resume') return null
  await HireEngineIngestionEvent.create(
    [
      {
        eventId: payload.eventId,
        workspaceId: payload.workspaceId,
        applicationId: payload.applicationId,
        roundId: payload.roundId,
        runtimeSessionId: payload.runtimeSessionId,
        revision: payload.revision,
        attempt: payload.attempt,
        resultDigest: payload.resultDigest,
        // The digest is the idempotency authority. Runtime source keys are
        // unnecessary PII-bearing delivery metadata and are never retained.
        media: [],
        ...(payload.mediaCompletion
          ? { mediaCompletion: payload.mediaCompletion }
          : {}),
        status: 'received',
      },
    ],
    { session: dbSession },
  )
  return null
}

async function discardResultBehindPrivacyTombstone(
  payload: HireEngineResultIngestion,
  attemptId: string,
  reservationToken: string,
  preparedMedia?: PreparedResultMedia,
): Promise<{ outcome: HireEngineIngestionOutcome }> {
  const dbSession = await mongoose.startSession()
  try {
    await dbSession.withTransaction(async () => {
      if (preparedMedia) {
        await quarantineRuntimeMediaAssets({
          assets: preparedMedia.assets,
          workspaceId: payload.workspaceId,
          applicationId: payload.applicationId,
          jobId: preparedMedia.jobId,
          candidateId: preparedMedia.candidateId,
          roundId: payload.roundId,
          attemptId: preparedMedia.attemptId,
          reason: 'privacy_request',
          session: dbSession,
        })
      }
      const runtimeSessionId = new mongoose.Types.ObjectId(
        payload.runtimeSessionId,
      )
      await HireInterviewAttempt.updateOne(
        {
          _id: attemptId,
          workspaceId: payload.workspaceId,
          applicationId: payload.applicationId,
          roundId: payload.roundId,
        },
        { $set: { status: 'revoked' }, $unset: { live: 1 } },
        { session: dbSession },
      )
      const processed = await HireEngineIngestionEvent.updateOne(
        {
          eventId: payload.eventId,
          workspaceId: payload.workspaceId,
          applicationId: payload.applicationId,
          roundId: payload.roundId,
          runtimeSessionId: payload.runtimeSessionId,
          revision: payload.revision,
          attempt: payload.attempt,
          resultDigest: payload.resultDigest,
          status: 'received',
        },
        {
          $set: {
            status: 'processed',
            terminalOutcome: 'processed',
            processedAt: new Date(),
            media: [],
          },
        },
        { session: dbSession },
      )
      if (processed.matchedCount !== 1) {
        throw new Error('Result ingestion event changed before completion')
      }
      await completeHireRoundIngestion({
        stream: 'engineResult',
        workspaceId: payload.workspaceId,
        applicationId: payload.applicationId,
        roundId: payload.roundId,
        runtimeSessionId: payload.runtimeSessionId,
        attempt: payload.attempt,
        revision: payload.revision,
        eventId: payload.eventId,
        digest: payload.resultDigest,
        reservationToken,
        terminalOutcome: 'processed',
        session: dbSession,
        set: { runtimeSessionId },
        unset: { live: 1 },
      })
    })
    return { outcome: 'processed' }
  } finally {
    await dbSession.endSession()
  }
}

async function completeResultAsStale(
  payload: HireEngineResultIngestion,
  reservationToken: string,
  preparedMedia?: PreparedResultMedia,
): Promise<{ outcome: HireEngineIngestionOutcome }> {
  const dbSession = await mongoose.startSession()
  try {
    await dbSession.withTransaction(async () => {
      if (preparedMedia) {
        await quarantineRuntimeMediaAssets({
          assets: preparedMedia.assets,
          workspaceId: payload.workspaceId,
          applicationId: payload.applicationId,
          jobId: preparedMedia.jobId,
          candidateId: preparedMedia.candidateId,
          roundId: payload.roundId,
          attemptId: preparedMedia.attemptId,
          reason: 'stale_staging',
          session: dbSession,
        })
      }
      const processed = await HireEngineIngestionEvent.updateOne(
        {
          eventId: payload.eventId,
          workspaceId: payload.workspaceId,
          applicationId: payload.applicationId,
          roundId: payload.roundId,
          runtimeSessionId: payload.runtimeSessionId,
          attempt: payload.attempt,
          revision: payload.revision,
          resultDigest: payload.resultDigest,
          status: 'received',
        },
        {
          $set: {
            status: 'processed',
            terminalOutcome: 'stale',
            processedAt: new Date(),
            media: [],
          },
        },
        { session: dbSession },
      )
      if (processed.matchedCount !== 1) {
        throw new Error('Result ingestion event changed before stale completion')
      }
      await completeHireRoundIngestion({
        stream: 'engineResult',
        workspaceId: payload.workspaceId,
        applicationId: payload.applicationId,
        roundId: payload.roundId,
        runtimeSessionId: payload.runtimeSessionId,
        attempt: payload.attempt,
        revision: payload.revision,
        eventId: payload.eventId,
        digest: payload.resultDigest,
        reservationToken,
        terminalOutcome: 'stale',
        session: dbSession,
      })
    })
    return { outcome: 'stale' }
  } finally {
    await dbSession.endSession()
  }
}

export async function ingestHireEngineResult(
  rawPayload: unknown,
): Promise<{ outcome: HireEngineIngestionOutcome }> {
  const payload = HireEngineResultIngestionSchema.parse(rawPayload)
  if (resultDigest(payload) !== payload.resultDigest) {
    throw new HireEngineIngestionError(
      'Result digest does not match the canonical result payload',
      'digest_mismatch',
      400,
    )
  }
  await connectHireControlDB()

  const application = await HireApplication.findOne({
    _id: payload.applicationId,
    workspaceId: payload.workspaceId,
  }).lean()
  if (!application) {
    throw new HireEngineIngestionError(
      'Application not found',
      'not_found',
      404,
    )
  }
  const round = await HireRound.findOne({
    _id: payload.roundId,
    workspaceId: payload.workspaceId,
    applicationId: payload.applicationId,
    candidateId: application.candidateId,
    jobId: application.jobId,
  }).lean()
  if (!round)
    throw new HireEngineIngestionError('Round not found', 'not_found', 404)
  if (
    round.runtimeSessionId &&
    round.runtimeSessionId.toString() !== payload.runtimeSessionId
  ) {
    throw new HireEngineIngestionError(
      'Round is already linked to a different runtime session',
      'conflict',
      409,
    )
  }
  const attempt = await HireInterviewAttempt.findOne({
    workspaceId: payload.workspaceId,
    applicationId: payload.applicationId,
    jobId: application.jobId,
    candidateId: application.candidateId,
    roundId: payload.roundId,
    sequence: payload.attempt,
  }).lean()
  if (!attempt) {
    throw new HireEngineIngestionError(
      'Interview attempt not found',
      'not_found',
      404,
    )
  }
  const privacyTombstone = await HirePrivacyRequest.exists({
    workspaceId: payload.workspaceId,
    candidateId: application.candidateId,
    status: { $in: ['processing', 'completed'] },
  })
  if (
    payload.media.some((artifact) => artifact.kind === 'screen') &&
    !supportsHireDisplayCapture(round.consentVersion)
  ) {
    throw new HireEngineIngestionError(
      'Display recording was not consented for this interview',
      'conflict',
      409,
    )
  }
  const evidenceWithoutMedia = privacyTombstone
    ? undefined
    : buildEvidenceProjection(payload, attempt._id.toString())
  const rawEngineOutput = {
    results: payload.results,
    startedAt: payload.startedAt,
    completedAt: payload.completedAt,
    durationMs: payload.durationMs,
    transcript: payload.transcript,
  }
  const reservationScope = {
    stream: 'engineResult' as const,
    workspaceId: payload.workspaceId,
    applicationId: payload.applicationId,
    roundId: payload.roundId,
    runtimeSessionId: payload.runtimeSessionId,
    attempt: payload.attempt,
    revision: payload.revision,
    eventId: payload.eventId,
    digest: payload.resultDigest,
  }
  const reservation = await reserveHireRoundIngestion({
    ...reservationScope,
    allowUnboundRuntimeSession: true,
    persistReservation: (session) =>
      persistResultReservation(payload, session),
  })
  if (reservation.outcome === 'stale' || reservation.outcome === 'duplicate') {
    return { outcome: reservation.outcome }
  }
  if (reservation.outcome === 'in_progress') {
    throw new HireEngineIngestionError(
      'This result stream already has an active ingestion reservation',
      'conflict',
      409,
    )
  }
  if (reservation.outcome === 'conflict') {
    throw new HireEngineIngestionError(
      reservation.reason,
      'conflict',
      409,
    )
  }
  if (reservation.outcome !== 'acquired') {
    throw new Error('Unexpected result ingestion reservation outcome')
  }
  const reservationToken = reservation.reservationToken
  let preparedMedia: PreparedResultMedia | undefined

  try {
    if (privacyTombstone) {
      return await discardResultBehindPrivacyTombstone(
        payload,
        attempt._id.toString(),
        reservationToken,
      )
    }
    // Immutable result identity is independent of copied media. Reject a
    // higher-revision score/transcript conflict before creating any staging
    // checkpoint or touching R2.
    await assertHireInterviewResultCompatible({
      workspaceId: payload.workspaceId,
      applicationId: payload.applicationId,
      roundId: payload.roundId,
      attemptId: attempt._id.toString(),
      rawEngineOutput,
    })
    const mediaAssets = await ingestRuntimeMediaArtifacts({
      workspaceId: payload.workspaceId,
      applicationId: payload.applicationId,
      jobId: application.jobId.toString(),
      candidateId: application.candidateId.toString(),
      roundId: payload.roundId,
      attemptId: attempt._id.toString(),
      runtimeSessionId: payload.runtimeSessionId,
      ingestionStream: 'engine_result',
      ingestionAttempt: payload.attempt,
      ingestionRevision: payload.revision,
      ingestionEventId: payload.eventId,
      ingestionDigest: payload.resultDigest,
      completedAt: new Date(payload.completedAt),
      artifacts: payload.media,
    })
    preparedMedia = {
      assets: mediaAssets,
      jobId: application.jobId.toString(),
      candidateId: application.candidateId.toString(),
      attemptId: attempt._id.toString(),
    }
    const cameraAsset = mediaAssets.find(
      (asset) => asset.kind === 'camera_recording',
    )
    const evidence = cameraAsset
      ? buildEvidenceProjection(
          payload,
          attempt._id.toString(),
          cameraAsset._id.toString(),
        )
      : evidenceWithoutMedia
    if (!evidence) {
      throw new Error('Result evidence was not prepared before ingestion')
    }
    const persistedResult = await persistHireInterviewResult({
      workspaceId: payload.workspaceId,
      applicationId: payload.applicationId,
      jobId: application.jobId.toString(),
      candidateId: application.candidateId.toString(),
      roundId: payload.roundId,
      attemptId: attempt._id.toString(),
      adapterVersion: 'hire-runtime-bridge-v1',
      engineContractVersion: `interview-engine:${payload.schemaVersion}`,
      rawEngineOutput,
      projection: evidence.projection,
      evidenceIndex: evidence.evidenceIndex,
      completedAt: new Date(payload.completedAt),
      durationMs: payload.durationMs,
    })

    const dbSession = await mongoose.startSession()
    let privacyWon = false
    try {
      try {
        await dbSession.withTransaction(async () => {
          if (!preparedMedia) {
            throw new Error('Result media was not prepared before terminalization')
          }
          // This claims workspace, candidate, and job in the same transaction
          // that activates the complete batch and terminalizes the event.
          // Job close therefore wins wholly before us or observes the final
          // completed state after us; it cannot split media from lifecycle.
          await activateRuntimeMediaArtifacts({
            ...preparedMedia,
            workspaceId: payload.workspaceId,
            applicationId: payload.applicationId,
            roundId: payload.roundId,
            session: dbSession,
          })
          const runtimeSessionId = new mongoose.Types.ObjectId(
            payload.runtimeSessionId,
          )
          const currentRound = await HireRound.findOne({
            _id: payload.roundId,
            workspaceId: payload.workspaceId,
            applicationId: payload.applicationId,
            jobId: application.jobId,
            candidateId: application.candidateId,
            $or: [
              { runtimeSessionId: { $exists: false } },
              { runtimeSessionId },
            ],
          })
            .select('runtimeSessionId status revokedAt')
            .session(dbSession)
            .lean()
          if (!currentRound) {
            throw new HireRuntimeMediaStaleError(
              'Round changed before result terminalization',
            )
          }
          const firstLink = !currentRound.runtimeSessionId
          const completedAfterRevoke = Boolean(
            currentRound.revokedAt || currentRound.status === 'revoked',
          )
          const claimedAttempt = await HireInterviewAttempt.updateOne(
            {
              _id: attempt._id,
              workspaceId: payload.workspaceId,
              applicationId: payload.applicationId,
              jobId: application.jobId,
              candidateId: application.candidateId,
              roundId: payload.roundId,
              resultId: persistedResult._id,
              status: completedAfterRevoke
                ? { $in: ['completed', 'revoked'] }
                : 'completed',
            },
            {
              $set: {
                resultId: persistedResult._id,
                completedAt: new Date(payload.completedAt),
              },
              $unset: { live: 1 },
            },
            { session: dbSession },
          )
          if (claimedAttempt.matchedCount !== 1) {
            throw new HireRuntimeMediaStaleError(
              'Interview attempt changed before result terminalization',
            )
          }
          const snapshot = {
            ...payload.results,
            sessionCompletedAt: new Date(payload.completedAt),
            ...(completedAfterRevoke ? { completedAfterRevoke: true } : {}),
          }
          if (firstLink) {
            await HireApplication.updateOne(
              { _id: payload.applicationId, workspaceId: payload.workspaceId },
              {
                $push: {
                  events: {
                    type: 'ai_result_linked',
                    actorName: 'System',
                    note: completedAfterRevoke
                      ? 'AI interview completed after revocation — results attached and flagged'
                      : 'AI interview completed — results ingested from isolated runtime',
                    at: new Date(),
                  },
                },
              },
              { session: dbSession },
            )
          }
          const processed = await HireEngineIngestionEvent.updateOne(
            {
              eventId: payload.eventId,
              workspaceId: payload.workspaceId,
              applicationId: payload.applicationId,
              roundId: payload.roundId,
              runtimeSessionId: payload.runtimeSessionId,
              revision: payload.revision,
              attempt: payload.attempt,
              resultDigest: payload.resultDigest,
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
            throw new Error('Result ingestion event changed before completion')
          }
          await completeHireRoundIngestion({
            ...reservationScope,
            reservationToken,
            terminalOutcome: 'processed',
            session: dbSession,
            set: {
              runtimeSessionId,
              resultId: persistedResult._id,
              ...(firstLink ? { linkedAt: new Date() } : {}),
              results: snapshot,
              attemptCount: payload.attempt,
              ...(completedAfterRevoke ? {} : { status: 'completed' }),
            },
            unset: { live: 1 },
          })
        })
      } catch (error) {
        if (!(error instanceof HireCandidatePiiTombstoneError)) throw error
        privacyWon = true
      }
    } finally {
      await dbSession.endSession()
    }
    if (privacyWon) {
      return await discardResultBehindPrivacyTombstone(
        payload,
        attempt._id.toString(),
        reservationToken,
        preparedMedia,
      )
    }
    return { outcome: 'processed' }
  } catch (error) {
    if (error instanceof HireRuntimeMediaStaleError) {
      try {
        return await completeResultAsStale(
          payload,
          reservationToken,
          preparedMedia,
        )
      } catch (completionError) {
        await releaseHireRoundIngestion({
          ...reservationScope,
          reservationToken,
        })
        throw completionError
      }
    }
    if (error instanceof HireCandidatePiiTombstoneError) {
      try {
        return await discardResultBehindPrivacyTombstone(
          payload,
          attempt._id.toString(),
          reservationToken,
          preparedMedia,
        )
      } catch (discardError) {
        await releaseHireRoundIngestion({
          ...reservationScope,
          reservationToken,
        })
        throw discardError
      }
    }
    await releaseHireRoundIngestion({
      ...reservationScope,
      reservationToken,
    })
    throw error
  }
}

export const __resultIngestion = { resultDigest, buildEvidenceProjection }
