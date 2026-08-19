import { Readable } from 'node:stream'
import { GetObjectCommand, S3Client } from '@aws-sdk/client-s3'
import mongoose from 'mongoose'
import { z } from 'zod'
import {
  HIRE_MULTIMODAL_ANALYSIS_MAX_ARTIFACT_BYTES,
  HIRE_MULTIMODAL_ANALYSIS_MAX_DURATION_MS,
  HIRE_MULTIMODAL_ANALYSIS_MAX_FRAMES,
  HireMultimodalAnalysisFacialFrameSchema,
  type HireMultimodalAnalysisIngestion,
} from '@shared/contracts/hireMultimodalAnalysisBridge'
import { aggregateFacialData, extractProsody } from '@interview'
import type { FacialFrame, WhisperSegment, WhisperWord } from '@shared/types/multimodal'
import {
  assertHireMediaKeyScope,
  connectHireControlDB,
  HireMediaAsset,
  HirePrivacyRequest,
  HireRound,
} from '@hire'
import { HireMultimodalAnalysis } from '../models'
import { runHireMultimodalFusion, type HireMultimodalContentSignal } from './hireMultimodalFusionService'

const PROCESSING_LEASE_MS = 10 * 60 * 1_000
const MAX_LANDMARK_BYTES = HIRE_MULTIMODAL_ANALYSIS_MAX_ARTIFACT_BYTES
const MAX_AUTOMATIC_RETRY_ATTEMPTS = 3
const RETRY_BASE_MS = 5 * 60 * 1_000

const StoredLandmarkArtifactSchema = z.object({
  schemaVersion: z.literal(1),
  frames: z.array(HireMultimodalAnalysisFacialFrameSchema).max(HIRE_MULTIMODAL_ANALYSIS_MAX_FRAMES),
}).strict()

interface AnalysisDocumentShape {
  _id: mongoose.Types.ObjectId
  workspaceId: mongoose.Types.ObjectId
  applicationId: mongoose.Types.ObjectId
  candidateId: mongoose.Types.ObjectId
  roundId: mongoose.Types.ObjectId
  attemptId: mongoose.Types.ObjectId
  landmarksAssetId: mongoose.Types.ObjectId
  durationMs: number
  inputTranscript: HireMultimodalAnalysisIngestion['transcript']
  liveTranscriptWords: HireMultimodalAnalysisIngestion['liveTranscriptWords']
  status: 'pending' | 'processing' | 'completed' | 'failed' | 'stale'
  retryAttemptCount?: number
  retryAt?: Date
}

interface RoundResultShape {
  results?: {
    perQuestion?: Array<{
      questionIndex?: number
      question?: string
      score?: number | null
      relevance?: number | null
      structure?: number | null
      specificity?: number | null
      ownership?: number | null
      jdAlignment?: number | null
      flags?: string[]
    }>
  }
}

function controlR2Client(): { client: S3Client; bucket: string } {
  const accountId = process.env.R2_ACCOUNT_ID
  const accessKeyId = process.env.R2_ACCESS_KEY_ID
  const secretAccessKey = process.env.R2_SECRET_ACCESS_KEY
  const bucket = process.env.R2_BUCKET_NAME
  if (!accountId || !accessKeyId || !secretAccessKey || !bucket) {
    throw new Error('Hire analysis storage is not configured')
  }
  return {
    bucket,
    client: new S3Client({
      region: 'auto',
      endpoint: `https://${accountId}.r2.cloudflarestorage.com`,
      credentials: { accessKeyId, secretAccessKey },
    }),
  }
}

async function readBody(body: unknown): Promise<Buffer> {
  if (
    body &&
    typeof body === 'object' &&
    'transformToByteArray' in body &&
    typeof (body as { transformToByteArray?: unknown }).transformToByteArray === 'function'
  ) {
    return Buffer.from(await (body as { transformToByteArray: () => Promise<Uint8Array> }).transformToByteArray())
  }
  if (body && typeof body === 'object' && Symbol.asyncIterator in body) {
    const chunks: Buffer[] = []
    let total = 0
    for await (const chunk of Readable.from(body as AsyncIterable<Uint8Array>)) {
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
      total += buffer.byteLength
      if (total > MAX_LANDMARK_BYTES) throw new Error('Landmark artifact exceeds maximum size')
      chunks.push(buffer)
    }
    return Buffer.concat(chunks)
  }
  throw new Error('Landmark artifact has no readable body')
}

async function loadFrames(analysis: AnalysisDocumentShape): Promise<FacialFrame[]> {
  const asset = await HireMediaAsset.findOne({
    _id: analysis.landmarksAssetId,
    workspaceId: analysis.workspaceId,
    applicationId: analysis.applicationId,
    roundId: analysis.roundId,
    attemptId: analysis.attemptId,
    kind: 'facial_landmarks',
    state: 'ready',
  }).lean()
  if (!asset || asset.bytes > MAX_LANDMARK_BYTES || asset.contentType !== 'application/json') {
    throw new Error('Private facial landmark artifact is unavailable')
  }
  assertHireMediaKeyScope(asset.objectKey, {
    workspaceId: asset.workspaceId.toString(),
    applicationId: asset.applicationId.toString(),
    roundId: asset.roundId.toString(),
    attemptId: asset.attemptId.toString(),
    assetId: asset._id.toString(),
  })
  const storage = controlR2Client()
  const object = await storage.client.send(
    new GetObjectCommand({ Bucket: storage.bucket, Key: asset.objectKey }),
  )
  if (object.ContentLength !== undefined && object.ContentLength > MAX_LANDMARK_BYTES) {
    throw new Error('Landmark artifact exceeds maximum size')
  }
  const buffer = await readBody(object.Body)
  if (buffer.byteLength > MAX_LANDMARK_BYTES) {
    throw new Error('Landmark artifact exceeds maximum size')
  }
  const parsed = StoredLandmarkArtifactSchema.parse(JSON.parse(buffer.toString('utf8')))
  return parsed.frames as FacialFrame[]
}

function questionWindows(transcript: HireMultimodalAnalysisIngestion['transcript']): {
  boundaries: number[]
  questionIndexes: number[]
} {
  const seen = new Set<number>()
  const rows = transcript
    .filter((entry) => entry.speaker === 'interviewer')
    .map((entry, index) => ({
      timestampMs: entry.timestampMs,
      questionIndex: entry.questionIndex ?? index,
    }))
    .sort((left, right) => left.timestampMs - right.timestampMs)
    .filter((row) => {
      if (seen.has(row.timestampMs)) return false
      seen.add(row.timestampMs)
      return true
    })
  if (!rows.length) return { boundaries: [0], questionIndexes: [0] }
  return {
    boundaries: rows.map((row) => row.timestampMs / 1_000),
    questionIndexes: rows.map((row) => row.questionIndex),
  }
}

function liveWords(input: {
  words: HireMultimodalAnalysisIngestion['liveTranscriptWords']
  transcript: HireMultimodalAnalysisIngestion['transcript']
  durationMs: number
}): WhisperWord[] {
  if (input.words.length) {
    return input.words.map((word) => ({
      word: word.word,
      start: word.startMs / 1_000,
      end: word.endMs / 1_000,
      confidence: word.confidence,
    }))
  }
  const candidates = input.transcript
    .filter((entry) => entry.speaker === 'candidate' && entry.text.trim())
    .sort((left, right) => left.timestampMs - right.timestampMs)
  const words: WhisperWord[] = []
  for (let entryIndex = 0; entryIndex < candidates.length && words.length < 25_000; entryIndex++) {
    const entry = candidates[entryIndex]
    const tokens = entry.text.trim().split(/\s+/).filter(Boolean).slice(0, 2_000)
    if (!tokens.length) continue
    const next = candidates[entryIndex + 1]
    const startMs = entry.timestampMs
    const endMs = Math.max(startMs + 1_000, Math.min(input.durationMs, next?.timestampMs ?? input.durationMs))
    const slotMs = Math.max(1, (endMs - startMs) / tokens.length)
    for (let tokenIndex = 0; tokenIndex < tokens.length && words.length < 25_000; tokenIndex++) {
      const wordStart = Math.min(endMs, startMs + tokenIndex * slotMs)
      const wordEnd = Math.min(endMs, Math.max(wordStart, startMs + (tokenIndex + 1) * slotMs))
      words.push({ word: tokens[tokenIndex], start: wordStart / 1_000, end: wordEnd / 1_000, confidence: 0.5 })
    }
  }
  return words
}

function whisperSegments(words: WhisperWord[]): WhisperSegment[] {
  if (!words.length) return []
  return [{
    id: 0,
    start: words[0].start,
    end: words[words.length - 1].end,
    text: words.map((word) => word.word).join(' '),
    words,
  }]
}

function contentSignals(round: RoundResultShape | null): HireMultimodalContentSignal[] {
  return (round?.results?.perQuestion ?? []).flatMap((question, index) => {
    if (typeof question.questionIndex !== 'number') return []
    return [{
      questionIndex: question.questionIndex,
      question: typeof question.question === 'string' ? question.question.slice(0, 5_000) : `Question ${index + 1}`,
      score: typeof question.score === 'number' ? question.score : null,
      relevance: typeof question.relevance === 'number' ? question.relevance : null,
      structure: typeof question.structure === 'number' ? question.structure : null,
      specificity: typeof question.specificity === 'number' ? question.specificity : null,
      ownership: typeof question.ownership === 'number' ? question.ownership : null,
      jdAlignment: typeof question.jdAlignment === 'number' ? question.jdAlignment : null,
      flags: Array.isArray(question.flags) ? question.flags.slice(0, 40) : [],
    }]
  })
}

function retryableFailedAnalysisClause(now: Date) {
  return {
    status: 'failed' as const,
    retryAt: { $lte: now },
    $or: [
      { retryAttemptCount: { $lt: MAX_AUTOMATIC_RETRY_ATTEMPTS } },
      { retryAttemptCount: { $exists: false } },
    ],
  }
}

function dueAnalysisClaimClauses(now: Date) {
  return [
    { status: 'pending' as const },
    // A recovery worker may claim at the exact lease expiry. Waiting a
    // second lease period here leaves a stranded report unavailable for
    // another ten minutes after a worker crash.
    { status: 'processing' as const, processingLeaseExpiresAt: { $lte: now } },
    retryableFailedAnalysisClause(now),
  ]
}

async function canProcessAnalysis(analysis: AnalysisDocumentShape): Promise<boolean> {
  const [current, privacy] = await Promise.all([
    HireMultimodalAnalysis.exists({
      _id: analysis._id,
      workspaceId: analysis.workspaceId,
      applicationId: analysis.applicationId,
      candidateId: analysis.candidateId,
      status: 'processing',
    }),
    HirePrivacyRequest.exists({
      workspaceId: analysis.workspaceId,
      candidateId: analysis.candidateId,
      live: true,
    }),
  ])
  return Boolean(current) && !privacy
}

async function claimAnalysis(input: {
  workspaceId: string
  analysisId: string
  now: Date
}): Promise<AnalysisDocumentShape | null> {
  return HireMultimodalAnalysis.findOneAndUpdate(
    {
      _id: input.analysisId,
      workspaceId: input.workspaceId,
      $or: dueAnalysisClaimClauses(input.now),
    },
    {
      $set: {
        status: 'processing',
        processingLeaseExpiresAt: new Date(input.now.getTime() + PROCESSING_LEASE_MS),
      },
      $unset: { errorCode: 1, completedAt: 1, retryAt: 1 },
    },
    { new: true },
  ).lean() as Promise<AnalysisDocumentShape | null>
}

export type HireMultimodalAnalysisProcessingOutcome =
  | 'completed'
  | 'already_completed'
  | 'not_ready'
  | 'stale'

/**
 * Process a control-owned raw landmark artifact into a recruiter report.
 * This is intentionally isolated from B2C's `MultimodalAnalysis` model and
 * from Hire's JD score/result writer.
 */
export async function processHireMultimodalAnalysis(input: {
  workspaceId: string
  analysisId: string
  now?: Date
}): Promise<HireMultimodalAnalysisProcessingOutcome> {
  await connectHireControlDB()
  const now = input.now ?? new Date()
  const analysis = await claimAnalysis({ ...input, now })
  if (!analysis) {
    const current = await HireMultimodalAnalysis.findOne({
      _id: input.analysisId,
      workspaceId: input.workspaceId,
    }).select('status').lean()
    return current?.status === 'completed' ? 'already_completed' : current ? 'not_ready' : 'stale'
  }
  if (!await canProcessAnalysis(analysis)) {
    await HireMultimodalAnalysis.updateOne(
      { _id: analysis._id, workspaceId: analysis.workspaceId, status: 'processing' },
      { $set: { status: 'stale' }, $unset: { processingLeaseExpiresAt: 1 } },
    )
    return 'stale'
  }

  const frames = await loadFrames(analysis)
  const windows = questionWindows(analysis.inputTranscript)
  const durationMs = Math.min(
    HIRE_MULTIMODAL_ANALYSIS_MAX_DURATION_MS,
    Math.max(1, analysis.durationMs),
  )
  const durationSec = durationMs / 1_000
  const rawFacialSegments = aggregateFacialData(
    frames,
    windows.boundaries,
    durationSec,
    { includeBlendshapeStats: true },
  )
  const facialSegments = rawFacialSegments.map((segment) => ({
    ...segment,
    ...(segment.questionIndex === undefined
      ? {}
      : { questionIndex: windows.questionIndexes[segment.questionIndex] ?? segment.questionIndex }),
  }))
  const facialTimeseries = aggregateFacialData(
    frames,
    [],
    durationSec,
    { windowSec: 1, includeBlendshapeStats: true },
  )
  const words = liveWords({
    words: analysis.liveTranscriptWords,
    transcript: analysis.inputTranscript,
    durationMs,
  })
  const rawProsodySegments = extractProsody(
    whisperSegments(words),
    windows.boundaries,
    durationSec,
  )
  const prosodySegments = rawProsodySegments.map((segment) => ({
    ...segment,
    ...(segment.questionIndex === undefined
      ? {}
      : { questionIndex: windows.questionIndexes[segment.questionIndex] ?? segment.questionIndex }),
  }))
  const round = await HireRound.findOne({
    _id: analysis.roundId,
    workspaceId: analysis.workspaceId,
    applicationId: analysis.applicationId,
  }).select('results.perQuestion').lean() as RoundResultShape | null
  const fusion = await runHireMultimodalFusion({
    durationMs,
    prosodySegments,
    facialSegments,
    contentSignals: contentSignals(round),
    beforeProviderCall: () => canProcessAnalysis(analysis),
  })
  // The provider boundary rechecks before egress, but a deletion request can
  // begin while a deterministic fallback/report is being assembled. Recheck
  // immediately before persistence so it cannot recreate control data after
  // the candidate privacy fence becomes live.
  if (!await canProcessAnalysis(analysis)) {
    await HireMultimodalAnalysis.updateOne(
      { _id: analysis._id, workspaceId: analysis.workspaceId, status: 'processing' },
      { $set: { status: 'stale' }, $unset: { processingLeaseExpiresAt: 1 } },
    )
    return 'stale'
  }

  const written = await HireMultimodalAnalysis.updateOne(
    {
      _id: analysis._id,
      workspaceId: analysis.workspaceId,
      applicationId: analysis.applicationId,
      candidateId: analysis.candidateId,
      status: 'processing',
    },
    {
      $set: {
        status: 'completed',
        facialFrameCount: frames.length,
        prosodySegments,
        facialSegments,
        facialTimeseries,
        timeline: fusion.timeline,
        summary: fusion.summary,
        ...(fusion.model ? { modelName: fusion.model } : {}),
        ...(fusion.inputTokens === undefined ? {} : { inputTokens: fusion.inputTokens }),
        ...(fusion.outputTokens === undefined ? {} : { outputTokens: fusion.outputTokens }),
        completedAt: now,
      },
      $unset: { processingLeaseExpiresAt: 1, errorCode: 1 },
    },
  )
  return written.matchedCount === 1 ? 'completed' : 'stale'
}

export async function markHireMultimodalAnalysisFailed(input: {
  workspaceId: string
  analysisId: string
  errorCode?: string
  now?: Date
}): Promise<void> {
  await connectHireControlDB()
  const now = input.now ?? new Date()
  const failureState = {
    status: 'failed' as const,
    errorCode: (input.errorCode ?? 'HIRE_MULTIMODAL_ANALYSIS_FAILED').slice(0, 160),
  }
  const retryable = await HireMultimodalAnalysis.updateOne(
    {
      _id: input.analysisId,
      workspaceId: input.workspaceId,
      status: { $in: ['pending', 'processing'] },
      $or: [
        { retryAttemptCount: { $lt: MAX_AUTOMATIC_RETRY_ATTEMPTS } },
        { retryAttemptCount: { $exists: false } },
      ],
    },
    {
      $set: {
        ...failureState,
        retryAt: new Date(now.getTime() + RETRY_BASE_MS),
      },
      $inc: { retryAttemptCount: 1 },
      $unset: { processingLeaseExpiresAt: 1 },
    },
  )
  if (retryable.matchedCount === 1) return

  // Keep a permanently exhausted item visibly failed instead of leaving it
  // `processing` forever, which would make the recruiter-facing status lie.
  await HireMultimodalAnalysis.updateOne(
    {
      _id: input.analysisId,
      workspaceId: input.workspaceId,
      status: { $in: ['pending', 'processing'] },
    },
    {
      $set: failureState,
      $unset: { processingLeaseExpiresAt: 1, retryAt: 1 },
    },
  )
}

export async function recoverPendingHireMultimodalAnalyses(input: {
  workspaceId: string
  batchSize: number
}): Promise<{ scanned: number; completed: number; failed: number }> {
  await connectHireControlDB()
  const now = new Date()
  const rows = await HireMultimodalAnalysis.find({
    workspaceId: input.workspaceId,
    $or: dueAnalysisClaimClauses(now),
  })
    .sort({ createdAt: 1, _id: 1 })
    .limit(Math.min(Math.max(input.batchSize, 1), 100))
    .select('_id')
    .lean()
  let completed = 0
  let failed = 0
  for (const row of rows) {
    try {
      const outcome = await processHireMultimodalAnalysis({
        workspaceId: input.workspaceId,
        analysisId: row._id.toString(),
        now,
      })
      if (outcome === 'completed') completed++
    } catch (error) {
      failed++
      await markHireMultimodalAnalysisFailed({
        workspaceId: input.workspaceId,
        analysisId: row._id.toString(),
        errorCode: error instanceof Error ? error.name : undefined,
        now,
      })
    }
  }
  return { scanned: rows.length, completed, failed }
}

export const __hireMultimodalAnalysisProcessing = {
  questionWindows,
  liveWords,
  contentSignals,
  retryableFailedAnalysisClause,
  dueAnalysisClaimClauses,
  PROCESSING_LEASE_MS,
  MAX_AUTOMATIC_RETRY_ATTEMPTS,
  RETRY_BASE_MS,
}
