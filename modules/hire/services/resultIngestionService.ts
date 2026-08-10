import { createHash } from 'node:crypto'
import mongoose, { type ClientSession } from 'mongoose'
import {
  canonicalBridgeJson,
  HireEngineResultIngestionSchema,
  type HireEngineResultIngestion,
} from '@shared/contracts/hireEngineBridge'
import type {
  HireAssessmentProjection,
  HireEvidenceRef,
} from '../models/HireInterviewResult'
import { HireApplication } from '../models/HireApplication'
import { HireRound } from '../models/HireRound'
import { HireInterviewAttempt } from '../models/HireInterviewAttempt'
import { HireEngineIngestionEvent } from '../models/HireEngineIngestionEvent'
import { HirePrivacyRequest } from '../models/HirePrivacyRequest'
import { connectHireControlDB } from './hireControlBoundary'
import {
  claimHireCandidatePiiWriteFence,
  HireCandidatePiiTombstoneError,
} from './hireCandidatePrivacyWriteFence'
import { persistHireInterviewResult } from './evidenceService'
import { ingestRuntimeMediaArtifacts } from './runtimeMediaIngestionService'

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

function resultDigest(
  payload: Pick<
    HireEngineResultIngestion,
    | 'results'
    | 'startedAt'
    | 'completedAt'
    | 'durationMs'
    | 'transcript'
    | 'media'
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
      }),
    )
    .digest('hex')
}

function evidenceForQuestions(payload: HireEngineResultIngestion): {
  evidenceIndex: HireEvidenceRef[]
  questions: HireAssessmentProjection['questions']
} {
  const evidenceIndex: HireEvidenceRef[] = []
  const questions = (payload.results.perQuestion ?? []).map((question) => {
    const matchingIndexes = payload.transcript.flatMap((entry, index) =>
      entry.questionIndex === question.questionIndex ? [index] : [],
    )
    const interviewerIndex =
      matchingIndexes.find(
        (index) => payload.transcript[index].speaker === 'interviewer',
      ) ?? -1
    const candidateIndexes = matchingIndexes.filter(
      (index) => payload.transcript[index].speaker === 'candidate',
    )
    const candidateIndex = candidateIndexes[0] ?? -1
    const candidateEndIndex =
      candidateIndexes[candidateIndexes.length - 1] ?? -1
    const evidenceIds: string[] = []
    if (candidateIndex >= 0) {
      const answerEntry = payload.transcript[candidateIndex]
      const nextEntry = payload.transcript[candidateEndIndex + 1]
      const id = `q-${question.questionIndex}-answer`
      const transcriptStart =
        interviewerIndex >= 0 ? interviewerIndex : candidateIndex
      const transcriptExcerpt = payload.transcript
        .slice(transcriptStart, candidateEndIndex + 1)
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
        questionId: `q-${question.questionIndex}`,
        transcriptStart,
        transcriptEnd: candidateEndIndex,
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
      questionId: `q-${question.questionIndex}`,
      index: question.questionIndex,
      prompt: question.question,
      ...(candidateIndexes.length > 0
        ? {
            answer: candidateIndexes
              .map((index) => payload.transcript[index].text)
              .join('\n')
              .slice(0, 20_000),
          }
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
  const resultByQuestion = new Map(
    (payload.results.perQuestion ?? []).map((question) => [
      question.questionIndex,
      question,
    ]),
  )
  const evidenceForDimension = (
    predicate: (
      question: NonNullable<
        HireEngineResultIngestion['results']['perQuestion']
      >[number],
    ) => boolean,
  ) =>
    uniqueEvidenceIds(
      built.questions
        .filter((question) => {
          const result = resultByQuestion.get(question.index)
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
          built.questions.find((question) => question.index === index)
            ?.evidenceIds ?? [],
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
  for (const question of payload.results.perQuestion ?? []) {
    const ids =
      built.questions.find(
        (candidate) => candidate.index === question.questionIndex,
      )?.evidenceIds ?? []
    for (const flag of question.flags ?? []) addGap(flag, ids)
  }
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
  if (hasDisplayedScore && scoredEvidenceIds.length === 0) {
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
): Promise<HireEngineIngestionOutcome | null> {
  const eventScope = {
    eventId: payload.eventId,
    workspaceId: payload.workspaceId,
    applicationId: payload.applicationId,
    roundId: payload.roundId,
  }
  const exact = await HireEngineIngestionEvent.findOne(eventScope)
    .session(dbSession)
    .lean()
  if (exact) {
    if (
      exact.resultDigest !== payload.resultDigest ||
      exact.roundId.toString() !== payload.roundId ||
      exact.runtimeSessionId.toString() !== payload.runtimeSessionId
    ) {
      throw new HireEngineIngestionError(
        'An ingestion event id was reused with different content',
        'conflict',
        409,
      )
    }
    return exact.status === 'processed' ? 'duplicate' : null
  }

  const latest = await HireEngineIngestionEvent.findOne({
    workspaceId: payload.workspaceId,
    applicationId: payload.applicationId,
    roundId: payload.roundId,
    status: 'processed',
  })
    .sort({ revision: -1 })
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
  if (latest.revision > payload.revision) return 'stale'
  if (latest.revision === payload.revision) {
    if (latest.resultDigest === payload.resultDigest) return 'duplicate'
    throw new HireEngineIngestionError(
      'The same result revision has different content',
      'conflict',
      409,
    )
  }
  return null
}

async function discardResultBehindPrivacyTombstone(
  payload: HireEngineResultIngestion,
  attemptId: string,
): Promise<{ outcome: HireEngineIngestionOutcome }> {
  const dbSession = await mongoose.startSession()
  try {
    let outcome: HireEngineIngestionOutcome = 'processed'
    await dbSession.withTransaction(async () => {
      const prior = await existingOutcome(payload, dbSession)
      if (prior) {
        outcome = prior
        return
      }
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
            // Content and source media are deliberately not retained after a
            // verified deletion request. The digest alone proves idempotency.
            media: [],
            status: 'received',
          },
        ],
        { session: dbSession },
      )
      const runtimeSessionId = new mongoose.Types.ObjectId(
        payload.runtimeSessionId,
      )
      const linked = await HireRound.updateOne(
        {
          _id: payload.roundId,
          workspaceId: payload.workspaceId,
          applicationId: payload.applicationId,
          $or: [{ runtimeSessionId: { $exists: false } }, { runtimeSessionId }],
        },
        { $set: { runtimeSessionId }, $unset: { live: 1 } },
        { session: dbSession },
      )
      if (linked.matchedCount !== 1) {
        throw new HireEngineIngestionError(
          'Round changed while a deleted result was acknowledged',
          'conflict',
          409,
        )
      }
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
      await HireEngineIngestionEvent.updateOne(
        {
          eventId: payload.eventId,
          workspaceId: payload.workspaceId,
          applicationId: payload.applicationId,
          roundId: payload.roundId,
          status: 'received',
        },
        { $set: { status: 'processed', processedAt: new Date() } },
        { session: dbSession },
      )
    })
    return { outcome }
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
  if (privacyTombstone) {
    return discardResultBehindPrivacyTombstone(payload, attempt._id.toString())
  }
  let persistedResult: Awaited<ReturnType<typeof persistHireInterviewResult>>
  try {
    const mediaAssets = await ingestRuntimeMediaArtifacts({
      workspaceId: payload.workspaceId,
      applicationId: payload.applicationId,
      jobId: application.jobId.toString(),
      candidateId: application.candidateId.toString(),
      roundId: payload.roundId,
      attemptId: attempt._id.toString(),
      runtimeSessionId: payload.runtimeSessionId,
      completedAt: new Date(payload.completedAt),
      artifacts: payload.media,
    })
    const cameraAsset = mediaAssets.find(
      (asset) => asset.kind === 'camera_recording',
    )
    const evidence = buildEvidenceProjection(
      payload,
      attempt._id.toString(),
      cameraAsset?._id.toString(),
    )
    persistedResult = await persistHireInterviewResult({
      workspaceId: payload.workspaceId,
      applicationId: payload.applicationId,
      jobId: application.jobId.toString(),
      candidateId: application.candidateId.toString(),
      roundId: payload.roundId,
      attemptId: attempt._id.toString(),
      adapterVersion: 'hire-runtime-bridge-v1',
      engineContractVersion: `interview-engine:${payload.schemaVersion}`,
      rawEngineOutput: {
        results: payload.results,
        startedAt: payload.startedAt,
        completedAt: payload.completedAt,
        durationMs: payload.durationMs,
        transcript: payload.transcript,
      },
      projection: evidence.projection,
      evidenceIndex: evidence.evidenceIndex,
      completedAt: new Date(payload.completedAt),
      durationMs: payload.durationMs,
    })
  } catch (error) {
    if (error instanceof HireCandidatePiiTombstoneError) {
      return discardResultBehindPrivacyTombstone(
        payload,
        attempt._id.toString(),
      )
    }
    throw error
  }

  const dbSession = await mongoose.startSession()
  let privacyWon = false
  let outcome: HireEngineIngestionOutcome = 'processed'
  try {
    try {
      await dbSession.withTransaction(async () => {
        const prior = await existingOutcome(payload, dbSession)
        if (prior) {
          outcome = prior
          return
        }
        await claimHireCandidatePiiWriteFence({
          workspaceId: payload.workspaceId,
          candidateId: application.candidateId,
          session: dbSession,
        })
        const firstLink = !round.runtimeSessionId
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
              media: payload.media,
              status: 'received',
            },
          ],
          { session: dbSession },
        )

        const completedAfterRevoke = Boolean(round.revokedAt)
        const snapshot = {
          ...payload.results,
          sessionCompletedAt: new Date(payload.completedAt),
          ...(completedAfterRevoke ? { completedAfterRevoke: true } : {}),
        }
        const runtimeSessionId = new mongoose.Types.ObjectId(
          payload.runtimeSessionId,
        )
        const updated = await HireRound.updateOne(
          {
            _id: payload.roundId,
            workspaceId: payload.workspaceId,
            applicationId: payload.applicationId,
            $or: [
              { runtimeSessionId: { $exists: false } },
              { runtimeSessionId },
            ],
          },
          {
            $set: {
              runtimeSessionId,
              resultId: persistedResult._id,
              ...(firstLink ? { linkedAt: new Date() } : {}),
              results: snapshot,
              attemptCount: payload.attempt,
              ...(completedAfterRevoke ? {} : { status: 'completed' }),
            },
            $unset: { live: 1 },
          },
          { session: dbSession },
        )
        if (updated.matchedCount !== 1) {
          throw new HireEngineIngestionError(
            'Round changed while results were being ingested',
            'conflict',
            409,
          )
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
        await HireEngineIngestionEvent.updateOne(
          {
            eventId: payload.eventId,
            workspaceId: payload.workspaceId,
            applicationId: payload.applicationId,
            roundId: payload.roundId,
            status: 'received',
          },
          { $set: { status: 'processed', processedAt: new Date() } },
          { session: dbSession },
        )
      })
    } catch (error) {
      if (!(error instanceof HireCandidatePiiTombstoneError)) throw error
      privacyWon = true
    }
  } finally {
    await dbSession.endSession()
  }
  if (privacyWon) {
    return discardResultBehindPrivacyTombstone(payload, attempt._id.toString())
  }
  return { outcome }
}

export const __resultIngestion = { resultDigest, buildEvidenceProjection }
