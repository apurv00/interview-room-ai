import { connectDB } from '@shared/db/connection'
import { InterviewSession } from '@shared/db/models/InterviewSession'
import { MultimodalAnalysis } from '@shared/db/models/MultimodalAnalysis'
import { getDownloadPresignedUrl } from '@shared/storage/r2'
import { trackUsage } from '@shared/services/usageTracking'
import { aiLogger } from '@shared/logger'
import { transcribeRecording } from './whisperService'
import { extractProsody } from './prosodyService'
import { aggregateFacialData } from './facialAggregator'
import { runFusionAnalysis } from './fusionService'
import type { FacialFrame } from '@shared/types/multimodal'
import type { AuthUser } from '@shared/middleware/withAuth'

// ─── Step result types (serializable for Inngest step boundaries) ───────────

export interface SessionData {
  sessionId: string
  recordingR2Key: string
  facialLandmarksR2Key?: string
  transcript: Array<{ speaker: string; text: string; timestamp: number; questionIndex?: number | null }>
  evaluations: Array<Record<string, unknown>>
  config: Record<string, unknown>
  questionBoundaries: number[]
}

export interface TranscribeResult {
  segments: Array<Record<string, unknown>>
  durationSeconds: number
  costUsd: number
}

export interface ProcessedSignals {
  prosodySegments: Array<Record<string, unknown>>
  facialSegments: Array<Record<string, unknown>>
}

// ─── Pipeline steps (each can be called independently by Inngest) ───────────

/** Step 1: Fetch session data and validate */
export async function stepFetchSession(sessionId: string): Promise<SessionData> {
  await connectDB()

  await MultimodalAnalysis.findOneAndUpdate(
    { sessionId },
    { status: 'processing' }
  )

  const session = await InterviewSession.findById(sessionId)
  if (!session) throw new Error(`Session ${sessionId} not found`)
  if (!session.recordingR2Key) throw new Error('Session has no recording')

  const questionBoundaries = (session.transcript || [])
    .filter((t) => t.speaker === 'interviewer')
    .map((t) => t.timestamp)

  return {
    sessionId,
    recordingR2Key: session.recordingR2Key,
    facialLandmarksR2Key: session.facialLandmarksR2Key,
    transcript: session.transcript || [],
    evaluations: session.evaluations as unknown as Array<Record<string, unknown>>,
    config: session.config as unknown as Record<string, unknown>,
    questionBoundaries,
  }
}

/** Step 2: Transcribe recording + download facial data (parallel) */
export async function stepTranscribeAndDownload(
  recordingR2Key: string,
  facialLandmarksR2Key?: string
): Promise<{ whisper: TranscribeResult; facialFrames: FacialFrame[] }> {
  const [whisperResult, facialFrames] = await Promise.all([
    transcribeRecording(recordingR2Key),
    downloadFacialFrames(facialLandmarksR2Key),
  ])

  return {
    whisper: {
      segments: whisperResult.segments as unknown as Array<Record<string, unknown>>,
      durationSeconds: whisperResult.durationSeconds,
      costUsd: whisperResult.costUsd,
    },
    facialFrames: facialFrames as unknown as FacialFrame[],
  }
}

/** Step 3: Extract prosody + aggregate facial signals */
export function stepProcessSignals(
  whisperSegments: Array<Record<string, unknown>>,
  facialFrames: FacialFrame[],
  questionBoundaries: number[],
  totalDurationSec: number
): ProcessedSignals {
  const prosodySegments = extractProsody(
    whisperSegments as unknown as Parameters<typeof extractProsody>[0],
    questionBoundaries,
    totalDurationSec
  )

  const facialSegments = aggregateFacialData(
    facialFrames,
    questionBoundaries,
    totalDurationSec
  )

  return {
    prosodySegments: prosodySegments as unknown as Array<Record<string, unknown>>,
    facialSegments: facialSegments as unknown as Array<Record<string, unknown>>,
  }
}

/** Step 4: Run Claude fusion analysis */
export async function stepRunFusion(
  prosodySegments: Array<Record<string, unknown>>,
  facialSegments: Array<Record<string, unknown>>,
  evaluations: Array<Record<string, unknown>>,
  transcript: Array<Record<string, unknown>>,
  config: Record<string, unknown>
) {
  return await runFusionAnalysis({
    prosodySegments: prosodySegments as unknown as Parameters<typeof runFusionAnalysis>[0]['prosodySegments'],
    facialSegments: facialSegments as unknown as Parameters<typeof runFusionAnalysis>[0]['facialSegments'],
    evaluations: evaluations as unknown as Parameters<typeof runFusionAnalysis>[0]['evaluations'],
    transcript: transcript as unknown as Parameters<typeof runFusionAnalysis>[0]['transcript'],
    config: config as unknown as Parameters<typeof runFusionAnalysis>[0]['config'],
  })
}

/** Step 5: Persist results and track usage */
export async function stepPersistResults(
  sessionId: string,
  userId: string,
  data: {
    whisperSegments: Array<Record<string, unknown>>
    prosodySegments: Array<Record<string, unknown>>
    facialSegments: Array<Record<string, unknown>>
    timeline: Array<Record<string, unknown>>
    fusionSummary: Record<string, unknown>
    facialLandmarksR2Key?: string
    whisperCostUsd: number
    fusionInputTokens: number
    fusionOutputTokens: number
    startTime: number
  }
): Promise<void> {
  await connectDB()

  const claudeCostUsd = parseFloat(
    ((data.fusionInputTokens / 1000) * 0.001 + (data.fusionOutputTokens / 1000) * 0.005).toFixed(4)
  )
  const totalCostUsd = parseFloat((data.whisperCostUsd + claudeCostUsd).toFixed(4))
  const processingDurationMs = Date.now() - data.startTime

  await MultimodalAnalysis.findOneAndUpdate(
    { sessionId },
    {
      status: 'completed',
      whisperTranscript: data.whisperSegments,
      prosodySegments: data.prosodySegments,
      facialSegments: data.facialSegments,
      timeline: data.timeline,
      fusionSummary: data.fusionSummary,
      facialFramesR2Key: data.facialLandmarksR2Key || undefined,
      whisperCostUsd: data.whisperCostUsd,
      claudeCostUsd,
      totalCostUsd,
      processingDurationMs,
      completedAt: new Date(),
    }
  )

  const mockUser: AuthUser = { id: userId, email: '', role: 'candidate', plan: 'free' }
  await trackUsage({
    user: mockUser,
    type: 'api_call_whisper',
    sessionId,
    inputTokens: 0,
    outputTokens: 0,
    modelUsed: 'whisper-large-v3-turbo',
    durationMs: processingDurationMs,
    success: true,
  }).catch(() => {})

  await trackUsage({
    user: mockUser,
    type: 'api_call_multimodal_fusion',
    sessionId,
    inputTokens: data.fusionInputTokens,
    outputTokens: data.fusionOutputTokens,
    modelUsed: 'claude-haiku-4-5-20251001',
    durationMs: processingDurationMs,
    success: true,
  }).catch(() => {})

  aiLogger.info(
    { sessionId, processingDurationMs, totalCostUsd, timelineEvents: data.timeline.length },
    'Multimodal analysis pipeline completed'
  )
}

/** Mark pipeline as failed */
export async function stepMarkFailed(
  sessionId: string,
  error: string,
  startTime: number
): Promise<void> {
  await connectDB()
  await MultimodalAnalysis.findOneAndUpdate(
    { sessionId },
    { status: 'failed', error, processingDurationMs: Date.now() - startTime }
  )
}

// ─── Full pipeline (convenience for testing or direct invocation) ───────────

/**
 * Run the full multimodal analysis pipeline for a completed interview.
 * For Inngest, use the individual step functions instead.
 */
export async function runMultimodalPipeline(
  sessionId: string,
  userId: string
): Promise<void> {
  const startTime = Date.now()

  try {
    const session = await stepFetchSession(sessionId)
    const { whisper, facialFrames } = await stepTranscribeAndDownload(
      session.recordingR2Key,
      session.facialLandmarksR2Key
    )
    const signals = stepProcessSignals(
      whisper.segments,
      facialFrames,
      session.questionBoundaries,
      whisper.durationSeconds
    )
    const fusionResult = await stepRunFusion(
      signals.prosodySegments,
      signals.facialSegments,
      session.evaluations,
      session.transcript as unknown as Array<Record<string, unknown>>,
      session.config
    )
    await stepPersistResults(sessionId, userId, {
      whisperSegments: whisper.segments,
      prosodySegments: signals.prosodySegments,
      facialSegments: signals.facialSegments,
      timeline: fusionResult.timeline as unknown as Array<Record<string, unknown>>,
      fusionSummary: fusionResult.fusionSummary as unknown as Record<string, unknown>,
      facialLandmarksR2Key: session.facialLandmarksR2Key,
      whisperCostUsd: whisper.costUsd,
      fusionInputTokens: fusionResult.inputTokens,
      fusionOutputTokens: fusionResult.outputTokens,
      startTime,
    })
  } catch (err) {
    const errorMessage = err instanceof Error ? err.message : 'Unknown error'
    aiLogger.error({ err, sessionId }, 'Multimodal analysis pipeline failed')
    await stepMarkFailed(sessionId, errorMessage, startTime)
    throw err
  }
}

async function downloadFacialFrames(r2Key?: string): Promise<FacialFrame[]> {
  if (!r2Key) return []

  try {
    const url = await getDownloadPresignedUrl(r2Key, 300)
    const response = await fetch(url)
    if (!response.ok) return []
    return (await response.json()) as FacialFrame[]
  } catch (err) {
    aiLogger.warn({ err, r2Key }, 'Failed to download facial frames — continuing without')
    return []
  }
}
