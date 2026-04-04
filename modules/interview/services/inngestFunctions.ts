import { inngest } from './inngestClient'
import {
  stepFetchSession,
  stepTranscribeAndDownload,
  stepProcessSignals,
  stepRunFusion,
  stepPersistResults,
  stepMarkFailed,
} from './multimodalPipeline'
import { connectDB } from '@shared/db/connection'
import { FailedJob } from '@shared/db/models/FailedJob'
import { MultimodalAnalysis } from '@shared/db/models/MultimodalAnalysis'

/**
 * Inngest function: Multimodal Interview Analysis
 *
 * Triggered by 'interview/analysis.requested' event.
 * Each step runs independently with its own timeout and retry,
 * so a failure in (e.g.) fusion doesn't re-run transcription.
 */
export const multimodalAnalysis = inngest.createFunction(
  {
    id: 'multimodal-analysis',
    retries: 2,
    concurrency: [{ limit: 5 }],
    triggers: [{ event: 'interview/analysis.requested' }],
  },
  async ({ event, step }) => {
    const { sessionId, userId } = event.data as { sessionId: string; userId: string }
    const startTime = Date.now()

    try {
      // Step 1: Fetch and validate session data
      const session = await step.run('fetch-session', () =>
        stepFetchSession(sessionId)
      )

      // Step 2: Transcribe recording + download facial data (parallel within step)
      const mediaData = await step.run('transcribe-and-download', () =>
        stepTranscribeAndDownload(session.recordingR2Key, session.facialLandmarksR2Key)
      )

      // Step 3: Extract prosody + aggregate facial signals
      const signals = await step.run('process-signals', () =>
        stepProcessSignals(
          mediaData.whisper.segments,
          mediaData.facialFrames,
          session.questionBoundaries,
          mediaData.whisper.durationSeconds
        )
      )

      // Step 4: Run Claude fusion analysis
      const fusionResult = await step.run('run-fusion', () =>
        stepRunFusion(
          signals.prosodySegments,
          signals.facialSegments,
          session.evaluations,
          session.transcript as unknown as Array<Record<string, unknown>>,
          session.config
        )
      )

      // Step 5: Persist results and track usage
      await step.run('persist-results', () =>
        stepPersistResults(sessionId, userId, {
          whisperSegments: mediaData.whisper.segments,
          prosodySegments: signals.prosodySegments,
          facialSegments: signals.facialSegments,
          timeline: fusionResult.timeline as unknown as Array<Record<string, unknown>>,
          fusionSummary: fusionResult.fusionSummary as unknown as Record<string, unknown>,
          facialLandmarksR2Key: session.facialLandmarksR2Key,
          whisperCostUsd: mediaData.whisper.costUsd,
          fusionInputTokens: fusionResult.inputTokens,
          fusionOutputTokens: fusionResult.outputTokens,
          startTime,
        })
      )

      // Step 6: Generate coach notes (non-blocking — failure doesn't fail the pipeline)
      await step.run('generate-coach-notes', async () => {
        try {
          const { generateCoachNotes } = await import('./coachNotesService')
          const fusionSummary = fusionResult.fusionSummary as Record<string, unknown> | undefined
          const notes = await generateCoachNotes({
            transcript: session.transcript as Array<{ speaker: string; text: string; timestamp: number; questionIndex?: number | null }>,
            evaluations: session.evaluations,
            improvementMoments: (fusionSummary?.improvementMoments || []) as Array<{ startSec: number; endSec: number; title: string; description: string; questionIndex?: number }>,
          })
          if (notes.length > 0) {
            await connectDB()
            await MultimodalAnalysis.findOneAndUpdate(
              { sessionId },
              { coachNotes: notes }
            )
          }
        } catch (err) {
          // Coach notes are non-critical — log but don't fail
          console.warn('Coach notes generation failed:', err)
        }
      })

      return { sessionId, status: 'completed' }
    } catch (err) {
      const errorMessage = err instanceof Error ? err.message : 'Unknown error'
      const errorStack = err instanceof Error ? err.stack : undefined

      await step.run('mark-failed', async () => {
        await stepMarkFailed(sessionId, errorMessage, startTime)

        // Persist structured failure record for observability
        await connectDB()
        await FailedJob.create({
          jobId: event.id || `multimodal-${sessionId}`,
          functionId: 'multimodal-analysis',
          eventName: 'interview/analysis.requested',
          sessionId,
          userId,
          error: errorMessage,
          stack: errorStack,
          attemptNumber: (event.data as Record<string, unknown>).attempt_number as number || 1,
          payload: { sessionId, userId },
        }).catch(() => {}) // non-critical
      })

      throw err
    }
  }
)
