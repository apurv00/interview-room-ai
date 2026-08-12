import { createHash } from 'node:crypto'
import mongoose from 'mongoose'
import {
  HireInterviewResult,
  type HireAssessmentProjection,
  type HireEvidenceRef,
  type HireNumericSummary,
  type IHireInterviewResult,
} from '../models/HireInterviewResult'
import { HireInterviewAttempt } from '../models/HireInterviewAttempt'
import { HireMediaAsset } from '../models/HireMediaAsset'
import { claimHireCandidatePiiWriteFence } from './hireCandidatePrivacyWriteFence'
import { connectHireControlDB } from './hireControlBoundary'

export class HireEvidenceError extends Error {
  constructor(
    message: string,
    readonly code:
      | 'EVIDENCE_INVALID'
      | 'ATTEMPT_NOT_FOUND'
      | 'RESULT_CONFLICT'
      | 'RESULT_NOT_FOUND',
    readonly status: number,
  ) {
    super(message)
    this.name = 'HireEvidenceError'
  }
}

interface ResultScope {
  workspaceId: string
  applicationId: string
  jobId: string
  candidateId: string
  roundId: string
  attemptId: string
}

export interface PersistHireInterviewResultInput extends ResultScope {
  adapterVersion: string
  engineContractVersion: string
  rawEngineOutput: unknown
  expectedRawDigest?: string
  projection: HireAssessmentProjection
  evidenceIndex: HireEvidenceRef[]
  completedAt: Date
  durationMs?: number
}

type JsonValue =
  null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue }

function assertJsonValue(
  value: unknown,
  path = '$',
): asserts value is JsonValue {
  if (
    value === null ||
    typeof value === 'boolean' ||
    typeof value === 'string' ||
    (typeof value === 'number' && Number.isFinite(value))
  ) {
    return
  }
  if (Array.isArray(value)) {
    value.forEach((entry, index) => assertJsonValue(entry, `${path}[${index}]`))
    return
  }
  if (
    typeof value === 'object' &&
    Object.getPrototypeOf(value) === Object.prototype
  ) {
    for (const [key, entry] of Object.entries(
      value as Record<string, unknown>,
    )) {
      assertJsonValue(entry, `${path}.${key}`)
    }
    return
  }
  throw new HireEvidenceError(
    `Engine output is not JSON-safe at ${path}`,
    'EVIDENCE_INVALID',
    400,
  )
}

export function canonicalHireResultJson(value: JsonValue): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value)
  if (Array.isArray(value)) {
    return `[${value.map((entry) => canonicalHireResultJson(entry)).join(',')}]`
  }
  return `{${Object.keys(value)
    .sort()
    .map(
      (key) => `${JSON.stringify(key)}:${canonicalHireResultJson(value[key])}`,
    )
    .join(',')}}`
}

function rawDigest(raw: unknown): string {
  assertJsonValue(raw)
  return createHash('sha256').update(canonicalHireResultJson(raw)).digest('hex')
}

function validOffset(value: number | undefined, upperBound?: number): boolean {
  return (
    value === undefined ||
    (Number.isInteger(value) &&
      value >= 0 &&
      (upperBound === undefined || value <= upperBound))
  )
}

function requireEvidenceIds(
  ids: string[],
  knownIds: Set<string>,
  label: string,
  required: boolean,
): void {
  if (required && ids.length === 0) {
    throw new HireEvidenceError(
      `${label} must cite evidence`,
      'EVIDENCE_INVALID',
      400,
    )
  }
  if (ids.some((id) => !knownIds.has(id))) {
    throw new HireEvidenceError(
      `${label} cites unknown evidence`,
      'EVIDENCE_INVALID',
      400,
    )
  }
}

async function validateEvidence(
  input: PersistHireInterviewResultInput,
): Promise<void> {
  if (input.evidenceIndex.length > 2_000) {
    throw new HireEvidenceError(
      'Evidence index is too large',
      'EVIDENCE_INVALID',
      400,
    )
  }
  const ids = new Set<string>()
  const mediaIds = new Set<string>()
  for (const evidence of input.evidenceIndex) {
    if (!evidence.id || evidence.id.length > 160 || ids.has(evidence.id)) {
      throw new HireEvidenceError(
        'Evidence ids must be unique and bounded',
        'EVIDENCE_INVALID',
        400,
      )
    }
    ids.add(evidence.id)
    if (evidence.attemptId !== input.attemptId) {
      throw new HireEvidenceError(
        'Evidence crossed the attempt boundary',
        'EVIDENCE_INVALID',
        400,
      )
    }
    if (
      !validOffset(evidence.startMs, input.durationMs) ||
      !validOffset(evidence.endMs, input.durationMs) ||
      (evidence.startMs !== undefined &&
        evidence.endMs !== undefined &&
        evidence.startMs > evidence.endMs)
    ) {
      throw new HireEvidenceError(
        'Evidence media offsets are invalid',
        'EVIDENCE_INVALID',
        400,
      )
    }
    if (
      !validOffset(evidence.transcriptStart) ||
      !validOffset(evidence.transcriptEnd) ||
      (evidence.transcriptStart !== undefined &&
        evidence.transcriptEnd !== undefined &&
        evidence.transcriptStart > evidence.transcriptEnd)
    ) {
      throw new HireEvidenceError(
        'Evidence transcript offsets are invalid',
        'EVIDENCE_INVALID',
        400,
      )
    }
    if (
      evidence.type === 'recording_range' &&
      (evidence.startMs === undefined ||
        evidence.endMs === undefined ||
        !evidence.mediaAssetId)
    ) {
      throw new HireEvidenceError(
        'Recording evidence requires a media asset and time range',
        'EVIDENCE_INVALID',
        400,
      )
    }
    if (
      evidence.type === 'transcript_span' &&
      (evidence.transcriptStart === undefined ||
        evidence.transcriptEnd === undefined ||
        !evidence.transcriptExcerpt ||
        evidence.transcriptExcerpt.length > 50_000)
    ) {
      throw new HireEvidenceError(
        'Transcript evidence requires an exact bounded excerpt and span',
        'EVIDENCE_INVALID',
        400,
      )
    }
    if (evidence.type === 'identity_photo' && !evidence.mediaAssetId) {
      throw new HireEvidenceError(
        'Identity evidence requires a media asset',
        'EVIDENCE_INVALID',
        400,
      )
    }
    if (evidence.mediaAssetId) {
      if (!mongoose.Types.ObjectId.isValid(evidence.mediaAssetId)) {
        throw new HireEvidenceError(
          'Evidence media id is invalid',
          'EVIDENCE_INVALID',
          400,
        )
      }
      mediaIds.add(evidence.mediaAssetId)
    }
  }

  requireEvidenceIds(
    input.projection.overallEvidenceIds,
    ids,
    'Overall assessment',
    input.projection.overallScore !== null,
  )
  for (const dimension of input.projection.dimensions) {
    requireEvidenceIds(
      dimension.evidenceIds,
      ids,
      `Dimension ${dimension.key}`,
      dimension.score !== null,
    )
  }
  for (const finding of input.projection.findings) {
    requireEvidenceIds(
      finding.evidenceIds,
      ids,
      `${finding.kind} finding`,
      true,
    )
  }
  for (const question of input.projection.questions) {
    requireEvidenceIds(
      question.evidenceIds,
      ids,
      `Question ${question.questionId}`,
      question.score !== null,
    )
    if (
      !validOffset(question.questionStartedMs, input.durationMs) ||
      !validOffset(question.answerStartedMs, input.durationMs) ||
      !validOffset(question.answerEndedMs, input.durationMs) ||
      (question.answerStartedMs !== undefined &&
        question.answerEndedMs !== undefined &&
        question.answerStartedMs > question.answerEndedMs)
    ) {
      throw new HireEvidenceError(
        'Question timeline offsets are invalid',
        'EVIDENCE_INVALID',
        400,
      )
    }
  }

  if (mediaIds.size > 0) {
    const found = await HireMediaAsset.distinct('_id', {
      _id: { $in: Array.from(mediaIds) },
      workspaceId: input.workspaceId,
      applicationId: input.applicationId,
      jobId: input.jobId,
      candidateId: input.candidateId,
      roundId: input.roundId,
      attemptId: input.attemptId,
      state: { $ne: 'purged' },
    })
    if (found.length !== mediaIds.size) {
      throw new HireEvidenceError(
        'Evidence references media outside this attempt',
        'EVIDENCE_INVALID',
        400,
      )
    }
  }
}

function numericSummary(
  projection: HireAssessmentProjection,
): HireNumericSummary {
  return {
    overallScore: projection.overallScore,
    dimensions: projection.dimensions.map((dimension) => ({
      key: dimension.key,
      score: dimension.score,
    })),
  }
}

export async function persistHireInterviewResult(
  input: PersistHireInterviewResultInput,
): Promise<IHireInterviewResult> {
  await connectHireControlDB()
  const digest = rawDigest(input.rawEngineOutput)
  if (input.expectedRawDigest && input.expectedRawDigest !== digest) {
    throw new HireEvidenceError(
      'Engine output digest does not match the received output',
      'RESULT_CONFLICT',
      409,
    )
  }
  await validateEvidence(input)

  const existing = await HireInterviewResult.findOne({
    workspaceId: input.workspaceId,
    applicationId: input.applicationId,
    roundId: input.roundId,
    attemptId: input.attemptId,
  })
  if (existing) {
    if (existing.rawDigest === digest) return existing
    throw new HireEvidenceError(
      'This attempt already has a different immutable result',
      'RESULT_CONFLICT',
      409,
    )
  }

  const attempt = await HireInterviewAttempt.findOne({
    _id: input.attemptId,
    workspaceId: input.workspaceId,
    applicationId: input.applicationId,
    jobId: input.jobId,
    candidateId: input.candidateId,
    roundId: input.roundId,
    status: { $in: ['in_progress', 'processing'] },
    live: true,
  }).lean()
  if (!attempt) {
    throw new HireEvidenceError(
      'Interview attempt not found',
      'ATTEMPT_NOT_FOUND',
      404,
    )
  }

  const resultId = new mongoose.Types.ObjectId()
  const dbSession = await mongoose.startSession()
  try {
    let result: IHireInterviewResult | undefined
    await dbSession.withTransaction(async () => {
      await claimHireCandidatePiiWriteFence({
        workspaceId: input.workspaceId,
        candidateId: input.candidateId,
        session: dbSession,
      })
      const created = await HireInterviewResult.create(
        [
          {
            _id: resultId,
            workspaceId: input.workspaceId,
            applicationId: input.applicationId,
            jobId: input.jobId,
            candidateId: input.candidateId,
            roundId: input.roundId,
            attemptId: input.attemptId,
            adapterVersion: input.adapterVersion,
            engineContractVersion: input.engineContractVersion,
            rawEngineOutput: input.rawEngineOutput,
            rawDigest: digest,
            numericSummary: numericSummary(input.projection),
            projection: input.projection,
            evidenceIndex: input.evidenceIndex,
            completedAt: input.completedAt,
          },
        ],
        { session: dbSession },
      )
      const completed = await HireInterviewAttempt.updateOne(
        {
          _id: input.attemptId,
          workspaceId: input.workspaceId,
          applicationId: input.applicationId,
          jobId: input.jobId,
          candidateId: input.candidateId,
          roundId: input.roundId,
          status: { $in: ['in_progress', 'processing'] },
          live: true,
        },
        {
          $set: {
            status: 'completed',
            resultId,
            completedAt: input.completedAt,
          },
          $unset: { live: 1 },
        },
        { session: dbSession },
      )
      if (completed.matchedCount !== 1) {
        throw new HireEvidenceError(
          'Interview attempt changed while attaching results',
          'RESULT_CONFLICT',
          409,
        )
      }
      result = created[0]
    })
    if (!result) {
      throw new HireEvidenceError(
        'Result was not persisted',
        'RESULT_CONFLICT',
        409,
      )
    }
    return result
  } finally {
    await dbSession.endSession()
  }
}

export async function getHireInterviewResult(input: {
  workspaceId: string
  applicationId: string
  roundId: string
  attemptId: string
}): Promise<IHireInterviewResult> {
  await connectHireControlDB()
  const result = await HireInterviewResult.findOne(input)
  if (!result) {
    throw new HireEvidenceError('Result not found', 'RESULT_NOT_FOUND', 404)
  }
  return result
}

export const __evidence = { rawDigest, validateEvidence }
