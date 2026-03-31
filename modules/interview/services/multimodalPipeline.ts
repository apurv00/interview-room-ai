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

/**
 * Run the full multimodal analysis pipeline for a completed interview.
 * Called by Inngest in steps, or directly for testing.
 */
export async function runMultimodalPipeline(
  sessionId: string,
  userId: string
): Promise<void> {
  const startTime = Date.now()

  await connectDB()

  // Update status to processing
  await MultimodalAnalysis.findOneAndUpdate(
    { sessionId },
    { status: 'processing' }
  )

  try {
    // 1. Fetch session data
    const session = await InterviewSession.findById(sessionId)
    if (!session) throw new Error(`Session ${sessionId} not found`)
    if (!session.recordingR2Key) throw new Error('Session has no recording')

    const { transcript, evaluations, config } = session

    // Build question boundaries from transcript (interviewer entries)
    const questionBoundaries = (transcript || [])
      .filter((t) => t.speaker === 'interviewer')
      .map((t) => t.timestamp)

    // 2. Run Whisper + Download facial data in parallel
    const [whisperResult, facialFrames] = await Promise.all([
      transcribeRecording(session.recordingR2Key),
      downloadFacialFrames(session.facialLandmarksR2Key),
    ])

    const totalDurationSec = whisperResult.durationSeconds

    // 3. Extract prosody features
    const prosodySegments = extractProsody(
      whisperResult.segments,
      questionBoundaries,
      totalDurationSec
    )

    // 4. Aggregate facial data
    const facialSegments = aggregateFacialData(
      facialFrames,
      questionBoundaries,
      totalDurationSec
    )

    // 5. Run fusion analysis (Claude)
    const fusionResult = await runFusionAnalysis({
      prosodySegments,
      facialSegments,
      evaluations: evaluations || [],
      transcript: transcript || [],
      config,
    })

    // 6. Calculate costs (Haiku pricing: $0.001 input, $0.005 output per 1K tokens)
    const claudeCostUsd = parseFloat(
      ((fusionResult.inputTokens / 1000) * 0.001 + (fusionResult.outputTokens / 1000) * 0.005).toFixed(4)
    )
    const totalCostUsd = parseFloat((whisperResult.costUsd + claudeCostUsd).toFixed(4))
    const processingDurationMs = Date.now() - startTime

    // 7. Save results
    await MultimodalAnalysis.findOneAndUpdate(
      { sessionId },
      {
        status: 'completed',
        whisperTranscript: whisperResult.segments,
        prosodySegments,
        facialSegments,
        timeline: fusionResult.timeline,
        fusionSummary: fusionResult.fusionSummary,
        facialFramesR2Key: session.facialLandmarksR2Key || undefined,
        whisperCostUsd: whisperResult.costUsd,
        claudeCostUsd,
        totalCostUsd,
        processingDurationMs,
        completedAt: new Date(),
      }
    )

    // 8. Track usage
    const mockUser: AuthUser = { id: userId, email: '', role: 'candidate', plan: 'free' }
    await trackUsage({
      user: mockUser,
      type: 'api_call_whisper',
      sessionId,
      inputTokens: Math.round(totalDurationSec), // duration as proxy for tokens
      outputTokens: 0,
      modelUsed: 'whisper-large-v3-turbo',
      durationMs: processingDurationMs,
      success: true,
    }).catch(() => {}) // non-critical

    await trackUsage({
      user: mockUser,
      type: 'api_call_multimodal_fusion',
      sessionId,
      inputTokens: fusionResult.inputTokens,
      outputTokens: fusionResult.outputTokens,
      modelUsed: 'claude-haiku-4-5-20251001',
      durationMs: processingDurationMs,
      success: true,
    }).catch(() => {}) // non-critical

    aiLogger.info(
      { sessionId, processingDurationMs, totalCostUsd, timelineEvents: fusionResult.timeline.length },
      'Multimodal analysis pipeline completed'
    )
  } catch (err) {
    const errorMessage = err instanceof Error ? err.message : 'Unknown error'
    aiLogger.error({ err, sessionId }, 'Multimodal analysis pipeline failed')

    await MultimodalAnalysis.findOneAndUpdate(
      { sessionId },
      { status: 'failed', error: errorMessage, processingDurationMs: Date.now() - startTime }
    )

    throw err // Re-throw for Inngest retry handling
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
